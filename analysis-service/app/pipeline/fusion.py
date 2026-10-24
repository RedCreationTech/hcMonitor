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


def fuse(events: list[RawEvent], session_id: str,
         window_s: int = FUSION_WINDOW_S) -> list[RawEvent]:
    """跨模态同窗聚合升级。封顶（cap_note 非空）事件不升级，保持原级。"""
    capped = [e for e in events if e.cap_note]
    fuseable = sorted((e for e in events if not e.cap_note), key=lambda e: e.ts)

    escalated: list[RawEvent] = []
    consumed: set[int] = set()
    if fuseable:
        t0, t1 = fuseable[0].ts, fuseable[-1].ts
        w = window_s
        start = t0
        while start <= t1:
            end = start + w
            in_win = [e for i, e in enumerate(fuseable)
                      if start <= e.ts < end and id(e) not in consumed]
            mods = {e.modality for e in in_win}
            has_main = any(m in MAIN_MODALITIES for m in mods)
            if len(mods) >= 2 and has_main and len(in_win) >= 2:
                missed = [m for m in ALL_MODALITIES if m not in mods]
                ts = min(e.ts for e in in_win)
                ev = RawEvent(
                    ts=ts, modality="semantic", type="跨模态同窗聚合升级",
                    severity="ESCALATED",
                    confidence=round(min(0.95, max(e.confidence for e in in_win) + 0.1), 2),
                    deviation=max(e.deviation for e in in_win),
                    window=(start, end),
                    metrics={"命中模态": ("+".join(sorted(mods)), "模态"),
                             "未命中": ("+".join(missed) if missed else "无", "模态"),
                             "聚合条数": (len(in_win), "条")},
                )
                ev.matched = [f"R-Fusion-CrossModal"]           # 规则命中标记
                ev.members = in_win                              # 成员事件（归因层展开）
                escalated.append(ev)
                for e in in_win:
                    consumed.add(id(e))
            start = end
    # 未被聚合提升的事件保持原样，封顶事件原样保留
    rest = [e for e in fuseable if id(e) not in consumed]
    out = rest + escalated + capped
    return sorted(out, key=lambda e: e.ts)


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
        "cap_note": ev.cap_note,
    }
