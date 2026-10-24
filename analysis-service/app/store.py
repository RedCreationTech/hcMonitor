"""状态库：JSON 文件持久化 + R6 审计哈希链。

hash = sha256(seq|ts|actor|action|resource|prev_hash)，抽改任一条其后全部断裂。
与 mock 引擎同口径，导出件 audit_seq 对账读这里。
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from pathlib import Path

from .config import STORE, DATA


class Store:
    def __init__(self, path: Path = STORE):
        self.path = path
        self.lock = threading.RLock()
        DATA.mkdir(parents=True, exist_ok=True)
        if path.exists():
            self.db = json.loads(path.read_text("utf-8"))
        else:
            self.db = {"sessions": [], "reports": [], "audit": [], "seq": 0,
                       "exports": 0}
            self._save()

    def _save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.db, ensure_ascii=False, indent=1), "utf-8")
        tmp.replace(self.path)

    # ── 审计链 ────────────────────────────────────────────────────
    def audit(self, actor: str, action: str, resource: str) -> dict:
        with self.lock:
            self.db["seq"] += 1
            seq = self.db["seq"]
            prev = self.db["audit"][-1]["hash"] if self.db["audit"] else "GENESIS"
            now = time.time()
            raw = f"{seq}|{now:.3f}|{actor}|{action}|{resource}|{prev}"
            h = hashlib.sha256(raw.encode()).hexdigest()
            entry = {"seq": seq, "ts": round(now, 3), "actor": actor,
                     "action": action, "resource": resource,
                     "prev_hash": prev, "hash": h}
            self.db["audit"].append(entry)
            self._save()
            return entry

    def verify_chain(self) -> bool:
        prev = "GENESIS"
        for e in self.db["audit"]:
            raw = f"{e['seq']}|{e['ts']:.3f}|{e['actor']}|{e['action']}|{e['resource']}|{prev}"
            if e["prev_hash"] != prev or hashlib.sha256(raw.encode()).hexdigest() != e["hash"]:
                return False
            prev = e["hash"]
        return True

    # ── 会话 / 报告 ───────────────────────────────────────────────
    def sessions(self) -> list[dict]:
        with self.lock:
            return json.loads(json.dumps(self.db["sessions"]))

    def reports(self) -> list[dict]:
        with self.lock:
            return json.loads(json.dumps(self.db["reports"]))

    def get_session(self, sid: str) -> dict | None:
        return next((s for s in self.sessions() if s["id"] == sid), None)

    def get_report(self, rid: str) -> dict | None:
        return next((r for r in self.reports() if r["id"] == rid), None)

    def upsert_session(self, session: dict):
        with self.lock:
            xs = self.db["sessions"]
            for i, s in enumerate(xs):
                if s["id"] == session["id"]:
                    xs[i] = session
                    break
            else:
                xs.append(session)
            self._save()

    def upsert_report(self, report: dict):
        with self.lock:
            xs = self.db["reports"]
            for i, r in enumerate(xs):
                if r["id"] == report["id"]:
                    xs[i] = report
                    break
            else:
                xs.append(report)
            self._save()
