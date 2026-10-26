"""近红外 fNIRS 文件级解析（表头感知）。

厂商导出件形态（如样例 nir_hbo_152s.csv）：
    t_s, hbo_mmol_mm_L, hbr_mmol_mm_L, head_motion_pct   # 1Hz，MBLL 已由厂商完成
处理：去线性漂移 → 相对基线 z 分数 → HbO/HbR 双通道趋势；头动列超阈值区段质量降级。
只报趋势，不进心理归因（cap_note 封顶）。
"""
from __future__ import annotations

import csv
from pathlib import Path

import numpy as np
from scipy.signal import butter, filtfilt

from ..config import CAP_NOTE
from .events import RawEvent

MOTION_DEGRADE = 15.0         # head_motion_pct 超此值降级


from .series import load as _load


def _z_series(x: np.ndarray, fs: float, degraded: np.ndarray | None) -> tuple[np.ndarray, int]:
    if degraded is not None and degraded.all(): raise ValueError("全部采样质量不合格，拒绝提取峰值")
    b, a = butter(2, 0.01 / (fs / 2), btype="high")
    xh = filtfilt(b, a, x)
    head = xh[: max(1, len(xh) // 5)]
    if degraded is not None: head=head[~degraded[:len(head)]]
    if len(head)<3 or float(np.std(head))<1e-9: raise ValueError("基线有效样本不足或无变化，拒绝归一化")
    base, scale = float(np.median(head)), float(np.std(head))
    z = (xh - base) / scale
    usable = z if degraded is None else z[~degraded]
    if not len(usable): raise ValueError("全部采样质量不合格，拒绝提取峰值")
    peak_i = int(np.argmax(np.abs(usable)))
    if degraded is not None:
        idx = np.arange(len(z))
        peak_i = int(idx[~degraded][peak_i])
    return z, peak_i


def run(csv_path: Path, out_dir: Path, asset_id: str | None = None) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    cols, duration = _load(csv_path)
    n = len(next(iter(cols.values())))
    if n < 30:
        raise ValueError(f"fNIRS 序列有效行数不足：{n}")
    fs = (n-1) / max(duration, 1e-6)

    motion = cols.get("head_motion_pct")
    degraded = motion > MOTION_DEGRADE if motion is not None else None
    quality = "degraded" if (degraded is not None and degraded.mean() > 0.2) else "ok"

    metrics = []
    for col, label in (("hbo_mmol_mm_L", "HbO"), ("hbr_mmol_mm_L", "HbR")):
        if col not in cols:
            continue
        z, peak_i = _z_series(cols[col], fs, degraded)
        step = max(1, n // 300)
        metrics.append({
            "name": f"前额叶 {label}（基线 z 分数）",
            "unit": "z", "decimals": 2,
            "baseline": 0.0,
            "peak": round(float(z[peak_i]), 2),
            "peak_ts": round(peak_i / fs, 1),
            "end_value": round(float(z[-1]), 2),
            "series": [round(float(v), 2) for v in z[::step]],
        })
    if not metrics:                                  # 无表头：第一数值列兜底
        z, peak_i = _z_series(next((v for k, v in cols.items() if k not in ("t_s", "time")), np.array([])), fs, degraded)
        metrics.append({
            "name": "通道1（基线 z 分数）", "unit": "z", "decimals": 2,
            "baseline": 0.0, "peak": round(float(z[peak_i]), 2),
            "peak_ts": round(peak_i / fs, 1), "end_value": round(float(z[-1]), 2),
            "series": [round(float(v), 2) for v in z[:: max(1, n // 300)]],
        })

    trend = {
        "sensor_label": "近红外 fNIRS（HbO/HbR 文件级导入）",
        "samples": int(n),
        "time_base": "素材登记时长",
        "metrics": metrics,
        "limits": [
            "文件级导入：MBLL 已由厂商导出完成，本模块只做漂移校正与趋势提取",
            "头动超阈值区段已质量降级；血氧响应滞后生理事件 4-6s",
            "认知负荷的 fNIRS 解释需个体标定与任务范式：结论封顶生理趋势层，不作心理归因",
        ],
    }

    with open(out_dir / "nir_telemetry.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        names = list(cols.keys())
        w.writerow(names)
        for i in range(n):
            w.writerow([round(cols[k][i], 4) for k in names])

    events: list[RawEvent] = []
    m0 = metrics[0]
    if abs(m0["peak"]) >= 2.0:
        events.append(RawEvent(
            ts=float(m0["peak_ts"]), modality="physio",
            type="生理指标异常（HbO 偏离基线）",
            severity="ALERT", confidence=0.55,
            deviation=abs(m0["peak"]),
            window=(max(0.0, m0["peak_ts"] - 20), float(m0["peak_ts"])),
            metrics={"HbO z 偏移": (m0["peak"], "z")},
            asset_id=asset_id, cap_note=CAP_NOTE,
        ))
    return {"trend": trend, "anomalies": events, "quality": quality,
            "duration_seconds": round(duration), "samples": int(n)}
