"""归因层：规则命中 → L2 候选规则层 → L3 结论（确定性），LLM 仅做叙述组装。

红线：数值与判定全部由代码计算；LLM 不得生成数值。
LLM 四件套控幻觉：RAG 白名单（只喂命中规则全文）→ JSON Mode 结构化输出
→ citation 回溯校验（引用必须落在喂入的规则 id 内）→ temperature=0。
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

import yaml

from ..config import MODELS, DISCLAIMER

RULES_PATH = Path(__file__).resolve().parent.parent / "rules" / "rules.yaml"

# 事件类型关键词 → 规则 id 的显式映射（确定性命中，不靠 LLM 猜）
TYPE_RULE_MAP = {
    "语速": "R-Voice-RateUp", "音调": "R-Voice-RateUp",
    "停顿": "R-Voice-Pause", "静默": "R-Voice-Pause",
    "jitter": "R-Voice-Jitter", "shimmer": "R-Voice-Jitter", "嗓音": "R-Voice-Jitter",
    "矛盾": "R-Semantic-Contradict", "NLI": "R-Semantic-Contradict", "不一致": "R-Semantic-Contradict",
    "AU4": "R-Face-AU47", "皱眉": "R-Face-AU47", "闪现": "R-Face-AU47", "微表情": "R-Face-AU47",
    "后仰": "R-Pose-Withdraw", "回避": "R-Pose-Withdraw", "朝向": "R-Pose-Withdraw",
    "搓手": "R-Hand-SelfTouch", "自触": "R-Hand-SelfTouch", "安抚": "R-Hand-SelfTouch", "摸脸": "R-Hand-SelfTouch",
    "HRV": "R-Physio-HRV", "应激未回落": "R-Physio-HRV", "rPPG": "R-Physio-HRV",
    "跨模态": "R-Fusion-CrossModal", "聚合": "R-Fusion-CrossModal",
}


def load_rules() -> list[dict]:
    return yaml.safe_load(RULES_PATH.read_text("utf-8"))


def match_rule_ids(ev_type: str, modality: str, preset: list[str] | None) -> list[str]:
    if preset:
        return preset
    hits = [rid for kw, rid in TYPE_RULE_MAP.items() if kw in ev_type]
    return hits or []


def fill_attribution(event: dict, rules: list[dict]) -> dict:
    """按事件类型补 L2 候选层（同模态全量列出，hit 标记），组装 L3 结论。"""
    if event.get("cap_note"):
        event["attribution"]["candidate_rules"] = []
        event["attribution"]["conclusion"] = {"psych_state": "仅生理趋势，不作心理归因",
            "confidence": event["confidence"], "counterfactual": event["cap_note"], "disclaimer": DISCLAIMER}
        return event
    modality = event["modality"]
    matched = match_rule_ids(event["type"], modality,
                             event.pop("_matched_rule_ids", None))
    candidates = [r for r in rules if r["modality"] == modality]
    hit_rules = []
    for r in candidates:
        rid = r["rule_id"]
        hit = rid in matched
        if hit:
            hit_rules.append(r)
        event["attribution"]["candidate_rules"].append({
            "rule_id": rid, "pattern": r["pattern"],
            "psych_state": r["psych_state"], "literature_ref": r["literature_ref"],
            "weight": r["weight"], "hit": hit,
        })
    if hit_rules:
        top = max(hit_rules, key=lambda r: r["weight"])
        conf = round(min(0.95, event["confidence"] * 0.6 + top["weight"] * 0.5), 2)
        event["attribution"]["conclusion"] = {
            "psych_state": top["psych_state"],
            "confidence": conf,
            "counterfactual": top["counterfactual"],
            "disclaimer": DISCLAIMER,
        }
    else:
        event["attribution"]["conclusion"] = {
            "psych_state": "未命中归因规则（仅观察层上报）",
            "confidence": round(event["confidence"], 2),
            "counterfactual": "无候选规则命中，需人工研判。",
            "disclaimer": DISCLAIMER,
        }
    return event


# Narrative generation is isolated in app.narrative; deterministic attribution stays here.
