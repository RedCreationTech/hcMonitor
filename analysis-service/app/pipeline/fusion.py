"""E1 融合 + E2 判定升级：决策级时间窗聚合（与原型判定口径同构）。

- 各模态事件先进各自通道；45s 滑窗内统计命中（封顶条目不计入升级，只并列展示）
- 主信号（voice/semantic/face/pose/hand）≥1 且命中模态数 ≥2 → 该窗产 ESCALATED 综合事件
- 未命中模态在结论里显式列 ✕：「没测」不得被读成「正常」
"""
from __future__ import annotations

from .events import RawEvent
from ..config import FUSION_WINDOW_S

MAIN_MODALITIES = ["voice", "semantic", "face", "pose", "hand"]
ALL_MODALITIES = MAIN_MODALITIES + ["physio"]


def _consolidate(events: list[RawEvent], gap_s: float = 60.0) -> list[RawEvent]:
    """同型低频事件合并：同 (modality,type) 且相邻间隔 < gap 的 INFO/WARN 并为一条
    （保留首个时间戳、并集证据窗、最大偏离，条数计入 metrics）。
    ALERT/ESCALATED 逐条保留——升级相关的一条不吞。"""
    out: list[RawEvent] = []
    groups: dict[tuple, list[RawEvent]] = {}
    for e in events:
        if e.severity in ("INFO", "WARN"):
            groups.setdefault((e.modality, e.type, e.asset_id, e.cap_note, e.participant_id, e.segment_id), []).append(e)
        else:
            out.append(e)
    for (mod, typ, _asset, _cap, _person, _segment), xs in groups.items():
        xs.sort(key=lambda e: e.ts)
        cur = None
        for e in xs:
            if cur and e.ts - cur.window[1] < gap_s:
                cur.window = (cur.window[0], max(cur.window[1], e.window[1]))
                cur.member_ids = sorted(set(cur.member_ids + e.member_ids))
                cur.confidence = max(cur.confidence, e.confidence)
                cur.deviation = max(cur.deviation, e.deviation)
                cur.metrics["合并条数"] = (cur.metrics.get("合并条数", (1, ""))[0] + 1, "条")
            else:
                if cur:
                    out.append(cur)
                cur = RawEvent(ts=e.ts, modality=mod, type=typ, severity=e.severity,
                               confidence=e.confidence, deviation=e.deviation,
                               window=e.window, metrics=dict(e.metrics),
                               asset_id=e.asset_id, asset_ids=list(e.asset_ids), participant_id=e.participant_id, member_ids=list(e.member_ids), cap_note=e.cap_note, segment_id=e.segment_id)
        if cur:
            out.append(cur)
    return sorted(out, key=lambda e: e.ts)


def fuse(events: list[RawEvent], session_id: str,
         window_s: int = FUSION_WINDOW_S) -> list[RawEvent]:
    """跨模态同窗聚合升级。封顶（cap_note 非空）事件不参与升级，保持原级。

    流程：同型低频合并降噪 → 45s 窗聚合升级。原事件全部保留（可逐条追溯），
    另产 ESCALATED 综合事件，metrics 列出成员——「聚合」是新增结论，不吞细节。
    """
    segments={e.segment_id for e in events}
    if len(segments)>1:
        return sorted([e for part in segments for e in fuse([x for x in events if x.segment_id==part],session_id,window_s)],key=lambda e:e.ts)
    events = _consolidate(events)
    capped = [e for e in events if e.cap_note]
    fuseable = sorted((e for e in events if not e.cap_note), key=lambda e: e.ts)

    escalated: list[RawEvent] = []
    if fuseable:
        t0, t1 = fuseable[0].ts, fuseable[-1].ts
        start = t0
        while start <= t1:
            end = start + window_s
            in_win = [e for e in fuseable if start <= e.ts < end]
            # 成员资格：窗内既有主信号也有其他模态，且窗内主信号 ≥1
            mods = {e.modality for e in in_win}
            has_main = any(m in MAIN_MODALITIES for m in mods)
            if len(in_win) >= 2 and len(mods) >= 2 and has_main:
                missed = [m for m in ALL_MODALITIES if m not in mods]
                escalated.append(RawEvent(
                    ts=min(e.ts for e in in_win), modality="semantic", type="跨模态同窗聚合升级",
                    severity="ESCALATED",
                    confidence=round(min(0.95, max(e.confidence for e in in_win) + 0.1), 2),
                    deviation=max(e.deviation for e in in_win),
                    window=(min(e.window[0] for e in in_win), max(e.window[1] for e in in_win)) if in_win[0].segment_id else (start, end),
                    segment_id=in_win[0].segment_id,
                    member_ids=sorted({member for e in in_win for member in e.member_ids}),
                    asset_ids=sorted({aid for e in in_win for aid in (e.asset_ids or [e.asset_id]) if aid}),
                    metrics={"命中模态": ("+".join(sorted(mods)), "模态"),
                             "未命中": ("+".join(missed) if missed else "无", "模态"),
                             "聚合条数": (len(in_win), "条"),
                             "成员": ("；".join(f"{e.type}@{int(e.ts)}s" for e in in_win), "")},
                ))
            start = end
    return sorted(fuseable + escalated + capped, key=lambda e: e.ts)


def to_contract_event(ev: RawEvent, seq: int, session_id: str,
                      source_assets: list[dict] | None = None) -> dict:
    """RawEvent → 契约 AnomalyEvent 字典（attribution 由 attribution 层补全）。"""
    from ..config import MODALITY_LABEL
    metrics_txt = "；".join(f"{k} {v[0]}{v[1]}" for k, v in ev.metrics.items())
    obs_text = f"{MODALITY_LABEL.get(ev.modality, ev.modality)}通道：{ev.type}"
    if metrics_txt:
        obs_text += f"（{metrics_txt}）"
    return {
        "event": "anomaly",
        "id": f"EV-{seq:03d}",
        "session_id": session_id,
        "ts": round(float(ev.ts), 1),
        "modality": ev.modality,
        "type": ev.type,
        "severity": ev.severity,
        "confidence": round(float(ev.confidence), 2),
        "lamp": {"INFO": "green", "WARN": "orange", "ALERT": "orange", "ESCALATED": "red"}[ev.severity],
        "advice": ("呼叫后方·建议人工介入核实" if ev.severity == "ESCALATED"
                   else "放慢语速复述问题" if ev.severity in ("WARN", "ALERT") else ""),
        "attribution": {
            "observation": [{
                "modality": ev.modality,
                "text": obs_text,
                "ts_from": round(float(ev.window[0]), 1),
                "ts_to": round(float(ev.window[1]), 1),
            }],
            "candidate_rules": [],
            "conclusion": {},
        },
        "source_assets": source_assets or [],
        "source_event_ids": ev.member_ids,
        "cap_note": ev.cap_note,
    }
