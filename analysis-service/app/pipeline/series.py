import csv
from pathlib import Path
import numpy as np


def load(path: Path):
    with path.open(encoding="utf-8-sig", newline="") as f:
        sample = f.read(4096); f.seek(0)
        try: dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error: dialect = csv.excel
        rows = [r for r in csv.reader(f, dialect) if any(c.strip() for c in r)]
    if not rows: raise ValueError("空采样文件")
    try: float(rows[0][0]); header = None
    except ValueError: header = [c.strip() for c in rows.pop(0)]
    try: mat = np.asarray([[float(c) for c in r] for r in rows], dtype=float)
    except (ValueError, TypeError): raise ValueError("采样行长度不一致或含非数值")
    if mat.ndim != 2 or not mat.size or not np.isfinite(mat).all():
        raise ValueError("采样数据为空或包含非有限数值")
    if header and (len(set(header)) != len(header) or len(header) != mat.shape[1]):
        raise ValueError("采样表头不一致")
    cols = {(header[i] if header else f"col{i}"): mat[:, i] for i in range(mat.shape[1])}
    time = cols.get("t_s", cols.get("time"))
    if time is None: raise ValueError("采样文件必须提供 t_s 或 time 秒时基")
    if time[0] < 0 or len(time) < 2 or not (np.diff(time) > 0).all():
        raise ValueError("秒时基必须非负且严格递增")
    step=np.diff(time);median=float(np.median(step))
    if np.max(np.abs(step-median))>max(1e-6,median*.05):raise ValueError("采样时基不均匀或有缺口，请导入等间隔采样序列")
    return cols, float(time[-1] - time[0])
