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


# ── LLM 叙述组装（可选层；DISABLE_LLM=1 或模型缺失时自动跳过）────────────────

_LLM = None


def _llm():
    global _LLM
    if _LLM is None:
        from llama_cpp import Llama
        gguf = next((MODELS / "Qwen2.5-7B-Instruct-GGUF").glob("*Q4_K_M*.gguf"), None)
        if gguf is None:
            return None
        _LLM = Llama(model_path=str(gguf), n_ctx=4096, temperature=0, verbose=False)
    return _LLM


def llm_narrative(event: dict) -> dict | None:
    """对单条事件生成归因叙述（JSON，引用回溯校验）。失败返回 None 不影响主链路。"""
    if os.environ.get("DISABLE_LLM") == "1":
        return None
    rules = event["attribution"]["candidate_rules"]
    hits = [r for r in rules if r["hit"]]
    if not hits:
        return None
    llm = _llm()
    if llm is None:
        return None
    rag = json.dumps(hits, ensure_ascii=False)
    obs = json.dumps(event["attribution"]["observation"], ensure_ascii=False)
    prompt = (
        "你是行为分析报告的撰写助手。只能依据给定的规则条目叙述，禁止生成数值、"
        "禁止添加规则中没有的结论。输出严格 JSON："
        "{\"narrative\": string, \"citations\": [rule_id...]}，citations 必须来自给定规则。\n"
        f"观察层：{obs}\n规则条目：{rag}\nJSON："
    )
    try:
        out = llm.create_chat_completion(
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"}, temperature=0)
        text = out["choices"][0]["message"]["content"]
        data = json.loads(text)
        allowed = {r["rule_id"] for r in hits}
        if not set(data.get("citations", [])) <= allowed:
            return None                      # 引用越界 = 幻觉，丢弃
        return {"narrative": data["narrative"], "citations": data["citations"]}
    except Exception:
        return None


RULE_ID_RE = re.compile(r"^R-[A-Za-z]+-[A-Za-z0-9]+$")
