"""非接触生理估计：FaceMesh ROI 取色 → POS（皮肤平面正交投影）→ 心率/HRV 趋势。

- 每 2 帧取 1 帧（跳帧 2 → 12.5Hz），面部中央 200x200 ROI 三通道均值时序
- POS 算法自实现（Wang et al. 2017；rPPG-Toolbox 口径 arXiv:2210.00716）：
  滑动窗内逐通道时域归一 → 投影到皮肤色调平面正交基 [0,1,-1]/[-2,1,1] →
  按两轴 std 加权合成脉搏波
- 心率趋势：基线 = 前 20% 窗中位数；较基线升高 ≥15% 且持续 ≥30s → 生理应激事件
- HRV 只报趋势方向：metrics 仅 {心率}，不写 LF/HF 绝对值（封顶声明见 config.CAP_NOTE 体系）
- 质量门：ROI 亮度变异系数大（光照跳变）→ degraded
"""
from __future__ import annotations

import csv
import os
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")

import cv2
import numpy as np
import mediapipe as mp
from scipy.signal import butter, filtfilt, find_peaks

from ..config import VIDEO_FPS
from .events import RawEvent
from .vision import _head_crop          # 小脸对策共用：Pose 头 ROI 3x 放大

FPS = VIDEO_FPS
SKIP = 2                    # 跳帧 2 → 12.5Hz
ROI = 200                   # 面部中央 ROI 边长（px）
WIN_S = 8.0                 # HR 滑窗
OVERLAP = 0.5               # 50% 重叠
BAND = (0.75, 4.0)          # 带通 Hz（≈45-240 bpm）
HR_RISE = 0.15              # 较基线升高阈值
HR_HOLD_S = 30.0            # 持续阈值
BASELINE_FRAC = 0.2
BRIGHT_CV_MAX = 0.3         # ROI 亮度变异系数上限
FACE_RATE_MIN = 0.5
BRIDGE_MAX_S = 4.0          # 缺口超过该时长不插值，退最长连续段
HR_PLAUSIBLE = (45.0, 140.0)   # 静息谈话合理心率带；带外窗不进趋势判定


def _pos_wave(rgb: np.ndarray, fs: float) -> np.ndarray:
    """POS 脉搏波：逐帧输出（前 L 帧用首个窗口回填，末帧延前值）。"""
    n = len(rgb)
    l = max(8, int(round(1.6 * fs)))            # 1.6s 窗（论文默认）
    h = np.zeros(n)
    for i in range(l, n):
        c = rgb[i - l:i]
        cn = c / (c.mean(axis=0) + 1e-9)        # 时域归一（逐通道除窗内均值）
        s = cn @ np.array([[0.0, 1.0, -1.0], [-2.0, 1.0, 1.0]]).T   # 皮肤平面正交基
        s1, s2 = s[:, 0], s[:, 1]
        h[i - l:i] = s1 + (np.std(s1) / (np.std(s2) + 1e-9)) * s2
    h[n - 1] = h[n - 2]
    return h - np.mean(h)


def _hr_rmssd(seg: np.ndarray, fs: float) -> tuple[float, float]:
    """8s 窗脉搏波 → (HR bpm, RMSSD ms)；峰值不可靠时 RMSSD 返回 NaN。"""
    nfft = max(2048, len(seg) * 4)
    spec = np.abs(np.fft.rfft(seg, nfft))
    freqs = np.fft.rfftfreq(nfft, 1 / fs)
    band = (freqs >= BAND[0]) & (freqs <= BAND[1])
    hr = float(60 * freqs[band][np.argmax(spec[band])])
    pk, _ = find_peaks(seg, distance=max(2, int(0.3 * fs)),
                       prominence=np.std(seg) * 0.5)
    ibi = np.diff(pk) / fs * 1000.0
    rmssd = float(np.sqrt(np.mean(np.diff(ibi) ** 2))) if len(ibi) >= 4 else float("nan")
    return hr, rmssd


def run(video_path: Path, out_dir: Path) -> dict:
    """整段视频 rPPG 分析，落盘波形/心率 CSV，返回契约形状字典。"""
    video_path = Path(video_path)
    rppg_dir = Path(out_dir) / "rppg"
    rppg_dir.mkdir(parents=True, exist_ok=True)
    cv2.setNumThreads(4)

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频: {video_path}")
    native_fps = float(cap.get(cv2.CAP_PROP_FPS)) or FPS

    fm = mp.solutions.face_mesh.FaceMesh(
        refine_landmarks=True, max_num_faces=1,
        min_detection_confidence=0.3, min_tracking_confidence=0.3)
    pose = mp.solutions.pose.Pose(
        model_complexity=0, min_detection_confidence=0.5, min_tracking_confidence=0.5)

    ts: list[float] = []
    rgb_rows: list[np.ndarray] = []
    bright: list[float] = []
    face_ok: list[bool] = []

    idx = -1
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        idx += 1
        if idx % SKIP:
            continue
        t = idx / native_fps
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        rp = pose.process(rgb)
        roi = None
        if rp.pose_landmarks:
            hc = _head_crop(frame, rp.pose_landmarks.landmark)
            if hc:
                x0, y0, crop = hc
                rf = fm.process(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
                if rf.multi_face_landmarks:
                    lm = rf.multi_face_landmarks[0].landmark
                    cw, ch = crop.shape[1], crop.shape[0]
                    xs = [lm[i].x * cw / 3 + x0 for i in range(468)]   # 回原图
                    ys = [lm[i].y * ch / 3 + y0 for i in range(468)]
                    cx, cy = int(np.mean(xs)), int(np.mean(ys))
                    x_a, x_b = max(0, cx - ROI // 2), min(frame.shape[1], cx + ROI // 2)
                    y_a, y_b = max(0, cy - ROI // 2), min(frame.shape[0], cy + ROI // 2)
                    if x_b - x_a >= ROI // 2 and y_b - y_a >= ROI // 2:
                        roi = frame[y_a:y_b, x_a:x_b]
        if roi is not None:
            rgb_rows.append(roi.reshape(-1, 3).mean(axis=0))          # BGR 均值（通道顺序无关）
            bright.append(float(cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY).mean()))
            face_ok.append(True)
        else:
            rgb_rows.append(np.array([np.nan, np.nan, np.nan]))
            bright.append(float("nan"))
            face_ok.append(False)
        ts.append(t)
    cap.release()
    fm.close()
    pose.close()

    n = len(ts)
    fs = native_fps / SKIP
    anomalies: list[RawEvent] = []
    hr_series: list[dict] = []
    face_ok = np.array(face_ok, dtype=bool)
    face_rate = float(np.mean(face_ok)) if n else 0.0

    if n < int(2 * WIN_S * fs):
        return {"anomalies": [], "quality": "degraded",
                "quality_note": f"有效样本不足（{n} 帧），无法估计心率",
                "hr_series": []}

    # ── 缺口处理：≤BRIDGE_MAX_S 的缺口线性插值桥接；更大缺口退最长连续段 ──
    rgb = np.array(rgb_rows, dtype=np.float64)
    gap_idx = np.where(~face_ok)[0]
    max_gap = 0
    if len(gap_idx):
        runs = np.split(gap_idx, np.where(np.diff(gap_idx) > 1)[0] + 1)
        max_gap = max(len(r) for r in runs)
        if max_gap <= int(BRIDGE_MAX_S * fs):
            for ch in range(3):
                rgb[:, ch] = np.interp(np.arange(n), np.where(face_ok)[0],
                                       rgb[face_ok, ch])
    bright_cv = float(np.nanstd(bright) / np.nanmean(bright))
    quality = "ok"
    notes = []
    if face_rate < FACE_RATE_MIN:
        quality = "degraded"
        notes.append(f"人脸检出率 {face_rate:.0%}（阈值 {FACE_RATE_MIN:.0%}）")
    if max_gap > int(BRIDGE_MAX_S * fs):
        quality = "degraded"
        notes.append(f"存在 {max_gap / fs:.0f}s 面部缺失段（>{BRIDGE_MAX_S:.0f}s 不桥接）")
    if bright_cv > BRIGHT_CV_MAX:
        quality = "degraded"
        notes.append(f"ROI 亮度变异系数 {bright_cv:.2f}（阈值 {BRIGHT_CV_MAX}），光照跳变")

    if np.isnan(rgb).any():
        # 大缺口场景：只对最长连续有效段分析
        valid = np.where(face_ok)[0]
        edges = np.where(np.diff(valid) > 1)[0]
        segs = np.split(valid, edges + 1)
        seg = max(segs, key=len)
        lo, hi = seg[0], seg[-1] + 1
        ts_a = ts[lo:hi]
        rgb_a = rgb[lo:hi]
        notes.append(f"仅用最长连续段 {ts_a[0]:.0f}-{ts_a[-1]:.0f}s 分析")
    else:
        ts_a, rgb_a = ts, rgb
        lo, hi = 0, n

    # ── 带通（butter 3 阶 0.75-4Hz）→ POS 脉搏波 ──
    b, a = butter(3, [BAND[0], min(BAND[1], fs / 2 - 0.1)], btype="bandpass", fs=fs)
    rgb_f = np.apply_along_axis(lambda c: filtfilt(b, a, c), 0, rgb_a)
    pulse = _pos_wave(rgb_f, fs)

    # ── 8s 窗 50% 重叠 → HR / RMSSD ──
    win, step = int(WIN_S * fs), int(WIN_S * OVERLAP * fs)
    for s in range(0, len(pulse) - win + 1, step):
        e = s + win
        hr, rmssd = _hr_rmssd(pulse[s:e], fs)
        hr_series.append({"t": round(ts_a[(s + e) // 2], 1),
                          "hr": round(hr, 1), "rmssd": round(rmssd, 1) if rmssd == rmssd else None})

    # ── 趋势事件：较基线中位升高 ≥15% 且持续 ≥30s（仅用心率合理带内的窗）──
    hrs = [h["hr"] for h in hr_series]
    plausible = [HR_PLAUSIBLE[0] <= h <= HR_PLAUSIBLE[1] for h in hrs]
    n_out = len(hrs) - sum(plausible)
    if n_out:
        notes.append(f"{n_out} 个 HR 窗落在合理带 {HR_PLAUSIBLE[0]:.0f}-"
                     f"{HR_PLAUSIBLE[1]:.0f}bpm 外（疑运动/压缩伪迹），未进趋势判定")
    base = float(np.median([h for h, p in zip(hrs[:max(1, int(len(hrs) * BASELINE_FRAC))],
                                              plausible[:max(1, int(len(hrs) * BASELINE_FRAC))]) if p])) if hrs else float("nan")
    if hrs and base == base:
        mask = [p and h >= base * (1 + HR_RISE) for h, p in zip(hrs, plausible)]
        runs: list[tuple[int, int]] = []
        cur: list[int] | None = None
        for i, m in enumerate(mask):
            if m:
                cur = cur if cur is not None else [i, i]
                cur[1] = i
            elif cur and (i - cur[1]) > 1:
                runs.append(tuple(cur))
                cur = None
        if cur:
            runs.append(tuple(cur))
        for s, e in runs:
            dur = (e - s) * step / fs
            if dur >= HR_HOLD_S:
                peak = max(hrs[s:e + 1])
                ratio = peak / base - 1
                anomalies.append(RawEvent(
                    ts=hr_series[s]["t"], modality="physio",
                    type="生理应激未回落（rPPG-HRV 趋势）",
                    severity="ALERT" if ratio >= 0.25 else "WARN",
                    confidence=round(min(0.95, 0.5 + ratio), 2),
                    deviation=round(ratio, 3),
                    window=(hr_series[s]["t"], hr_series[e]["t"]),
                    metrics={"心率": (round(peak, 1), "bpm")}))

    # ── 落盘 ──
    with open(rppg_dir / "waveform.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["t", "r", "g", "b", "pulse"])
        for i in range(len(pulse)):
            w.writerow([f"{ts_a[i]:.2f}", *(f"{v:.3f}" for v in rgb_a[i]),
                        f"{pulse[i]:.4f}"])
    with open(rppg_dir / "hr_series.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["t", "hr_bpm", "rmssd_ms"])
        for h in hr_series:
            w.writerow([h["t"], h["hr"], h["rmssd"] if h["rmssd"] is not None else ""])

    if not notes:
        notes.append(f"人脸检出率 {face_rate:.0%}，亮度变异系数 {bright_cv:.2f}，"
                     f"HR 基线 {base:.0f} bpm")
    print(f"[rppg] 样本={n} face={face_rate:.0%} bright_cv={bright_cv:.2f} "
          f"HR={min(hrs):.0f}-{max(hrs):.0f}bpm 事件={len(anomalies)}")
    return {"anomalies": anomalies, "quality": quality,
            "quality_note": "；".join(notes), "hr_series": hr_series}
