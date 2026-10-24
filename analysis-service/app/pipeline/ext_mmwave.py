"""毫米波采样序列真实解析（表头感知）。

商用模组/网关导出件形态（如样例 mmwave_resp_152s.csv）：
    t_s, resp_bpm, hr_bpm, motion_mm      # 1Hz 遥测，已含呼吸率/心率/体动
处理：逐通道基线（前 20% 中位数）→ 峰值/峰值时刻/末段/趋势序列；
体动列超阈值的区段标质量降级。若导出件是无表头的原始波形，退回包络趋势（不估心率）。
结论封顶 cap_note：不进升级、不出心理归因。
"""
from __future__ import annotations

import csv
from pathlib import Path

import numpy as np

from ..config import CAP_NOTE
from .events import RawEvent

MOTION_DEGRADE = 8.0          # mm，体动超此值区段降级


def _load(csv_path: Path) -> tuple[dict[str, np.ndarray], float]:
    with open(csv_path, newline="", encoding="utf-8", errors="ignore") as f:
        rows = [r for r in csv.reader(f) if r]
    header = None
    start = 0
    if rows and not _num(rows[0][0]):
        header = [c.strip() for c in rows[0]]
        start = 1
    data = []
    for r in rows[start:]:
        try:
            data.append([float(c) for c in r if c.strip() != ""])
        except ValueError:
            continue
    mat = np.asarray(data)
    if header and len(header) == mat.shape[1]:
        cols = {h: mat[:, i] for i, h in enumerate(header)}
    else:
        cols = {f"col{i}": mat[:, i] for i in range(mat.shape[1])}
    t = cols.get("t_s", cols.get("time", np.arange(len(mat))))
    duration = float(t[-1] - t[0]) if len(t) > 1 and t[-1] > t[0] else float(len(mat))
    return cols, duration


def _num(s: str) -> bool:
    try:
        float(s)
        return True
    except ValueError:
        return False


def _metric(name: str, unit: str, decimals: int, series: np.ndarray,
            degraded_mask: np.ndarray | None = None) -> dict:
    s = series.astype(float)
    base = float(np.median(s[: max(1, len(s) // 5)]))
    usable = s if degraded_mask is None else s[~degraded_mask]
    if len(usable) == 0:
        usable = s
    peak_i = int(np.argmax(np.abs(usable - base)))
    idx = np.arange(len(s))
    if degraded_mask is not None:
        real_i = idx[~degraded_mask][peak_i]
    else:
        real_i = peak_i
    return {
        "name": name, "unit": unit, "decimals": decimals,
        "baseline": round(base, decimals),
        "peak": round(float(s[real_i]), decimals),
        "peak_ts": round(float(real_i), 1),
        "end_value": round(float(s[-1]), decimals),
        "series": [round(float(v), decimals) for v in s],
    }


def run(csv_path: Path, out_dir: Path, asset_id: str | None = None) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    cols, duration = _load(csv_path)
    n = len(next(iter(cols.values())))
    if n < 30:
        raise ValueError(f"毫米波序列有效行数不足：{n}")

    motion = cols.get("motion_mm")
    degraded = motion > MOTION_DEGRADE if motion is not None else None
    quality = "degraded" if (degraded is not None and degraded.mean() > 0.2) else "ok"

    metrics = []
    if "resp_bpm" in cols:
        metrics.append(_metric("呼吸率", "次/分", 1, cols["resp_bpm"], degraded))
    if "hr_bpm" in cols:
        metrics.append(_metric("心率", "次/分", 1, cols["hr_bpm"], degraded))
    if not metrics:                                  # 原始波形退回：包络趋势，不估心率
        raw = next(iter(cols.values()))
        env = np.abs(raw - np.median(raw))
        win = max(5, n // 150)
        env = np.convolve(env, np.ones(win) / win, mode="same")[::win]
        env = env / (np.median(env[: max(1, len(env) // 5)]) or 1)
        metrics.append(_metric("呼吸波形包络(归一)", "×基线", 2, env))

    trend = {
        "sensor_label": "毫米波雷达（60GHz 文件级导入）",
        "samples": int(n),
        "time_base": "素材登记时长",
        "metrics": metrics,
        "limits": [
            "文件级导入：无个体静息标定，基线取序列前 20% 中位数，只报相对趋势",
            "体动是主要退化源：motion_mm 均值超阈值的区段已在质量门中降级，不给升级",
            "硬件在线接入、时钟同步属后续项（接口契约见需求 06 文档）",
        ],
    }

    out_csv = out_dir / "mmwave_telemetry.csv"
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        names = list(cols.keys())
        w.writerow(names)
        for i in range(n):
            w.writerow([round(cols[k][i], 3) for k in names])

    events: list[RawEvent] = []
    for m in metrics[:2]:
        base, peak = m["baseline"], m["peak"]
        if base > 0 and abs(peak - base) / base >= 0.25:
            direction = "升高" if peak > base else "下降"
            events.append(RawEvent(
                ts=float(m["peak_ts"]), modality="physio",
                type=f"生理指标异常（{m['name']}{direction}未回落）",
                severity="ALERT", confidence=0.6,
                deviation=round(abs(peak - base) / base, 2),
                window=(max(0.0, m["peak_ts"] - 20), float(m["peak_ts"])),
                metrics={m["name"]: (f"{m['baseline']}→{m['peak']}", m["unit"])},
                asset_id=asset_id, cap_note=CAP_NOTE,
            ))

    return {"trend": trend, "anomalies": events, "quality": quality,
            "duration_seconds": round(duration), "samples": int(n)}
