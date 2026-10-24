"""视觉行为分析：FaceMesh（AU 代理/头部姿态）+ Pose（躯干/肩线）+ Hands（适应性动作）。

小脸对策：样例视频中人脸约占帧宽 15%，FaceMesh 全帧直检近乎全灭（实测 0/50）；
改由 Pose 头部特征点定位 ROI、3x 立方放大后送 FaceMesh（实测片段检出率约 81%）。
质量门：SEG_S 秒片段人脸检出率 < 60% → 该片段标 degraded，不进任何判定。
CPU 纯跑（Intel Mac）：OpenCV/BLAS 线程封顶 4。
"""
from __future__ import annotations

import csv
import os
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "4")        # 纯 CPU：线程封顶 4
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")

import cv2
import numpy as np
import mediapipe as mp

from ..config import VIDEO_FPS
from .events import RawEvent

FPS = VIDEO_FPS
SEG_S = 5.0                 # 质量门片段长度（秒）
FACE_RATE_MIN = 0.6         # 片段人脸检出率下限
AU_ONSET = 0.3              # AU4+AU7 触发阈值
AU_FLASH_MIN_S = 0.04       # 闪现持续下限 40ms（@25fps = 1 帧）
AU_FLASH_MAX_S = 0.5        # 闪现持续上限 500ms
BASELINE_FRAC = 0.2         # 个体基线 = 会话前 20%
POSE_SIGMA = 2.0            # 离开基线带（±2σ）判定阈值
POSE_HOLD_S = 3.0           # 姿态偏离持续阈值
POSE_SD_FLOOR = 1.0         # 基线 σ 下限（度），静止场景防过触发
HAND_EVERY = 3              # 手部每 3 帧跑一次（省 CPU）
HAND_HOLD_S = 1.0           # 适应性动作单次最短持续
HAND_RATE_Z = 2.0           # 动作频次相对基线 z 阈值

# FaceMesh 特征点（468 网格）
_PT_BROW, _PT_LID = (105, 334), (159, 386)      # 眉部 / 上眼睑（左右）
_PT_LID_LO = (145, 374)                          # 下眼睑（左右）
_PT_EYE_OUT, _PT_EYE_IN = (33, 263), (133, 362)  # 眼角（外/内，左右）
_PT_NOSE, _PT_CHIN = 4, 152
_PT_MOUTH = (61, 291)
_HEAD_POSE_IDX = (_PT_NOSE, _PT_CHIN) + _PT_EYE_OUT + _PT_MOUTH
_HEAD_POSE_3D = np.array([                        # 简化人脸模型（mm，OpenCV 教程口径）
    (0.0, 0.0, 0.0),        # 鼻尖
    (0.0, -330.0, -65.0),   # 下巴
    (-225.0, 170.0, -135.0), (225.0, 170.0, -135.0),   # 眼外角（图左/图右）
    (-150.0, -150.0, -125.0), (150.0, -150.0, -125.0),  # 嘴角
], dtype=np.float64)

# solvePnP 在 ROI 裁剪图上做：焦距按裁剪图尺寸近似即可（欧拉角只看相对变化）


def _head_crop(frame: np.ndarray, pose_lm) -> tuple | None:
    """Pose 头部特征点 → 头 ROI：返回 (x0, y0, 放大后的裁剪图)。"""
    h, w = frame.shape[:2]
    xs = [pose_lm[i].x for i in (0, 2, 5, 7, 8)]   # 鼻子/双眼/双耳
    ys = [pose_lm[i].y for i in (0, 2, 5, 7, 8)]
    cx, cy = float(np.mean(xs)), float(np.mean(ys))
    bw = max(max(xs) - min(xs), 1e-3)
    bh = max(max(ys) - min(ys), 1e-3)
    x0 = int(max(0, (cx - bw * 1.6) * w))
    x1 = int(min(w, (cx + bw * 1.6) * w))
    y0 = int(max(0, (cy - bh * 2.4) * h))
    y1 = int(min(h, (cy + bh * 2.8) * h))
    if x1 - x0 < 24 or y1 - y0 < 24:
        return None
    crop = cv2.resize(frame[y0:y1, x0:x1], None, fx=3, fy=3,
                      interpolation=cv2.INTER_CUBIC)
    return x0, y0, crop


def _head_pose(pts: np.ndarray, cw: int, ch: int) -> tuple[float, float, float]:
    """6 点 solvePnP → (pitch, yaw, roll) 欧拉角（度）；失败返回 NaN。"""
    f = 1.2 * cw
    k = np.array([[f, 0, cw / 2], [0, f, ch / 2], [0, 0, 1]], dtype=np.float64)
    try:
        _, rvec, _ = cv2.solvePnP(_HEAD_POSE_3D, pts.astype(np.float64), k, None,
                                  flags=cv2.SOLVEPNP_ITERATIVE)
        rot, _ = cv2.Rodrigues(rvec)
        (pitch, yaw, roll), _ = cv2.RQDecomp3x3(rot)
        return float(pitch), float(yaw), float(roll)
    except cv2.error:
        return float("nan"), float("nan"), float("nan")


def _face_metrics(lm, cw: int, ch: int):
    """单帧 FaceMesh 结果 → AU 原始量（眉-睑距/眼开合度，裁剪图像素）+ 欧拉角。"""
    p = np.array([[lm[i].x * cw, lm[i].y * ch] for i in range(468)], dtype=np.float64)
    eye_w = (np.linalg.norm(p[_PT_EYE_OUT[0]] - p[_PT_EYE_IN[0]]) +
             np.linalg.norm(p[_PT_EYE_OUT[1]] - p[_PT_EYE_IN[1]])) / 2 + 1e-6
    brow_lid = float((np.linalg.norm(p[_PT_BROW[0]] - p[_PT_LID[0]]) +
                      np.linalg.norm(p[_PT_BROW[1]] - p[_PT_LID[1]])) / 2)
    eye_open = float((np.linalg.norm(p[_PT_LID[0]] - p[_PT_LID_LO[0]]) +
                      np.linalg.norm(p[_PT_LID[1]] - p[_PT_LID_LO[1]])) / 2)
    pitch, yaw, roll = _head_pose(p[list(_HEAD_POSE_IDX)], cw, ch)
    # 鼻尖/脸高映射回原图像素（供手部阈值归一化；放大倍数 3）
    nose = (p[_PT_NOSE][0] / 3, p[_PT_NOSE][1] / 3)
    face_h = float(np.linalg.norm(p[_PT_NOSE] - p[_PT_CHIN]) / 3)
    return {"brow_lid": brow_lid / eye_w, "eye_open": eye_open / eye_w,
            "pitch": pitch, "yaw": yaw, "roll": roll, "nose": nose, "face_h": face_h}


def _runs(mask: list[bool], gap_tol: int = 0) -> list[tuple[int, int]]:
    """True 连续段（含间隔容忍），返回 (start, end) 闭区间列表。"""
    runs, s, last = [], None, 0
    for i, v in enumerate(mask):
        if v:
            if s is None:
                s = i
            last = i
        elif s is not None and i - last > gap_tol:
            runs.append((s, last))
            s = None
    if s is not None:
        runs.append((s, last))
    return runs


def run(video_path: Path, out_dir: Path) -> dict:
    """分析整段视频，落盘时序 CSV，返回契约形状字典（含 RawEvent 列表）。"""
    video_path = Path(video_path)
    vis_dir = Path(out_dir) / "vision"
    vis_dir.mkdir(parents=True, exist_ok=True)
    cv2.setNumThreads(4)

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频: {video_path}")
    native_fps = float(cap.get(cv2.CAP_PROP_FPS)) or FPS
    step = max(1, int(round(native_fps / FPS)))      # 目标 25fps 抽帧

    fm = mp.solutions.face_mesh.FaceMesh(
        refine_landmarks=True, max_num_faces=1,
        min_detection_confidence=0.3, min_tracking_confidence=0.3)
    pose = mp.solutions.pose.Pose(
        model_complexity=0, min_detection_confidence=0.5, min_tracking_confidence=0.5)
    hands = mp.solutions.hands.Hands(
        max_num_hands=2, model_complexity=0,
        min_detection_confidence=0.5, min_tracking_confidence=0.5)

    ts: list[float] = []
    faces: list[dict | None] = []     # AU 原始量 + 欧拉角（裁剪图坐标系）
    poses: list[tuple[float, float] | None] = []   # (后仰角, 肩线偏航)
    hand_t: list[float] = []
    hand_sig: list[tuple[bool, bool, float]] = []  # (手近脸, 双手互搓, 掌距px)

    idx = -1
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        idx += 1
        if idx % step:
            continue
        t = idx / native_fps
        ts.append(t)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        # ── Pose（全身，顺带供 FaceMesh 定位）──
        rp = pose.process(rgb)
        lean = tilt = None
        face = None
        if rp.pose_landmarks:
            pl = rp.pose_landmarks.landmark
            vis = [getattr(pl[i], "visibility", 1.0) or 0.0 for i in (11, 12, 23, 24)]
            h, w = frame.shape[:2]
            if min(vis) > 0.3:
                sh_c = np.array([(pl[11].x + pl[12].x) / 2 * w, (pl[11].y + pl[12].y) / 2 * h])
                hip_c = np.array([(pl[23].x + pl[24].x) / 2 * w, (pl[23].y + pl[24].y) / 2 * h])
                d = sh_c - hip_c
                lean = float(np.degrees(np.arctan2(d[0], -d[1])))          # 0=直立
                tilt = float(np.degrees(np.arctan2((pl[12].y - pl[11].y) * h,
                                                   (pl[12].x - pl[11].x) * w)))  # 肩线-水平
                # ── FaceMesh（Pose 头 ROI 放大后送入）──
                hc = _head_crop(frame, pl)
                if hc:
                    x0, y0, crop = hc
                    rf = fm.process(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
                    if rf.multi_face_landmarks:
                        m = _face_metrics(rf.multi_face_landmarks[0].landmark,
                                          crop.shape[1], crop.shape[0])
                        m["nose"] = (m["nose"][0] + x0, m["nose"][1] + y0)
                        face = m
        poses.append((lean, tilt) if lean is not None else None)
        faces.append(face)

        # ── Hands（每 3 帧一次）──
        if idx % (step * HAND_EVERY) == 0 and face is not None:
            rh = hands.process(rgb)
            hl = rh.multi_hand_landmarks or []
            near = False
            palm_d = float("nan")
            if hl:
                h, w = frame.shape[:2]
                wrists = [np.array([h_.landmark[0].x * w, h_.landmark[0].y * h]) for h_ in hl]
                nose = np.array(face["nose"])
                near = any(np.linalg.norm(wr - nose) < 0.9 * face["face_h"] for wr in wrists)
                if len(hl) >= 2:
                    centers = [np.mean([[l.x * w, l.y * h] for l in h_.landmark], axis=0)
                               for h_ in hl[:2]]
                    palm_d = float(np.linalg.norm(centers[0] - centers[1]))
            hand_t.append(t)
            hand_sig.append((near, False, palm_d))   # 互搓标记二遍扫描时回填

    cap.release()
    n = len(ts)
    fps_eff = n / ts[-1] if n > 1 and ts[-1] > 0 else FPS

    # ── 双手互搓二遍扫描（掌距小 + 相对速度高，连续 ≥1s 记一次）──
    rub_eps: list[tuple[float, float]] = []          # (t_start, t_end)
    if len(hand_sig) >= 2:
        d_prev = None
        vels = []
        for i, (_, _, d) in enumerate(hand_sig):
            if np.isnan(d):
                vels.append(0.0)
                continue
            v = abs(d - d_prev) * fps_eff / HAND_EVERY if d_prev is not None else 0.0
            vels.append(v)
            d_prev = d
        face_h_med = float(np.nanmedian([f["face_h"] for f in faces if f])) if any(faces) else 150.0
        rub_mask = [(not np.isnan(d)) and d < 0.5 * face_h_med and v > 60.0
                    for (_, _, d), v in zip(hand_sig, vels)]
        min_len = max(2, int(HAND_HOLD_S * fps_eff / HAND_EVERY))
        for s, e in _runs(rub_mask, gap_tol=2):
            if e - s + 1 >= min_len:
                rub_eps.append((hand_t[s], hand_t[e]))
                for i in range(s, e + 1):
                    hand_sig[i] = (hand_sig[i][0], True, hand_sig[i][2])

    # 手近脸持续段（≥1s 记一次）
    touch_eps: list[tuple[float, float]] = []
    min_len = max(2, int(HAND_HOLD_S * fps_eff / HAND_EVERY))
    for s, e in _runs([s0 for s0, _, _ in hand_sig], gap_tol=2):
        if e - s + 1 >= min_len:
            touch_eps.append((hand_t[s], hand_t[e]))

    # ── 质量门：SEG_S 片段人脸检出率 < 60% → 片段 degraded ──
    seg_n = max(1, int(round(SEG_S * fps_eff)))
    good_seg: list[bool] = []
    for s in range(0, n, seg_n):
        seg = faces[s:s + seg_n]
        good_seg.extend([np.mean([f is not None for f in seg]) >= FACE_RATE_MIN] * len(seg))
    good_seg = good_seg[:n]
    face_rate = float(np.mean([f is not None for f in faces])) if n else 0.0
    seg_starts = range(0, n, seg_n)
    degraded_segs = [s for s in seg_starts
                     if np.mean([faces[i] is not None for i in range(s, min(s + seg_n, n))]) < FACE_RATE_MIN]
    usable = [i for i in range(n) if good_seg[i]]

    # ── AU4/AU7 代理（相对会话中位数）与闪现事件 ──
    anomalies: list[RawEvent] = []
    brow_vals = [faces[i]["brow_lid"] for i in usable if faces[i]]
    eye_vals = [faces[i]["eye_open"] for i in usable if faces[i]]
    brow_med = float(np.median(brow_vals)) if brow_vals else 0.0
    eye_med = float(np.median(eye_vals)) if eye_vals else 0.0
    brow_med = max(brow_med, 1e-3)
    eye_med = max(eye_med, 1e-3)
    au4 = [max(0.0, 1.0 - f["brow_lid"] / brow_med) if f and good_seg[i] else 0.0
           for i, f in enumerate(faces)]
    au7 = [max(0.0, 1.0 - f["eye_open"] / eye_med) if f and good_seg[i] else 0.0
           for i, f in enumerate(faces)]

    flash_mask = [a4 >= AU_ONSET and a7 >= AU_ONSET for a4, a7 in zip(au4, au7)]
    for s, e in _runs(flash_mask, gap_tol=1):
        dur = (e - s + 1) / fps_eff
        if AU_FLASH_MIN_S <= dur <= AU_FLASH_MAX_S:
            inten = float(np.mean([(au4[i] + au7[i]) / 2 for i in range(s, e + 1)]))
            anomalies.append(RawEvent(
                ts=ts[s], modality="face",
                type="微表情 AU4+AU7 闪现（眉下压+眼睑收紧）",
                severity="WARN", confidence=round(inten, 2),
                deviation=round(inten / AU_ONSET, 2),
                window=(ts[s], ts[e]),
                metrics={"AU4": (round(float(np.mean(au4[s:e + 1])), 2), ""),
                         "AU7": (round(float(np.mean(au7[s:e + 1])), 2), ""),
                         "持续": (round(dur, 2), "s")}))

    # ── Pose：后仰角 / 肩线偏航 离开基线带 ≥2σ 且持续 ≥3s ──
    def _pose_events(vals: list[float | None], name: str, key: str):
        valid = [v for v in vals if v is not None]
        if len(valid) < int(5 * fps_eff):
            return
        n_base = max(int(POSE_HOLD_S * fps_eff), int(len(valid) * BASELINE_FRAC))
        base = [v for v in valid[:n_base]]
        mu, sd = float(np.mean(base)), float(np.std(base))
        sd = max(sd, POSE_SD_FLOOR)
        mask = [(v is not None and abs(v - mu) > POSE_SIGMA * sd) for v in vals]
        for s, e in _runs(mask, gap_tol=int(0.2 * fps_eff)):
            if (e - s + 1) / fps_eff >= POSE_HOLD_S:
                peak_i = max(range(s, e + 1), key=lambda i: abs(vals[i] - mu))
                z = abs(vals[peak_i] - mu) / sd
                yaw = faces[peak_i]["yaw"] if faces[peak_i] else float("nan")
                anomalies.append(RawEvent(
                    ts=ts[s], modality="pose",
                    type="躯干后仰 + 头部回避" if key == "后仰角" else "肩线偏转（法线偏航）",
                    severity="WARN", confidence=round(min(0.95, 0.4 + 0.1 * z), 2),
                    deviation=round(z, 2), window=(ts[s], ts[e]),
                    metrics={key: (round(vals[peak_i], 1), "°"),
                             "偏离基线": (round(z, 1), "σ"),
                             "持续": (round((e - s + 1) / fps_eff, 1), "s"),
                             "头部偏航": (round(yaw, 1) if yaw == yaw else "—", "°")}))

    _pose_events([p[0] if p else None for p in poses], "后仰角", "后仰角")
    _pose_events([p[1] if p else None for p in poses], "肩线偏航", "肩线偏航")

    # ── Hands：适应性动作频次相对基线 z ≥ 2 ──
    eps = sorted([(s, e, "搓手") for s, e in rub_eps] +
                 [(s, e, "手近脸") for s, e in touch_eps])
    if eps:
        t_end = ts[-1]
        t_base = t_end * BASELINE_FRAC
        n_base = sum(1 for s, e, _ in eps if s < t_base)
        n_late = len(eps) - n_base
        t_late = max(t_end - t_base, 1e-3)
        lam = n_base / max(t_base, 1e-3)               # 基线频次（次/秒）
        z = (n_late - lam * t_late) / np.sqrt(lam * t_late + 1e-9)
        if z >= HAND_RATE_Z:
            anomalies.append(RawEvent(
                ts=eps[-1][0], modality="hand",
                type="反复搓手（适应性动作）", severity="WARN",
                confidence=round(min(0.95, 0.5 + 0.1 * z), 2),
                deviation=round(float(z), 2),
                window=(eps[0][0], eps[-1][1]),
                metrics={"动作计数": (len(eps), "次"),
                         "频次": (round(len(eps) / t_end * 60, 1), "次/分"),
                         "相对基线": (round(float(z), 1), "z")}))

    # ── 落盘时序 CSV（取证）──
    with open(vis_dir / "au_series.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["t", "brow_lid_norm", "eye_open_norm", "au4", "au7",
                    "pitch_deg", "yaw_deg", "roll_deg", "face_ok"])
        for i in range(n):
            fc = faces[i]
            w.writerow([f"{ts[i]:.2f}",
                        f"{fc['brow_lid']:.4f}" if fc else "",
                        f"{fc['eye_open']:.4f}" if fc else "",
                        f"{au4[i]:.3f}", f"{au7[i]:.3f}",
                        f"{fc['pitch']:.1f}" if fc else "",
                        f"{fc['yaw']:.1f}" if fc else "",
                        f"{fc['roll']:.1f}" if fc else "",
                        1 if fc else 0])
    with open(vis_dir / "pose_series.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["t", "lean_deg", "shoulder_tilt_deg", "pose_ok"])
        for i, p in enumerate(poses):
            w.writerow([f"{ts[i]:.2f}",
                        f"{p[0]:.2f}" if p else "", f"{p[1]:.2f}" if p else "",
                        1 if p else 0])
    with open(vis_dir / "hand_events.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["t_start", "t_end", "kind", "dur_s"])
        for s, e, kind in eps:
            w.writerow([f"{s:.2f}", f"{e:.2f}", kind, f"{e - s:.2f}"])

    # ── 质量结论 ──
    pose_rate = float(np.mean([p is not None for p in poses])) if n else 0.0
    modality_available = []
    if face_rate >= FACE_RATE_MIN:
        modality_available.append("face")
    if pose_rate >= 0.5:
        modality_available.append("pose")
    modality_available.append("hand")
    quality = "ok" if (not degraded_segs and face_rate >= 0.8) else "degraded"
    notes = [f"人脸检出率 {face_rate:.0%}（阈值 {FACE_RATE_MIN:.0%}）",
             f"Pose 检出率 {pose_rate:.0%}"]
    if degraded_segs:
        notes.append(f"degraded 片段 {len(degraded_segs)} 段，首段起于 "
                     f"{degraded_segs[0] / fps_eff:.0f}s，已剔除出判定")
    if face_rate < FACE_RATE_MIN:
        notes.append("人脸模态不可用（整体检出率过低）")
    for cl in (fm, pose, hands):
        cl.close()

    print(f"[vision] 帧数={n} 时长={ts[-1]:.1f}s face={face_rate:.0%} pose={pose_rate:.0%} "
          f"事件={len(anomalies)}")
    return {"anomalies": sorted(anomalies, key=lambda e: e.ts),
            "modality_available": modality_available,
            "quality": quality, "quality_note": "；".join(notes)}
