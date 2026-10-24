"""语音转写：VAD → SenseVoice ASR（词级时间戳）→ 标点 → 分角色 → 重叠绑定。

链路（全部 ModelScope 模型，CPU 4 线程，模块级单例惰性加载）：
- VAD   iic/speech_fsmn_vad_zh-cn-16k-common-onnx     长音频切段
- ASR   iic/SenseVoiceSmall                            非自回归，附词级时间戳
- 标点  iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch  句段切分
- 分角色 iic/speech_campplus_speaker-diarization_common VAD+CAM++ 一体化

说话人归约：分角色总时长更长的一方 → interviewer（问话方），其余 → subject；
ASR 句段与分角色片段按重叠比例绑定（人数 >2 时天然取重叠最长者），
无重叠 → diar_confidence=null、diar_state='degraded'。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from ..config import MS_ASR, MS_VAD, MS_PUNC, MS_DIAR
from ..model_dl import ms_download

_CPU_THREADS = 4
_TAG_RE = re.compile(r"<\|[^|]*\|>")          # SenseVoice 输出里的 <|zh|><|HAPPY|> 等元信息标签
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")

_CASCADE = None   # ASR+VAD+标点级联模型
_DIAR = None      # 分角色 pipeline


def _load():
    """惰性加载全部模型（模块级单例）。"""
    global _CASCADE, _DIAR
    if _CASCADE is None:
        import torch
        torch.set_num_threads(_CPU_THREADS)
        from funasr import AutoModel
        asr_dir = ms_download(MS_ASR)
        vad_dir = ms_download(MS_VAD)
        punc_dir = ms_download(MS_PUNC)
        diar_dir = ms_download(MS_DIAR)
        _CASCADE = AutoModel(
            model=str(asr_dir), vad_model=str(vad_dir), punc_model=str(punc_dir),
            device="cpu", ncpu=_CPU_THREADS,
            generate_kwargs={"with_itn": True},
        )
        _DIAR = AutoModel(model=str(diar_dir), device="cpu", ncpu=_CPU_THREADS)
    return _CASCADE, _DIAR


def _clean(text: str) -> str:
    """去掉 SenseVoice 富文本标签，只留可读文本。"""
    return _TAG_RE.sub("", text).strip()


def _cjk_count(text: str) -> int:
    return len(_CJK_RE.findall(text))


def _normalize_diar(diar_res) -> list[tuple[float, float, int]]:
    """分角色输出 → [(start_s, end_s, spk_id)]；自动判定毫秒/秒单位。"""
    segs = []
    for item in diar_res or []:
        if not isinstance(item, dict) or "start" not in item:
            continue
        segs.append((float(item["start"]), float(item["end"]), int(item["spk"])))
    if segs and max(e for _, e, _ in segs) > 10000:      # 毫秒单位 → 秒
        segs = [(s / 1000.0, e / 1000.0, k) for s, e, k in segs]
    return sorted(segs, key=lambda x: x[0])


def _bind_spk(s_start: float, s_end: float,
              spk_segs: list[tuple[float, float, int]]) -> tuple[int | None, float | None]:
    """句段 → 重叠比例最大的分角色说话人；返回 (spk_id, 重叠/句段时长)。"""
    best_spk, best_ov = None, 0.0
    for st, ed, spk in spk_segs:
        ov = min(s_end, ed) - max(s_start, st)
        if ov > best_ov:
            best_spk, best_ov = spk, ov
    if best_spk is None:
        return None, None
    conf = best_ov / max(s_end - s_start, 1e-6)
    return best_spk, round(min(conf, 1.0), 3)


def _role_map(spk_segs: list[tuple[float, float, int]]) -> dict[int, str]:
    """发言总时长最长 → interviewer，其余 → subject。"""
    total: dict[int, float] = {}
    for st, ed, spk in spk_segs:
        total[spk] = total.get(spk, 0.0) + (ed - st)
    ranked = sorted(total, key=lambda k: -total[k])
    return {spk: ("interviewer" if i == 0 else "subject")
            for i, spk in enumerate(ranked)}


def run(wav_path: Path, out_dir: Path) -> dict:
    """16kHz WAV → {turns: DialogueTurn 形状字典列表}，中间产物落盘 out_dir/speech/。"""
    wav_path = Path(wav_path)
    sp_dir = Path(out_dir) / "speech"
    sp_dir.mkdir(parents=True, exist_ok=True)
    cascade, diar = _load()

    # ── ASR 级联（VAD 切段 + SenseVoice + 标点 + 句级时间戳）────────────────
    res = cascade.generate(
        input=str(wav_path),
        output_timestamp=True,          # SenseVoice 词级时间戳
        sentence_timestamp=True,        # 标点切句 + 时间戳对齐 → sentence_info
        batch_size_s=300,
    )[0]
    sentences = res.get("sentence_info") or []
    sentences = [s for s in sentences if _clean(s.get("sentence") or s.get("text") or "")]
    if not sentences:                   # 极端情况退回：整段一条
        sentences = [{"start": 0.0, "end": 0.0,
                      "text": _clean(res.get("text", "")),
                      "timestamp": res.get("timestamp") or []}]

    # ── 分角色（VAD + CAM++ 聚类）─────────────────────────────────────────
    diar_segs = _normalize_diar(diar.generate(input=str(wav_path)))
    roles = _role_map(diar_segs)
    degraded = len(roles) <= 1          # 只分出 1 人 = 分角色降级

    # ── 绑定 + 组装契约 turn ───────────────────────────────────────────────
    turns: list[dict] = []
    raw_segments: list[dict] = []
    for s in sentences:
        text = _clean(s.get("sentence") or s.get("text") or "")
        s_start = float(s.get("start", 0.0))
        s_end = float(s.get("end", s_start))
        if s_end <= s_start:            # 毫秒单位兜底
            s_start, s_end = s_start / 1000.0, s_end / 1000.0
        dur = s_end - s_start
        spk, conf = _bind_spk(s_start, s_end, diar_segs)
        if degraded or spk is None:
            speaker, conf, state = "interviewer", None, "degraded"
        else:
            speaker, state = roles[spk], "ok"
        rate = round(_cjk_count(text) / dur, 2) if dur > 0 and _cjk_count(text) else None
        turns.append({
            "event": "dialogue",
            "ts": round(s_start, 2),
            "speaker": speaker,
            "text": text,
            "speech_rate": rate,
            "diar_confidence": conf,
            "diar_state": state,
        })
        words = s.get("timestamp") or []
        raw_segments.append({
            "start": round(s_start, 2), "end": round(s_end, 2),
            "text": text, "spk_raw": spk,
            "word_timestamps": [[round(w[0] / 1000.0, 2), round(w[1] / 1000.0, 2)]
                                for w in words],
        })

    (sp_dir / "turns.json").write_text(
        json.dumps(turns, ensure_ascii=False, indent=1), "utf-8")
    (sp_dir / "segments.json").write_text(
        json.dumps(raw_segments, ensure_ascii=False, indent=1), "utf-8")
    return {"turns": turns}
