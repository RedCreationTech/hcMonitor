"""vision + rppg 真实样例自测。

样例：prototype-lite/public/demo/询问谈话_录像样例_156s.mp4（156s 谈话人坐姿）。
跑通两个模块，报告处理帧数/耗时、各通道事件、质量门、HR 数值范围，
并把一条 RawEvent 完整字段打印出来供契约对账。
"""
from __future__ import annotations

import json
import sys
import time
from dataclasses import asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from app.config import ARTIFACTS            # noqa: E402
from app.pipeline import rppg, vision       # noqa: E402

VIDEO = ROOT.parent / "prototype-lite" / "public" / "demo" / "询问谈话_录像样例_156s.mp4"
OUT = ARTIFACTS / "selftest-vision-rppg"


def main() -> None:
    print(f"样例视频: {VIDEO}")
    print(f"产物目录: {OUT}")

    t0 = time.time()
    v = vision.run(VIDEO, OUT)
    t_vision = time.time() - t0

    t0 = time.time()
    r = rppg.run(VIDEO, OUT)
    t_rppg = time.time() - t0

    print("\n===== vision =====")
    print(f"耗时 {t_vision:.1f}s | 质量 {v['quality']} | {v['quality_note']}")
    print(f"modality_available: {v['modality_available']}")
    by_mod: dict[str, int] = {}
    for e in v["anomalies"]:
        by_mod[e.modality] = by_mod.get(e.modality, 0) + 1
        print(f"  [{e.modality}] {e.severity} ts={e.ts:.1f}s {e.type} "
              f"conf={e.confidence} dev={e.deviation} window={e.window} metrics={e.metrics}")
    print(f"事件计数: {by_mod}（共 {len(v['anomalies'])} 条）")

    print("\n===== rppg =====")
    print(f"耗时 {t_rppg:.1f}s | 质量 {r['quality']} | {r['quality_note']}")
    hrs = [h["hr"] for h in r["hr_series"]]
    if hrs:
        print(f"hr_series: {len(hrs)} 窗, {min(hrs):.1f}-{max(hrs):.1f} bpm, "
              f"中位 {sorted(hrs)[len(hrs)//2]:.1f} bpm")
        print(f"前 10 窗: {[(h['t'], h['hr']) for h in r['hr_series'][:10]]}")
    for e in r["anomalies"]:
        print(f"  [{e.modality}] {e.severity} ts={e.ts:.1f}s {e.type} "
              f"conf={e.confidence} dev={e.deviation} window={e.window} metrics={e.metrics}")

    print("\n===== RawEvent 样例（完整字段）=====")
    sample = (v["anomalies"] + r["anomalies"])[0] if (v["anomalies"] + r["anomalies"]) else None
    print(json.dumps(asdict(sample), ensure_ascii=False, indent=2) if sample else "无事件")
    print("\n落盘文件:")
    for p in sorted(OUT.rglob("*.csv")):
        print(f"  {p.relative_to(OUT)} ({p.stat().st_size} B)")


if __name__ == "__main__":
    main()
