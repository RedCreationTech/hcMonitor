"""声学分析：Praat（parselmouth）嗓音特征 + librosa 能量/静音段 → 个体基线偏离事件。

指标：整段 + 滑动窗（10s 窗 / 5s 步）F0 均值/标准差、jitter(local)、shimmer(local)、
HNR、RMS 能量（dB）、静音占比。静音段 = RMS < -45dB 且 ≥0.8s（librosa 帧级）。
基线 = 前 20% 时段的窗指标中位数 + MAD；偏离 z = (x-中位数)/(1.4826×MAD)。
z ≥ 2.0（jitter/shimmer ≥ 2.5）且持续 ≥5s → RawEvent（z≥3 → ALERT，否则 WARN）。
"""
from __future__ import annotations

import csv
import json
import math
from pathlib import Path

import numpy as np

from .events import RawEvent

WIN_S, HOP_S = 10.0, 5.0          # 滑动窗：10s 窗 / 5s 步
BASELINE_FRAC = 0.20              # 前 20% 时段建个体基线
SILENCE_DB = -45.0                # 静音阈值（dB）
SILENCE_MIN_S = 0.8               # 静音段最短时长
Z_THR = {"f0_mean": 2.0, "f0_std": 2.0, "jitter": 2.5,
         "shimmer": 2.5, "hnr": 2.0, "rms_db": 2.0}
METRIC_LABEL = {                  # 事件类型中文名（降低/升高两个方向）
    "f0_mean": ("音调较基线降低", "音调较基线升高"),
    "f0_std": ("音高波动较基线收窄", "音高波动较基线增大"),
    "jitter": ("jitter 异常降低", "jitter 异常升高"),
    "shimmer": ("shimmer 异常降低", "shimmer 异常升高"),
    "hnr": ("嗓音谐噪比(HNR)较基线升高", "嗓音谐噪比(HNR)较基线降低"),
    "rms_db": ("说话能量较基线降低", "说话能量较基线升高"),
}
METRIC_UNIT = {"f0_mean": "Hz", "f0_std": "Hz", "jitter": "", "shimmer": "",
               "hnr": "dB", "rms_db": "dB"}


def _voice_metrics(snd) -> dict:
    """parselmouth 单段声学指标；无声学帧处返回 NaN。"""
    f0min, f0max = 75.0, 500.0
    nan = {k: math.nan for k in ("f0_mean", "f0_std", "jitter", "shimmer", "hnr")}
    try:
        pitch = snd.to_pitch(pitch_floor=f0min, pitch_ceiling=f0max)
        f0 = pitch.selected_array["frequency"]
        f0 = f0[f0 > 0]
        if len(f0) < 3:
            return nan
        out = {"f0_mean": float(np.mean(f0)), "f0_std": float(np.std(f0))}
        import parselmouth
        pp = parselmouth.praat.call(snd, "To PointProcess (periodic, cc)", f0min, f0max)
        out["jitter"] = float(parselmouth.praat.call(
            pp, "Get jitter (local)", 0, 0, 0.0001, 0.02, 1.3))
        out["shimmer"] = float(parselmouth.praat.call(
            [snd, pp], "Get shimmer (local)", 0, 0, 0.0001, 0.02, 1.3, 1.6))
        harm = parselmouth.praat.call(snd, "To Harmonicity (cc)", 0.01, f0min, 0.1, 1.0)
        out["hnr"] = float(parselmouth.praat.call(harm, "Get mean", 0, 0))
        return out
    except Exception:                # noqa: BLE001（无声学帧/周期检测失败按 NaN 处理）
        return nan


def _rms_db(y: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """librosa 帧级 RMS（dB）；返回 (times_s, rms_db)。"""
    import librosa
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
    db = 20.0 * np.log10(rms + 1e-10)
    return librosa.frames_to_time(np.arange(len(db)), sr=sr, hop_length=512), db


def _silence_runs(times: np.ndarray, db: np.ndarray) -> list[tuple[float, float]]:
    """RMS < -45dB 且连续 ≥0.8s 的静音段 [(start, end)]。"""
    mask = db < SILENCE_DB
    runs: list[tuple[float, float]] = []
    i = 0
    hop = float(times[1] - times[0]) if len(times) > 1 else 0.032
    while i < len(mask):
        if mask[i]:
            j = i
            while j < len(mask) and mask[j]:
                j += 1
            t0, t1 = float(times[i]), float(times[j - 1]) + hop
            if t1 - t0 >= SILENCE_MIN_S:
                runs.append((t0, t1))
            i = j
        else:
            i += 1
    return runs


def _window_table(wav_path: Path) -> tuple[list[dict], dict]:
    """整段 + 滑动窗指标表；同时返回帧级 RMS 与静音段。"""
    import parselmouth
    import librosa

    y, sr = librosa.load(str(wav_path), sr=None, mono=True)
    times, db = _rms_db(y, sr)
    snd = parselmouth.Sound(str(wav_path))
    dur = snd.get_total_duration()
    sil_runs = _silence_runs(times, db)

    def _rms_in(t0: float, t1: float) -> float:
        m = (times >= t0) & (times < t1)
        return float(np.mean(db[m])) if m.any() else math.nan

    def _sil_ratio(t0: float, t1: float) -> float:
        segs = [min(e, t1) - max(s, t0) for s, e in sil_runs
                if min(e, t1) - max(s, t0) > 0]
        return sum(segs) / max(t1 - t0, 1e-6)

    def _row(t0: float, t1: float) -> dict:
        part = snd.extract_part(from_time=t0, to_time=t1,
                                window_shape=parselmouth.WindowShape.RECTANGULAR,
                                relative_width=1.0, preserve_times=False)
        m = _voice_metrics(part)
        m.update({"start": round(t0, 2), "end": round(t1, 2),
                  "rms_db": round(_rms_in(t0, t1), 2),
                  "silence_ratio": round(_sil_ratio(t0, t1), 3)})
        return m

    rows = [_row(0.0, dur)]                       # 整段（start=0, end=总长）
    t = 0.0
    while t + WIN_S <= dur + 1e-6:
        rows.append(_row(t, min(t + WIN_S, dur)))
        t += HOP_S
    if dur > WIN_S and rows[-1]["end"] < dur:     # 尾部不足一窗也收一口
        rows.append(_row(max(0.0, dur - WIN_S), dur))

    whole = {k: round(v, 4) for k, v in rows[0].items()
             if k not in ("start", "end")}
    whole["silence_runs"] = [[round(s, 2), round(e, 2)] for s, e in sil_runs]
    return rows, {"duration_s": round(dur, 2), "sr": sr, "whole": whole,
                  "window": f"{WIN_S}s/{HOP_S}s", "silence_db": SILENCE_DB}


def _baseline(rows: list[dict], dur: float) -> dict:
    """前 20% 时段的窗指标 → {指标: (中位数, 1.4826×MAD)}；样本不足退回全体窗。"""
    cut = dur * BASELINE_FRAC
    base = [r for r in rows[1:] if r["end"] <= cut + 1e-6]
    if len(base) < 3:
        return {}
    out = {}
    for k in Z_THR:
        vals = np.array([r[k] for r in base
                         if r.get(k) is not None and not math.isnan(r[k])], dtype=float)
        if len(vals) < 3:
            continue
        med = float(np.median(vals))
        mad = float(np.median(np.abs(vals - med))) * 1.4826
        if mad > 1e-9:
            out[k] = (med, mad)
    return out


def _z(x: float, med: float, mad: float) -> float:
    return (x - med) / mad


def _deviation_events(rows: list[dict], base: dict) -> list[RawEvent]:
    """逐指标找 z 超阈的连续窗段，持续 ≥5s 产出 RawEvent。"""
    events: list[RawEvent] = []
    for k, thr in Z_THR.items():
        if k not in base:
            continue
        med, mad = base[k]
        hit = [r for r in rows[1:]
               if not math.isnan(r.get(k, math.nan)) and abs(_z(r[k], med, mad)) >= thr]
        run: list[dict] = []
        for r in hit + [None]:                    # None 哨兵收尾
            if r is not None and run and abs(r["start"] - run[-1]["end"]) <= HOP_S + 0.01:
                run.append(r)
            else:
                if run:
                    t0, t1 = run[0]["start"], run[-1]["end"]
                    if t1 - t0 >= 5.0:
                        zmax = max(abs(_z(x[k], med, mad)) for x in run)
                        v_at = max(run, key=lambda x: abs(_z(x[k], med, mad)))[k]
                        direction = 1 if _z(v_at, med, mad) > 0 else 0
                        events.append(RawEvent(
                            ts=float(t0), modality="voice",
                            type=METRIC_LABEL[k][direction],
                            severity="ALERT" if zmax >= 3.0 else "WARN",
                            confidence=round(min(0.99, zmax / (thr * 2.0)), 2),
                            deviation=round(zmax, 2),
                            window=(float(t0), float(t1)),
                            metrics={METRIC_LABEL[k][direction]: (round(v_at, 4), METRIC_UNIT[k]),
                                     "基线中位数": (round(med, 4), METRIC_UNIT[k]),
                                     "偏离z": (round(zmax, 2), "σ")},
                        ))
                run = [r] if r is not None else []
    return events


def _silence_events(runs: list[tuple[float, float]]) -> list[RawEvent]:
    return [RawEvent(
        ts=float(s), modality="voice", type="静默段（音量低于-45dB）",
        severity="INFO", confidence=1.0, deviation=0.0,
        window=(float(s), float(e)),
        metrics={"静默时长": (round(e - s, 2), "秒")},
        cap_note="仅低音量观察；无个人停顿偏离基线，不作心理解释",
    ) for s, e in runs]


def run(wav_path: Path, turns: list, out_dir: Path) -> dict:
    """16kHz WAV + turns → {anomalies: RawEvent 列表}；特征表/事件落盘 out_dir/acoustic/。"""
    wav_path = Path(wav_path)
    ac_dir = Path(out_dir) / "acoustic"
    ac_dir.mkdir(parents=True, exist_ok=True)

    rows, meta = _window_table(wav_path)
    # Only windows entirely dominated by one confirmed participant enter a personal baseline.
    base, events = {}, _silence_events(meta["whole"]["silence_runs"])
    participants = sorted({t.get("participant_id") for t in turns if t.get("participant_id")})
    for participant in participants:
        own = [rows[0]]
        for row in rows[1:]:
            coverage = sum(max(0, min(row["end"], t.get("end", t["ts"])) - max(row["start"], t["ts"]))
                           for t in turns if t.get("participant_id") == participant and t.get("speaker") not in ("unknown", "overlap"))
            if coverage >= (row["end"] - row["start"]) * .8:
                own.append(row)
        individual = _baseline(own, meta["duration_s"])
        base[participant] = individual
        events.extend(_deviation_events(own, individual))
    meta["baseline_status"] = "available" if any(base.values()) else "insufficient"
    meta["baseline_policy"] = "confirmed participant / first20% / >=3 windows / nonzero MAD; no fallback"


    cols = ["start", "end", "f0_mean", "f0_std", "jitter", "shimmer",
            "hnr", "rms_db", "silence_ratio"]
    with (ac_dir / "features.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows([{c: r.get(c) for c in cols} for r in rows[1:]])   # 逐窗行（整段在 events.json）
    (ac_dir / "events.json").write_text(json.dumps({
        "meta": meta,
        "baseline": {person: {k: {"median": v[0], "mad_x14826": v[1]} for k, v in values.items()} for person, values in base.items()},
        "events": [e.__dict__ for e in events],
    }, ensure_ascii=False, indent=1), "utf-8")

    return {"anomalies": events, "baseline_status": meta["baseline_status"]}
