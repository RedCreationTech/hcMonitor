"""真实链路自测：preprocess → speech → acoustic → semantic（直接 .venv/bin/python 运行）。

样例：prototype-lite/public/demo/谈话录音_音频样例_156s.m4a（156s 中文双人对话）。
中间产物落盘 data/artifacts/selftest/<modality>/，可出示取证。
"""
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.pipeline.preprocess import audio_to_wav          # noqa: E402
from app.pipeline import speech, acoustic, semantic       # noqa: E402

DEMO = ROOT.parent / "prototype-lite" / "public" / "demo" / "谈话录音_音频样例_156s.m4a"
OUT = ROOT / "data" / "artifacts" / "selftest"


def main() -> None:
    t_all = time.time()
    t0 = time.time()
    wav = audio_to_wav(DEMO)
    print(f"[1/4 preprocess] {DEMO.name} → {wav.name}  耗时 {time.time() - t0:.1f}s")

    t0 = time.time()
    sp = speech.run(wav, OUT)
    turns = sp["turns"]
    ok = sum(1 for t in turns if t["diar_state"] == "ok")
    speakers = sorted({t["speaker"] for t in turns})
    print(f"[2/4 speech] turns={len(turns)}  分角色绑定 ok={ok}/{len(turns)}"
          f"  说话人={speakers}  耗时 {time.time() - t0:.1f}s")
    for t in turns[:3]:
        print(f"    ts={t['ts']:7.2f}s speaker={t['speaker']:11s} "
              f"rate={t['speech_rate']} conf={t['diar_confidence']}  {t['text'][:38]}")

    t0 = time.time()
    ac = acoustic.run(wav, turns, OUT)
    sev = {}
    for e in ac["anomalies"]:
        sev[e.severity] = sev.get(e.severity, 0) + 1
    n_csv = sum(1 for _ in (OUT / "acoustic" / "features.csv").open()) - 1
    print(f"[3/4 acoustic] events={len(ac['anomalies'])} {sev}  features.csv 行数={n_csv}"
          f"  耗时 {time.time() - t0:.1f}s")

    t0 = time.time()
    se = semantic.run(turns, OUT)
    print(f"[4/4 semantic] 话题数={len(se['impacts'])}  矛盾对数={len(se['anomalies'])}"
          f"  耗时 {time.time() - t0:.1f}s")
    for im in se["impacts"]:
        print(f"    {im['topic_id']} {im['label']:<16s} score={im['impact_score']}"
              f" boundary={im['boundary']} dims={im['dims']}")

    print(f"[done] 全链耗时 {time.time() - t_all:.1f}s  产物目录 {OUT}")


if __name__ == "__main__":
    main()
