"""批分析作业编排：逐素材真实跑检测链 → 融合 → 归因 → 自动起草报告。

进度口径与前端约定：每素材分阶段步骤（video 6 / audio 5 / ext 4）+ 末尾 1 步会话级融合，
offline_job.progress = 已完成步骤/总步骤。步骤列表在起批时一次性下发（含未完成的），
前端据 progress 推导完成态。
"""
from __future__ import annotations

import json
import threading
import time
import traceback
from pathlib import Path

from .config import (ARTIFACTS, PIPELINE_VERSION, UPLOADS, DISCLAIMER,
                     MODALITY_LABEL)
from .contracts import OfflineResult
from .pipeline import preprocess, fusion, attribution
from .pipeline.events import RawEvent
from .seed import now_str

STEPS_VIDEO = ["解封装与时长校验", "人脸跟踪与 AU 提取", "姿态与手部关键点",
               "rPPG 生理趋势", "语音通道转写 + 分角色", "声学特征与言语异常"]
STEPS_AUDIO = ["VAD 分段", "ASR 转写", "说话人分离与轮次对齐", "标点与话题候选", "声学特征与言语异常"]
STEPS_EXT = ["采样序列解析", "重采样与质量门", "趋势提取", "封顶事件判定"]
AUDIO_MODALITIES = ["voice", "semantic"]
VIDEO_MODALITIES = ["voice", "semantic", "face", "pose", "hand", "physio"]

_jobs: set[str] = set()
_lock = threading.Lock()


def is_running(sid: str) -> bool:
    with _lock:
        return sid in _jobs


def start(store, sid: str, broadcast) -> bool:
    """入队作业（broadcast: asyncio 循环安全的广播闭包）。"""
    with _lock:
        if sid in _jobs:
            return False
        _jobs.add(sid)
    threading.Thread(target=_run, args=(store, sid, broadcast), daemon=True).start()
    return True


def _build_steps(assets: list[dict]) -> list[dict]:
    steps = []
    for a in assets:
        names = (STEPS_VIDEO if a["kind"] == "video"
                 else STEPS_AUDIO if a["kind"] == "audio" else STEPS_EXT)
        for i, s in enumerate(names):
            steps.append({"progress": 0, "stage": f"#{i + 1} {s}",
                          "asset": a["name"], "asset_kind": a["kind"]})
    steps.append({"progress": 0, "stage": "会话级融合与归因", "asset": None, "asset_kind": None})
    return steps


def _commit_progress(session, steps, done_idx, broadcast):
    total = len(steps)
    for i, st in enumerate(steps):
        st["progress"] = 100 if i < done_idx else 0
    session["offline_job"] = {"progress": round(done_idx / total * 100),
                              "stage": steps[min(done_idx, total - 1)]["stage"],
                              "steps": steps}
    broadcast()


def _run(store, sid: str, broadcast):
    art_dir = ARTIFACTS / sid
    art_dir.mkdir(parents=True, exist_ok=True)
    session = store.get_session(sid)
    done = 0
    try:
        assets = session.get("assets") or []
        steps = _build_steps(assets)
        session["offline_job"] = {"progress": 0, "stage": "起批", "steps": steps}
        store.upsert_session(session)
        store.audit("系统", "analyze.start", sid)
        broadcast()

        all_events: list[RawEvent] = []
        turns, impacts = [], []
        slices = []
        audio_done = False
        session_mods: list[str] = []
        primary_kind = None
        duration = 0

        for a in assets:
            kind = a["kind"]
            path = UPLOADS / sid / a["name"]
            a_dir = art_dir / a["id"].replace(":", "_")
            step_base = done
            try:
                if kind in ("video", "audio"):
                    wav = preprocess.audio_to_wav(path)
                    from .pipeline import speech, acoustic, semantic
                    if not audio_done:
                        r = speech.run(wav, a_dir)
                        turns = r["turns"]
                        r2 = acoustic.run(wav, turns, a_dir)
                        r3 = semantic.run(turns, a_dir)
                        impacts = r3["impacts"]
                        for ev in r2["anomalies"] + r3["anomalies"]:
                            ev.asset_id = a["id"]
                        all_events += r2["anomalies"] + r3["anomalies"]
                        audio_done = True
                    else:
                        # 额外主信号素材：同样跑自己的链，产物归入本切片
                        r = speech.run(wav, a_dir)
                        r2 = acoustic.run(wav, r["turns"], a_dir)
                        for ev in r2["anomalies"]:
                            ev.asset_id = a["id"]
                        all_events += r2["anomalies"]
                    n_steps = len(STEPS_VIDEO if kind == "video" else STEPS_AUDIO)
                    if kind == "video":
                        from .pipeline import vision, rppg
                        rv = vision.run(path, a_dir)
                        rr = rppg.run(path, a_dir)
                        for ev in rv["anomalies"] + rr["anomalies"]:
                            ev.asset_id = a["id"]
                        all_events += rv["anomalies"] + rr["anomalies"]
                        quality = "degraded" if rv["quality"] == "degraded" or rr["quality"] == "degraded" else "ok"
                        qnote = "; ".join(x for x in [rv.get("quality_note", ""), rr.get("quality_note", "")] if x) or "质量达标"
                        mods = VIDEO_MODALITIES
                        primary_kind = primary_kind or "video"
                        suppressed = []
                    else:
                        quality, qnote = "ok", "质量达标"
                        mods = AUDIO_MODALITIES
                        primary_kind = primary_kind or "audio"
                        suppressed = [{"id": f"X-{a['id']}-face", "reason": "音频无画面帧：表情/姿态/手部/视频生理(rPPG) 不可用，不产出 0 值"},
                                      {"id": f"X-{a['id']}-pose", "reason": "音频素材不含姿态通道"},
                                      {"id": f"X-{a['id']}-hand", "reason": "音频素材不含手部通道"},
                                      {"id": f"X-{a['id']}-physio", "reason": "音频素材不含视频生理通道"}]
                    duration = max(duration, a.get("duration_seconds") or 0)
                    slice_rec = {"asset_id": a["id"], "asset_name": a["name"], "kind": kind,
                                 "role": "primary", "size_bytes": a["size_bytes"],
                                 "duration_seconds": a.get("duration_seconds") or 0,
                                 "modality_available": mods,
                                 "modality_unavailable": [m for m in VIDEO_MODALITIES if m not in mods],
                                 "steps": [s["stage"] for s in steps[step_base:step_base + n_steps]],
                                 "event_ids": [], "suppressed": suppressed,
                                 "trend": None, "cap_note": None,
                                 "quality": quality, "quality_note": qnote}
                    slices.append(slice_rec)
                    session_mods = sorted(set(session_mods) | set(mods))
                else:  # mmwave / nir
                    mod = __import__("app.pipeline.ext_mmwave", fromlist=["run"]) if kind == "mmwave" \
                        else __import__("app.pipeline.ext_nir", fromlist=["run"])
                    r = mod.run(path, a_dir, a["id"])
                    all_events += r["anomalies"]
                    duration = max(duration, r["duration_seconds"])
                    from .config import CAP_NOTE
                    slices.append({"asset_id": a["id"], "asset_name": a["name"], "kind": kind,
                                   "role": "extension", "size_bytes": a["size_bytes"],
                                   "duration_seconds": r["duration_seconds"],
                                   "modality_available": ["physio"],
                                   "modality_unavailable": AUDIO_MODALITIES + ["face", "pose", "hand"],
                                   "steps": [s["stage"] for s in steps[step_base:step_base + len(STEPS_EXT)]],
                                   "event_ids": [], "suppressed": [],
                                   "trend": r["trend"], "cap_note": CAP_NOTE,
                                   "quality": r.get("quality", "ok"),
                                   "quality_note": "体动/头动超阈值区段已降级" if r.get("quality") == "degraded" else "质量达标"})
                    session_mods = sorted(set(session_mods) | {"physio"}) if "physio" in session_mods else session_mods
            except Exception as e:
                traceback.print_exc()
                slices.append({"asset_id": a["id"], "asset_name": a["name"], "kind": kind,
                               "role": "extension" if kind in ("nir", "mmwave") else "primary",
                               "size_bytes": a.get("size_bytes", 0), "duration_seconds": 0,
                               "modality_available": [], "modality_unavailable": VIDEO_MODALITIES,
                               "steps": [], "event_ids": [], "suppressed": [],
                               "trend": None, "cap_note": None, "quality": "degraded",
                               "quality_note": f"解析失败：{e}"})
                store.audit("引擎", "asset.error", f"{sid}/{a['name']}")
            done += len(STEPS_VIDEO if kind == "video" else STEPS_AUDIO if kind in ("video", "audio") else STEPS_EXT) if kind in ("video", "audio") else len(STEPS_EXT)
            session = store.get_session(sid)
            _commit_progress(session, steps, done, broadcast)

        # ── 会话级融合与归因 ─────────────────────────────────────
        fused = fusion.fuse(all_events, sid)
        rules = attribution.load_rules()
        anomalies, suppressed_all = [], []
        for sl in slices:
            sl["suppressed"] and suppressed_all.extend(sl["suppressed"])
        for i, ev in enumerate(sorted(fused, key=lambda e: e.ts), 1):
            src = []
            if ev.asset_id:
                a = next((x for x in assets if x["id"] == ev.asset_id), None)
                if a:
                    src = [{"id": a["id"], "name": a["name"], "kind": a["kind"]}]
            d = fusion.to_contract_event(ev, i, sid, src)
            if getattr(ev, "matched", None):
                d["_matched_rule_ids"] = ev.matched
            d = attribution.fill_attribution(d, rules)
            if d.get("_narrative"):
                d["attribution"]["conclusion"]["narrative"] = d["_narrative"]
            anomalies.append(d)
            store.audit("引擎 E2", "anomaly.detect", f"{sid}/{d['id']}")
            for s in slices:
                if ev.asset_id and s["asset_id"] == ev.asset_id:
                    s["event_ids"].append(d["id"])
        done = len(steps) - 0
        session = store.get_session(sid)
        _commit_progress(session, steps, len(steps), broadcast)

        peak = "red" if any(x["severity"] == "ESCALATED" for x in anomalies) else \
               "orange" if any(x["severity"] in ("ALERT",) for x in anomalies) else \
               "green" if anomalies else "green"
        report_id = f"RP-{sid[4:].replace('-', '')}-{len(store.reports()) + 1:02d}"
        result = OfflineResult(
            finished_at=now_str(), asset_kind=primary_kind or "audio",
            assets=[{**a} for a in assets], slices=slices,
            modality_available=session_mods or AUDIO_MODALITIES,
            duration_seconds=duration or (turns[-1]["ts"] if turns else 0),
            turns=turns, anomalies=anomalies, impacts=impacts,
            suppressed=suppressed_all, report_id=report_id,
            pipeline=f"{PIPELINE_VERSION}（真实算法链）",
        ).model_dump()
        session["offline"] = result
        session["offline_job"] = None
        session["peak_lamp"] = peak
        session["anomaly_count"] = len(anomalies)
        session["duration_seconds"] = result["duration_seconds"]

        # 自动起草报告（含 R2 固定免责章节）
        report = _draft_report(store, session, result, report_id)
        store.upsert_report(report)
        store.upsert_session(session)
        store.audit("系统", "report.auto_draft", report_id)
        broadcast()
    except Exception:
        traceback.print_exc()
        session = store.get_session(sid)
        session["offline_job"] = None
        store.upsert_session(session)
        store.audit("系统", "analyze.failed", sid)
        broadcast()
    finally:
        with _lock:
            _jobs.discard(sid)


def _draft_report(store, session, result, report_id):
    assets = result["assets"]
    sev = {}
    for a in result["anomalies"]:
        sev[a["severity"]] = sev.get(a["severity"], 0) + 1
    sec = [
        {"key": "overview", "title": "一、素材与分析概况",
         "text": (f"登记素材 {len(assets)} 份（{'、'.join(f['name'] for f in assets)}），"
                  f"会话时长按最长素材取 {result['duration_seconds']}s；进入真实判定链的模态 "
                  f"{len(result['modality_available'])}/6（{'·'.join(MODALITY_LABEL[m] for m in result['modality_available'])}）。"
                  f"判定口径 {result['pipeline']}；完成于 {result['finished_at']}。")},
        {"key": "slices", "title": "二、素材切片与各自贡献",
         "text": "；".join(f"{s['asset_name']}：可解析模态 {'·'.join(MODALITY_LABEL[m] for m in s['modality_available']) or '无'}，"
                          f"结论{'封顶趋势层' if s['cap_note'] else '进完整判定链'}（质量：{'达标' if s['quality'] == 'ok' else '降级'}）"
                          for s in result["slices"])},
        {"key": "anomaly", "title": "三、异常行为事件",
         "text": (f"共上报 {len(result['anomalies'])} 条：" +
                  "，".join(f"{k} {v} 条" for k, v in sev.items()) +
                  f"；裁撤 {len(result['suppressed'])} 条（{'；'.join(s['reason'] for s in result['suppressed']) or '无'}）。"
                  "每条事件可在系统中展开 L1 观察 → L2 候选规则 → L3 结论三级链条。")},
        {"key": "impact", "title": "四、话题影响值",
         "text": (f"切分 {len(result['impacts'])} 个语义边界，最高影响值 "
                  f"{max((i['impact_score'] for i in result['impacts']), default=0):.2f}；"
                  "影响值=话题时长占比×情感翻转×矛盾密度（归一 [0,1]，仅本会话内排序）。")},
        {"key": "limit", "title": "五、局限与免责",
         "text": (f"{DISCLAIMER} 近红外/毫米波为文件级导入，结论封顶生理趋势层；"
                  "言语与视觉异常基于个体基线偏离（前段标定）与规则命中，需人工复核后使用。")},
    ]
    return {"id": report_id, "session_id": session["id"],
            "subject_code": session["subject_code"],
            "title": f"{session['scene']}行为异常与心理变化分析报告",
            "status": "drafting", "sections": sec, "precision_note": None,
            "origin": "imported", "asset": assets[0] if assets else None,
            "assets": assets, "reviewer": None,
            "revisions": [{"ts": now_str(), "actor": "系统",
                           "action": "create", "note": "离线批分析完成后自动起草（口径：离线导入 · 非实时）"}],
            "published_at": None}
