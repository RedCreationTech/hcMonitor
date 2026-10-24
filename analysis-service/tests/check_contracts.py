"""契约校验：selftest 产物必须能装进 contracts.py 的 pydantic 模型。"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.contracts import DialogueTurn, ImpactEvent   # noqa: E402
from app.pipeline.events import RawEvent              # noqa: E402

ART = ROOT / "data" / "artifacts" / "selftest"

turns = json.loads((ART / "speech" / "turns.json").read_text("utf-8"))
for t in turns:
    DialogueTurn(**t)
print(f"DialogueTurn 校验通过 × {len(turns)}")

topics = json.loads((ART / "semantic" / "topics.json").read_text("utf-8"))
for tp in topics["topics"]:
    ImpactEvent(**{k: tp[k] for k in
                   ("event", "ts", "topic_id", "boundary", "label",
                    "impact_score", "dims", "rationale_text", "boundary_evidence")})
print(f"ImpactEvent 校验通过 × {len(topics['topics'])}")

ev = json.loads((ART / "acoustic" / "events.json").read_text("utf-8"))
for e in ev["events"]:
    RawEvent(**{k: v for k, v in e.items() if k in RawEvent.__dataclass_fields__})
print(f"RawEvent(acoustic) 校验通过 × {len(ev['events'])}")

cs = json.loads((ART / "semantic" / "contradictions.json").read_text("utf-8"))
print(f"contradictions.json × {len(cs)}  相邻句相似度={topics['adjacent_sims'][:6]}")
print("契约校验全部通过")
