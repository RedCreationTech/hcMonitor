"""FastAPI 服务：实现与 mock 插件完全相同的 /v1/* 契约。

前端 vite 把 /v1 代理到本服务（--port 5190）。WS 以 state 事件推送全量快照，
前端 useStream 只认这一个入口。
"""
from __future__ import annotations

import asyncio
import datetime
import hashlib
import html
import json
import secrets
import string
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .config import DISCLAIMER, UPLOADS
from .seed import MEMBERS, FORM_LABEL, seed_sessions, now_str
from .store import Store
from . import worker

app = FastAPI(title="MindDialogue 分析服务（真实算法链）", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

store = Store()
_clients: set[WebSocket] = set()
_loop: asyncio.AbstractEventLoop | None = None


# ── WS 广播 ──────────────────────────────────────────────────────────
def state_payload() -> dict:
    rules = [
        {"id": r["rule_id"], "pattern": r["pattern"], "psych_state": r["psych_state"],
         "literature_ref": r["literature_ref"], "weight": r["weight"],
         "threshold": r.get("threshold", 0), "enabled": True, "owner": "内置规则库",
         "updated_at": "2026-10-24", "hits": 0, "source": "内置"}
        for r in __import__("app.pipeline.attribution", fromlist=["load_rules"]).load_rules()
    ]
    return {
        "session_id": "offline", "running": False, "clock": 0, "speed": 1,
        "form": "A", "field_view_enabled": True, "consent": True,
        "lamp": "green", "advice": "", "buffer_seconds": 0, "weak_network": False,
        "modality_health": {m: "ok" for m in ["voice", "semantic", "face", "pose", "hand", "physio"]},
        "collector": {"device": "离线导入", "person": "—", "authed_until": None},
        "viewer": {"person": "分析师", "channel": "workstation"},
        "markers": [], "tickets": [], "anomalies": [], "impacts": [], "turns": [],
        "audit": store.db["audit"][-100:], "sessions": store.sessions(),
        "reports": store.reports(), "annotations": [], "rules": rules,
        "members": MEMBERS, "integrations": [],
        "admin": {"form_d_enabled": True, "field_view_enabled": True,
                  "modality_whitelist_d": ["voice", "semantic"], "retention_days": 90,
                  "auto_escalate_seconds": 180, "annotation_reflow": False},
        "local_cache_bytes": 0,
    }


def broadcast():
    """线程安全广播：worker 线程经 call_soon_threadsafe 进入事件循环。"""
    if _loop is None or not _clients:
        return
    payload = {"event": "state", "ts": 0, "payload": state_payload()}
    for ws in list(_clients):
        try:
            asyncio.run_coroutine_threadsafe(ws.send_json(payload), _loop)
        except RuntimeError:
            pass


@app.websocket("/v1/analysis/stream")
async def stream(ws: WebSocket, channel: str = "workstation"):
    await ws.accept()
    _clients.add(ws)
    try:
        await ws.send_json({"event": "state", "ts": 0, "payload": state_payload()})
        while True:
            await ws.receive_text()          # 保活读取；前端不发消息
    except WebSocketDisconnect:
        pass
    finally:
        _clients.discard(ws)


@app.on_event("startup")
def _startup():
    global _loop
    _loop = asyncio.get_event_loop()
    if not store.sessions():
        for s in seed_sessions():
            store.upsert_session(s)
        store.audit("系统", "seed", "sessions")


# ── 会话 ─────────────────────────────────────────────────────────────
class CreateSession(BaseModel):
    subject_code: str
    scene: str
    form: str = "B"
    consent_doc: str
    source: str = "imported"
    assets: list[dict] = []


@app.get("/v1/sessions")
def list_sessions():
    return store.sessions()


@app.post("/v1/sessions")
def create_session(body: CreateSession, actor: str = "分析师 W-02"):
    if not body.consent_doc or not body.consent_doc.strip():
        raise HTTPException(403, "缺少告知文书号不可创建会话（R1）")
    if not body.assets:
        raise HTTPException(422, "至少登记一份素材文件")
    today = datetime.datetime.now().strftime("%Y%m%d")
    seq = sum(1 for s in store.sessions() if today in s["id"]) + 1
    sid = f"SES-{today}-{seq:03d}"
    session = {
        "id": sid, "subject_code": body.subject_code, "scene": body.scene,
        "form": body.form, "collector": actor, "analyst": actor,
        "status": "draft", "started_at": now_str(), "duration_seconds": 0,
        "peak_lamp": "green", "anomaly_count": 0, "marker_count": 0,
        "consent_doc": body.consent_doc, "modality_set": [],
        "source": "imported" if body.source != "live" else "live",
        "asset": body.assets[0], "assets": body.assets,
        "offline_job": None, "offline": None,
    }
    store.upsert_session(session)
    store.audit(actor, "session.create", sid)
    broadcast()
    return {"id": sid}


@app.post("/v1/sessions/{sid}/assets")
async def upload_asset(sid: str, file: UploadFile = File(...),
                       kind: str = Form("video"), asset_id: str = Form(...)):
    session = store.get_session(sid)
    if not session:
        raise HTTPException(404, "会话不存在")
    if session["status"] == "closed":
        raise HTTPException(409, "会话已归档只读")
    target = UPLOADS / sid
    target.mkdir(parents=True, exist_ok=True)
    dest = target / Path(file.filename).name
    data = await file.read()
    dest.write_bytes(data)
    # 服务端实测元数据，纠正客户端探测
    dur, size = _probe(dest, kind)
    for a in session["assets"]:
        if a["id"] == asset_id:
            a["size_bytes"] = size
            a["duration_seconds"] = dur
    session["asset"] = session["assets"][0]
    store.upsert_session(session)
    store.audit("系统", "asset.upload", f"{sid}/{dest.name}")
    broadcast()
    return {"ok": True, "duration_seconds": dur, "size_bytes": size}


def _probe(path: Path, kind: str) -> tuple[int, int]:
    import subprocess
    size = path.stat().st_size
    if kind in ("video", "audio"):
        try:
            out = subprocess.run(["/usr/local/bin/ffprobe", "-v", "quiet", "-show_entries",
                                  "format=duration", "-of", "csv=p=0", str(path)],
                                 capture_output=True, text=True, timeout=30)
            return round(float(out.stdout.strip())), size
        except Exception:
            return 0, size
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            lines = sum(1 for _ in f)
        return lines, size
    except Exception:
        return 0, size


@app.post("/v1/sessions/{sid}/analyze-offline")
def analyze(sid: str, actor: str = "分析师 W-02"):
    session = store.get_session(sid)
    if not session:
        raise HTTPException(404, "会话不存在")
    if session["status"] == "closed":
        raise HTTPException(409, "会话已归档只读：离线批分析须在归档前完成")
    if session.get("offline"):
        raise HTTPException(409, "本会话已有分析产物")
    if not worker.start(store, sid, broadcast):
        raise HTTPException(409, "批分析已在进行中")
    store.audit(actor, "analyze.offline", sid)
    return {"ok": True}


CSV_HEADER = "event_id,ts,modality,type,severity,confidence,outcome,psych_state_or_cap\n"


@app.post("/v1/sessions/{sid}/analyze-offline/csv")
def export_csv(sid: str, actor: str = "分析师 W-02"):
    session = store.get_session(sid)
    if not session or not session.get("offline"):
        raise HTTPException(404, "无分析产物")
    r = session["offline"]
    rows = []
    for a in r["anomalies"]:
        concl = a["attribution"]["conclusion"].get("psych_state", "")
        tail = a.get("cap_note") or concl
        rows.append(",".join(str(x) for x in [a["id"], a["ts"], a["modality"], a["type"],
                                              a["severity"], a["confidence"], "reported",
                                              f'"{tail}"']))
    for s in r["suppressed"]:
        rows.append(f'{s["id"]},,,,SUPPRESSED,,suppressed,"{s["reason"]}"')
    e = store.audit(actor, "csv.export", sid)
    text = CSV_HEADER + "\n".join(rows) + "\n"
    return {"csv": text, "filename": f"{sid}_anomalies.csv", "rows": len(rows),
            "audit_seq": e["seq"]}


# ── 报告 ─────────────────────────────────────────────────────────────
class SectionBody(BaseModel):
    key: str
    text: str


class RejectBody(BaseModel):
    note: str = ""


class ExportBody(BaseModel):
    mode: str = "file"


def _report(rid: str) -> dict:
    r = store.get_report(rid)
    if not r:
        raise HTTPException(404, "报告不存在")
    return r


@app.post("/v1/reports/{rid}/section")
def save_section(rid: str, body: SectionBody, actor: str = "分析师 W-02"):
    r = _report(rid)
    if r["status"] in ("published", "pending_review"):
        raise HTTPException(409, "当前状态不可编辑")
    for s in r["sections"]:
        if s["key"] == body.key:
            s["text"] = body.text
    r["revisions"].append({"ts": now_str(), "actor": actor, "action": "edit", "note": body.key})
    store.upsert_report(r)
    store.audit(actor, "report.section", rid)
    broadcast()
    return {"ok": True}


@app.post("/v1/reports/{rid}/submit")
def submit(rid: str, reviewer: str = "复核人 R-01", actor: str = "分析师 W-02"):
    r = _report(rid)
    limit = next((s for s in r["sections"] if s["key"] == "limit"), None)
    if not limit or not limit["text"].strip():
        raise HTTPException(422, "免责章节固定存在（R2），删除后提交会被服务端拦下")
    if r["status"] not in ("drafting", "rejected"):
        raise HTTPException(409, "当前状态不可提交")
    r["status"] = "pending_review"
    r["reviewer"] = reviewer
    r["revisions"].append({"ts": now_str(), "actor": actor, "action": "submit"})
    store.upsert_report(r)
    store.audit(actor, "report.submit", rid)
    broadcast()
    return {"ok": True}


@app.post("/v1/reports/{rid}/approve")
def approve(rid: str, actor: str = "复核人 R-01"):
    r = _report(rid)
    if r["status"] != "pending_review":
        raise HTTPException(409, "仅待复核报告可审批")
    r["status"] = "approved"
    r["revisions"].append({"ts": now_str(), "actor": actor, "action": "approve"})
    store.upsert_report(r)
    store.audit(actor, "report.approve", rid)
    broadcast()
    return {"ok": True}


@app.post("/v1/reports/{rid}/reject")
def reject(rid: str, body: RejectBody, actor: str = "复核人 R-01"):
    r = _report(rid)
    if r["status"] != "pending_review":
        raise HTTPException(409, "仅待复核报告可驳回")
    if not body.note.strip():
        raise HTTPException(422, "驳回必须填写理由")
    r["status"] = "rejected"
    r["revisions"].append({"ts": now_str(), "actor": actor, "action": "reject", "note": body.note})
    store.upsert_report(r)
    store.audit(actor, "report.reject", rid)
    broadcast()
    return {"ok": True}


@app.post("/v1/reports/{rid}/publish")
def publish(rid: str, actor: str = "复核人 R-01"):
    r = _report(rid)
    if r["status"] != "approved":
        raise HTTPException(409, "仅已通过报告可发布")
    r["status"] = "published"
    r["published_at"] = now_str()
    r["revisions"].append({"ts": now_str(), "actor": actor, "action": "publish"})
    store.upsert_report(r)
    store.audit(actor, "report.publish", rid)
    broadcast()
    return {"ok": True}


@app.post("/v1/reports/{rid}/export")
def export(rid: str, body: ExportBody, actor: str = "分析师 W-02"):
    r = _report(rid)
    watermark = None if r["status"] == "published" else "草稿 · 未经审批"
    rows = "".join(f"<h3>{html.escape(s['title'])}</h3><p>{html.escape(s['text'])}</p>"
                   for s in r["sections"])
    annex = "".join(f"<li>{html.escape(a['name'])}（{a['kind']}，{a['duration_seconds']}s，{a['size_bytes']}B）</li>"
                    for a in (r.get("assets") or []))
    h = f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>{html.escape(r['title'])}</title>
<style>body{{font-family:system-ui,'PingFang SC';max-width:760px;margin:40px auto;line-height:1.8}}
h1{{font-size:20px}}h3{{font-size:15px;margin:18px 0 6px}}p{{font-size:13px}}
.wm{{color:#c0392b;font-size:26px;transform:rotate(-24deg);position:fixed;top:45%;left:30%;opacity:.18}}
.meta{{font-size:11px;color:#888;border-top:1px solid #ddd;padding-top:8px}}</style></head>
<body>{f'<div class="wm">{watermark}</div>' if watermark else ''}
<h1>{html.escape(r['title'])}</h1>
<p class="meta">报告 {r['id']} · 会话 {r['session_id']} · {r['subject_code']} ·
口径：离线导入 · 非实时 · {DISCLAIMER}</p>{rows}
<h3>附表 A · 素材切片一览</h3><ul>{annex}</ul>
<p class="meta">{DISCLAIMER}</p></body></html>"""
    e = store.audit(actor, "report.export", rid)
    digest = hashlib.sha256(h.encode()).hexdigest()[:16]
    return {"ok": True, "html": h, "filename": f"{r['id']}.html",
            "watermark": watermark, "audit_seq": e["seq"], "hash": digest,
            "encrypted": False}


@app.get("/v1/audit/verify")
def audit_verify():
    return {"chain_ok": store.verify_chain(), "total": len(store.db["audit"])}
