"""语音转写：VAD → SenseVoice ASR（词级时间戳）→ 标点 → 分角色 → 重叠绑定。

链路（全部 ModelScope 模型，CPU 4 线程，模块级单例惰性加载）：
- VAD   iic/speech_fsmn_vad_zh-cn-16k-common-onnx     长音频切段
- ASR   iic/SenseVoiceSmall                            非自回归，附词级时间戳
- 标点  iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch  句段切分
- 分角色 iic/speech_campplus_speaker-diarization_common 的 segmentation-clustering
        流程（其 configuration.json 声明）：VAD 段 → CAM++ 说话人嵌入
        （speaker_model=iic/speech_campplus_sv_zh-cn_16k-common）→ 谱聚类（merge_thr=0.78）

说话人归约：分角色总时长更长的一方 → interviewer（问话方），其余 → subject；
ASR 句段与分角色片段按重叠比例绑定（人数 >2 时天然取重叠最长者），
无重叠 → diar_confidence=null、diar_state='degraded'。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np

from ..config import MODELS as _MODELS
from ..config import MS_ASR, MS_VAD, MS_PUNC, MS_DIAR
from ..model_dl import ms_download

_CPU_THREADS = 4
_TAG_RE = re.compile(r"<\|[^|]*\|>")          # SenseVoice 输出里的 <|zh|><|HAPPY|> 等元信息标签
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
# config.MS_VAD 指向 onnx 仓库，funasr 1.4.16 无对应模型类（仓库无 model.pt、无 onnx 类）；
# 退回同架构同权重的 pytorch 版（funasr 官方别名 fsmn-vad 的解析目标）
_VAD_FALLBACK = "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"

_CASCADE = None   # ASR+VAD+标点级联模型
_SPK = None       # CAM++ 说话人嵌入模型
_CB = None        # 谱聚类后端（ClusterBackend，merge_thr 读自分角色模型配置）


def _load():
    """惰性加载全部模型（模块级单例）。

    funasr 按模型 ID 自行解析仓库配置（本地路径会跳过 config.yaml 解析），
    MODELSCOPE_CACHE 指到 models/ 复用同一份缓存。
    """
    global _CASCADE, _SPK, _CB
    if _CASCADE is None:
        import os
        import torch
        os.environ.setdefault("MODELSCOPE_CACHE", str(_MODELS))
        torch.set_num_threads(_CPU_THREADS)
        from funasr import AutoModel
        vad_id = MS_VAD
        try:                            # 先探测 VAD 可加载性，避免级联建两遍
            AutoModel(model=vad_id, device="cpu", ncpu=_CPU_THREADS)
        except RuntimeError as e:
            if "not registered" not in str(e):
                raise
            print(f"[speech] {MS_VAD} 无 funasr 模型类（onnx 仓库），"
                  f"退回 pytorch 版 {_VAD_FALLBACK}")
            vad_id = _VAD_FALLBACK
        _CASCADE = AutoModel(model=MS_ASR, vad_model=vad_id, punc_model=MS_PUNC,
                             device="cpu", ncpu=_CPU_THREADS)
        # 分角色 pipeline 配置驱动：speaker_model + merge_thr 均读自 MS_DIAR 仓库
        from funasr.models.campplus.cluster_backend import ClusterBackend
        diar_dir = ms_download(MS_DIAR)
        cfg = json.loads((diar_dir / "configuration.json").read_text("utf-8"))
        mconf = cfg.get("model", {})
        cb_kwargs = {k: v for k, v in (mconf.get("model_config") or {}).items()
                     if k in ("merge_thr",)}
        spk_id = str(mconf.get("speaker_model",
                               "iic/speech_campplus_sv_zh-cn_16k-common"))
        if spk_id.startswith("damo/"):            # 旧命名空间 → iic（同一模型）
            spk_id = "iic/" + spk_id.split("/", 1)[1]
        _SPK = AutoModel(model=spk_id, device="cpu", ncpu=_CPU_THREADS)
        _CB = ClusterBackend(**cb_kwargs)
    return _CASCADE, _SPK, _CB


def _clean(text: str) -> str:
    """去掉 SenseVoice 富文本标签，只留可读文本。"""
    return _TAG_RE.sub("", text).strip()


def _cjk_count(text: str) -> int:
    return len(_CJK_RE.findall(text))


def _spk_segments(cascade, spk, cb, wav_path: Path) -> list[tuple[float, float, int]]:
    """分角色：VAD 段切 1.5s/0.75s 块 → CAM++ 嵌入 → 谱聚类 → 平滑合并 → [(start_s, end_s, spk)]。"""
    import torch
    import librosa
    from funasr.models.campplus.utils import sv_chunk, postprocess

    y, sr = librosa.load(str(wav_path), sr=16000, mono=True)
    vad_res = cascade.inference(input=str(wav_path),
                                model=cascade.vad_model,
                                kwargs=cascade.vad_kwargs)[0]
    segs_ms = vad_res.get("value") or []
    vad_segs = [[s / 1000.0, e / 1000.0,
                 y[int(s / 1000.0 * sr):int(e / 1000.0 * sr)]]
                for s, e in segs_ms]
    chunks = sv_chunk(vad_segs)
    if not chunks:
        return []
    spk_res = spk.generate(input=[c[2] for c in chunks])
    embs = np.stack([np.asarray(r["spk_embedding"]).reshape(-1) for r in spk_res])
    labels = np.asarray(cb(torch.from_numpy(embs).float()))
    out = postprocess(chunks, None, labels, embs)
    return [(float(s), float(e), int(k)) for s, e, k in out]


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
    cascade, spk, cb = _load()

    # ── ASR 级联（VAD 切段 + SenseVoice + 标点 + 句级时间戳）────────────────
    res = cascade.generate(
        input=str(wav_path),
        use_itn=True,                   # SenseVoice 富文本规整（数字/标点规范化）
        output_timestamp=True,          # SenseVoice 词级时间戳
        sentence_timestamp=True,        # 标点切句 + 时间戳对齐 → sentence_info
        batch_size_s=300,
    )[0]
    sentences = res.get("sentence_info") or []
    sentences = [s for s in sentences if _clean(s.get("sentence") or s.get("text") or "")]
    if sentences and max(float(s.get("end", 0.0)) for s in sentences) > 600.0:
        # sentence_info 时间戳为毫秒（SenseVoice 链路）→ 统一秒
        sentences = [{**s, "start": float(s.get("start", 0.0)) / 1000.0,
                      "end": float(s.get("end", 0.0)) / 1000.0} for s in sentences]
    if not sentences:                   # 极端情况退回：整段一条
        sentences = [{"start": 0.0, "end": 0.0,
                      "text": _clean(res.get("text", "")),
                      "timestamp": res.get("timestamp") or []}]

    # ── 分角色（segmentation-clustering：VAD → CAM++ 嵌入 → 谱聚类）──────────
    diar_segs = _spk_segments(cascade, spk, cb, wav_path)
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
        json.dumps({
            "asr_segments": raw_segments,
            "diar_segments": [{"start": round(s, 2), "end": round(e, 2),
                               "spk": k, "role": roles.get(k)} for s, e, k in diar_segs],
        }, ensure_ascii=False, indent=1), "utf-8")
    return {"turns": turns}
