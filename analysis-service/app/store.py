"""Transactional aggregate repository. PostgreSQL deployment; SQLite isolated tests.

Legacy JSON is imported only by the explicit migration command. A row lock
serializes separate writers; business changes and audit commit together.
"""
from __future__ import annotations
import copy
import hashlib
import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from .config import DATA, DATABASE_URL


def empty_db():
    return dict(sessions=[], reports=[], audit=[], seq=0, users=[], tokens={}, jobs=[],
                runs=[], exports=[], projects=[], idempotency={}, events=[])


class Store:
    def __init__(self, path: Path | None = None, database_url: str | None = None):
        self.lock = threading.RLock()
        self.local = threading.local()
        url = DATABASE_URL if database_url is None else database_url
        self.postgres = bool(url)
        if self.postgres:
            import psycopg
            self.conn = psycopg.connect(url, autocommit=True)
            self.conn.execute("CREATE TABLE IF NOT EXISTS minddialogue_state (id INTEGER PRIMARY KEY, payload JSONB NOT NULL)")
            self.conn.execute("INSERT INTO minddialogue_state VALUES (1, %s::jsonb) ON CONFLICT DO NOTHING", (json.dumps(empty_db()),))
        else:
            target = Path(path) if path else DATA / 'workspace.sqlite3'
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.conn = sqlite3.connect(str(target), check_same_thread=False, isolation_level=None, timeout=30)
            self.conn.execute('PRAGMA journal_mode=WAL')
            self.conn.execute('CREATE TABLE IF NOT EXISTS minddialogue_state (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)')
            self.conn.execute('INSERT OR IGNORE INTO minddialogue_state VALUES (1, ?)', (json.dumps(empty_db()),))

    @contextmanager
    def transaction(self):
        with self.lock:
            if getattr(self.local, 'db', None) is not None:
                yield self.local.db
                return
            self.conn.execute('BEGIN' if self.postgres else 'BEGIN IMMEDIATE')
            try:
                row = self.conn.execute('SELECT payload FROM minddialogue_state WHERE id=1' + (' FOR UPDATE' if self.postgres else '')).fetchone()[0]
                self.local.db = row if isinstance(row, dict) else json.loads(row)
                yield self.local.db
                payload = json.dumps(self.local.db, ensure_ascii=False, allow_nan=False)
                sql = 'UPDATE minddialogue_state SET payload=%s::jsonb WHERE id=1' if self.postgres else 'UPDATE minddialogue_state SET payload=? WHERE id=1'
                self.conn.execute(sql, (payload,))
                self.conn.execute('COMMIT')
            except BaseException:
                self.conn.execute('ROLLBACK')
                raise
            finally:
                self.local.db = None

    @property
    def db(self):
        if getattr(self.local, 'db', None) is not None:
            return self.local.db
        with self.lock:
            row=self.conn.execute('SELECT payload FROM minddialogue_state WHERE id=1').fetchone()[0]
            return copy.deepcopy(row) if isinstance(row,dict) else json.loads(row)

    def audit(self, actor, action, resource):
        with self.transaction() as db:
            seq = db['seq'] = db.get('seq', 0) + 1
            prev = db['audit'][-1]['hash'] if db['audit'] else 'GENESIS'
            ts = round(time.time(), 3)
            raw = f'{seq}|{ts:.3f}|{actor}|{action}|{resource}|{prev}'
            e = dict(seq=seq, ts=ts, actor=actor, action=action, resource=resource,
                     prev_hash=prev, hash=hashlib.sha256(raw.encode()).hexdigest())
            db['audit'].append(e)
            return copy.deepcopy(e)

    def verify_chain(self):
        snapshot=self.db
        prev = 'GENESIS'
        for e in snapshot['audit']:
            raw = f"{e['seq']}|{e['ts']:.3f}|{e['actor']}|{e['action']}|{e['resource']}|{prev}"
            if e['prev_hash'] != prev or hashlib.sha256(raw.encode()).hexdigest() != e['hash']:
                return False
            prev = e['hash']
        return len(snapshot['audit'])==snapshot.get('seq',0)

    def collection(self, name): return copy.deepcopy(self.db.get(name, []))
    def get(self, name, identifier): return next((x for x in self.collection(name) if x['id'] == identifier), None)
    def put(self, name, record):
        with self.transaction() as db:
            xs = db.setdefault(name, [])
            i = next((i for i, x in enumerate(xs) if x['id'] == record['id']), None)
            if i is None: xs.append(copy.deepcopy(record))
            else: xs[i] = copy.deepcopy(record)
    def sessions(self): return self.collection('sessions')
    def reports(self): return self.collection('reports')
    def get_session(self, sid): return self.get('sessions', sid)
    def get_report(self, rid): return self.get('reports', rid)
    def upsert_session(self, session): self.put('sessions', session)
    def upsert_report(self, report): self.put('reports', report)
