"""语义分析：bge-m3 话题切分 + 影响值四维分解 + Erlangshen-NLI 矛盾检测。

- 话题切分：相邻句 embedding cosine < 0.55 处切边界；话题标签取话题内第一个实义句压缩（≤14 字）
- 影响值 = 话题时长占比 × (1+情感翻转次数) × (1+矛盾对数)，再按全话题 max 归一到 [0,1]
- 情感极性：NLI 零样本——premise=语句，hypothesis=「这句话表达了明显的负面情绪」，
  极性分 = 蕴含分 - 矛盾分；翻转 = 相邻句极性符号变化
- 矛盾检测：相隔 ≥2 轮的 subject 陈述句对，contradiction > entailment → RawEvent
- 四维分解（各归一 [0,1]，见 rationale_text）：
  情绪冲击=话题内极性分标准差/全局最大；认知冲突=话题内矛盾对数/全局最大；
  利益相关=话题内(金额|责任|时间)关键词命中数/全局最大；持续影响=话题时长占比
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np

from ..config import MS_EMBED, NLI_HF
from ..model_dl import ms_download, hf_download
from .events import RawEvent

SIM_THRESHOLD = 0.55          # 相邻句相似度切话题边界
MIN_CJK = 8                   # 矛盾候选句最少中文字符数
PAIR_GAP = 2                  # 矛盾对最少相隔轮数
MAX_PAIRS = 80                # NLI 调用上限（CPU 全遍历代价过高，均匀采样）
_LABEL_RE = re.compile(r"[\u4e00-\u9fff]")
_KEYWORD_RE = re.compile(r"(\d+(\.\d+)?\s*(万|亿|元|块|百万|千万))|责任|期限|截止|时间|之前")

_BGE = None
_NLI = None                     # (tokenizer, model)


def _load_bge():
    global _BGE
    if _BGE is None:
        import torch
        torch.set_num_threads(4)
        from sentence_transformers import SentenceTransformer
        _BGE = SentenceTransformer(str(ms_download(MS_EMBED)), device="cpu")
    return _BGE


def _load_nli():
    global _NLI
    if _NLI is None:
        import torch
        torch.set_num_threads(4)
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        d = hf_download(NLI_HF)
        tok = AutoTokenizer.from_pretrained(str(d))
        model = AutoModelForSequenceClassification.from_pretrained(str(d)).eval()
        _NLI = (tok, model)
    return _NLI


def _nli_probs(premise: str, hypothesis: str) -> dict:
    """NLI 三分类分数 {contradiction, neutral, entailment}（小写键，缺类补 0）。"""
    tok, model = _load_nli()
    enc = tok(premise, hypothesis, return_tensors="pt", truncation=True, max_length=256)
    with torch.no_grad():
        logits = model(**enc).logits[0]
    prob = torch.softmax(logits, dim=-1).numpy()
    out = {}
    id2label = model.config.id2label or {}
    for i, p in enumerate(prob):
        name = str(id2label.get(i, i)).lower()
        out[name] = float(p)
    for want in ("contradiction", "neutral", "entailment"):
        out.setdefault(want, 0.0)
    return out


def _polarity(text: str) -> float:
    """情绪极性分 ∈ [-1,1]：NLI 蕴含「表达负面情绪」为正（越负性越高分）。"""
    p = _nli_probs(text, "这句话表达了明显的负面情绪")
    return p["entailment"] - p["contradiction"]


def _is_statement(turn: dict) -> bool:
    text = turn.get("text", "").strip()
    return (turn.get("speaker") == "subject"
            and len(_LABEL_RE.findall(text)) >= MIN_CJK
            and not text.endswith(("？", "?")))


def _compress_label(text: str) -> str:
    chars = _LABEL_RE.findall(text)
    return "".join(chars[:14]) if chars else "（无文本）"


def _turn_end(turns: list, i: int) -> float:
    """句末时刻：取下一句 ts；末句按字数 4 字/秒估算。"""
    if i + 1 < len(turns):
        return float(turns[i + 1]["ts"])
    rate = turns[i].get("speech_rate") or 4.0
    return float(turns[i]["ts"]) + max(3.0, len(turns[i]["text"]) / max(rate, 1.0))


def run(turns: list, out_dir: Path) -> dict:
    """turns（DialogueTurn 字典）→ {impacts: ImpactEvent 形状, anomalies: RawEvent}。"""
    sm_dir = Path(out_dir) / "semantic"
    sm_dir.mkdir(parents=True, exist_ok=True)
    if not turns:
        return {"impacts": [], "anomalies": []}

    # ── 话题切分 ─────────────────────────────────────────────────────────
    bge = _load_bge()
    texts = [t.get("text", "") for t in turns]
    emb = bge.encode(texts, normalize_embeddings=True, batch_size=8)
    sims = [float(np.dot(emb[i], emb[i + 1])) for i in range(len(turns) - 1)]
    cut_idx = [i + 1 for i, s in enumerate(sims) if s < SIM_THRESHOLD]
    topics: list[list[int]] = []
    prev = 0
    for c in cut_idx + [len(turns)]:
        topics.append(list(range(prev, c)))
        prev = c

    t0_all = float(turns[0]["ts"])
    t_end_all = max(_turn_end(turns, len(turns) - 1), t0_all + 1.0)
    span_all = t_end_all - t0_all

    # ── 情绪极性（NLI 零样本）────────────────────────────────────────────
    polar = [_polarity(t) for t in texts]

    # ── 矛盾检测：相隔 ≥2 轮的 subject 陈述句对 ────────────────────────────
    stmt_idx = [i for i, t in enumerate(turns) if _is_statement(t)]
    pairs = [(i, j) for x, i in enumerate(stmt_idx)
             for j in stmt_idx[x + 1:] if j - i >= PAIR_GAP]
    if len(pairs) > MAX_PAIRS:                     # 均匀采样封顶，避免 CPU 上组合爆炸
        step = len(pairs) / MAX_PAIRS
        pairs = [pairs[int(k * step)] for k in range(MAX_PAIRS)]
    contradictions: list[dict] = []
    for i, j in pairs:
        p = _nli_probs(turns[i]["text"], turns[j]["text"])
        if p["contradiction"] > p["entailment"]:
            contradictions.append({
                "turn_i": i, "turn_j": j,
                "ts_i": round(float(turns[i]["ts"]), 2),
                "ts_j": round(float(turns[j]["ts"]), 2),
                "text_i": turns[i]["text"], "text_j": turns[j]["text"],
                "contradiction": round(p["contradiction"], 4),
                "entailment": round(p["entailment"], 4),
                "neutral": round(p["neutral"], 4),
            })

    # ── 影响值 + 四维分解 ────────────────────────────────────────────────
    def _topic_span(idxs: list[int]) -> tuple[float, float]:
        return float(turns[idxs[0]]["ts"]), max(_turn_end(turns, idxs[-1]),
                                                float(turns[idxs[-1]]["ts"]) + 1.0)

    stats = []
    for n, idxs in enumerate(topics):
        ts_from, ts_to = _topic_span(idxs)
        dur = ts_to - ts_from
        signs = [1 if polar[i] > 0 else -1 for i in idxs]
        flips = sum(1 for a, b in zip(signs, signs[1:]) if a != b)
        contra_n = sum(1 for c in contradictions if c["turn_i"] in idxs and c["turn_j"] in idxs)
        kw_hits = sum(len(_KEYWORD_RE.findall(turns[i]["text"])) for i in idxs)
        pol_std = float(np.std([polar[i] for i in idxs])) if len(idxs) > 1 else 0.0
        stats.append({"dur": dur, "share": dur / span_all, "flips": flips,
                      "contra": contra_n, "kw": kw_hits, "pol_std": pol_std})

    def _dim(key: str) -> list[float]:
        vals = [s[key] for s in stats]
        top = max(vals) if vals else 0.0
        return [round(v / top, 3) if top > 0 else 0.0 for v in vals]

    dim_share = [round(s["share"], 3) for s in stats]              # 持续影响已在 [0,1]
    dim_emotion, dim_conflict, dim_interest = _dim("pol_std"), _dim("contra"), _dim("kw")
    raw_impact = [s["share"] * (1 + s["flips"]) * (1 + s["contra"]) for s in stats]
    top_impact = max(raw_impact) if raw_impact else 0.0

    impacts: list[dict] = []
    for n, idxs in enumerate(topics):
        s = stats[n]
        ts_from, ts_to = _topic_span(idxs)
        label = next((_compress_label(turns[i]["text"]) for i in idxs
                      if len(_LABEL_RE.findall(turns[i]["text"])) >= 4), "（无文本）")
        score = round(raw_impact[n] / top_impact, 3) if top_impact > 0 else 0.0
        impacts.append({
            "event": "impact",
            "ts": round(ts_from, 2),
            "topic_id": f"T{n + 1:02d}",
            "boundary": (round(ts_from, 2), round(ts_to, 2)),
            "label": label,
            "impact_score": score,
            "dims": {"情绪冲击": dim_emotion[n], "认知冲突": dim_conflict[n],
                     "利益相关": dim_interest[n], "持续影响": dim_share[n]},
            "rationale_text": (
                f"impact_score={score} = 时长占比×(1+情感翻转{s['flips']}次)"
                f"×(1+矛盾{s['contra']}对)，按全话题最大值归一；"
                "情绪冲击=话题内NLI情绪极性标准差/全局最大，"
                "认知冲突=话题内NLI矛盾对数/全局最大，"
                "利益相关=话题内(金额|责任|时间)关键词命中数/全局最大，"
                "持续影响=话题时长占比。"
            ),
            "boundary_evidence": "由 bge-m3 相似度变化点判定（相邻句 cosine 相似度 < 0.55）",
        })

    # ── 矛盾 → RawEvent（semantic 模态）───────────────────────────────────
    anomalies = [RawEvent(
        ts=float(turns[c["turn_j"]]["ts"]), modality="semantic",
        type="信息前后矛盾（NLI 不一致）", severity="ALERT",
        confidence=round(c["contradiction"], 2),
        deviation=round(c["contradiction"] - c["entailment"], 2),
        window=(c["ts_i"], c["ts_j"]),
        metrics={"矛盾分数": (c["contradiction"], ""), "蕴含分数": (c["entailment"], ""),
                 "前轮": (c["turn_i"], "轮"), "后轮": (c["turn_j"], "轮")},
    ) for c in contradictions]

    (sm_dir / "topics.json").write_text(json.dumps({
        "n_turns": len(turns), "n_topics": len(topics),
        "adjacent_sims": [round(s, 4) for s in sims],
        "topics": [{"topic_id": f"T{n + 1:02d}", "turn_range": [i for i in idxs],
                    "label": impacts[n]["label"],
                    "boundary": list(impacts[n]["boundary"]),
                    "impact_score": impacts[n]["impact_score"],
                    "dims": impacts[n]["dims"],
                    "turns": [{"i": i, "speaker": turns[i]["speaker"],
                               "text": turns[i]["text"]} for i in idxs]}
                   for n, idxs in enumerate(topics)],
    }, ensure_ascii=False, indent=1), "utf-8")
    (sm_dir / "contradictions.json").write_text(
        json.dumps(contradictions, ensure_ascii=False, indent=1), "utf-8")

    return {"impacts": impacts, "anomalies": anomalies}
