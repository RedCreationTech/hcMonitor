"""Freeze loaded model files for a process lifetime; never hot-swap evidence inputs."""
import hashlib
import json
from pathlib import Path
import threading
from .config import MODELS,LLM_PATH,ROOT

_lock=threading.Lock();_inventory=None;_signature=None

def frozen_inventory():
    global _inventory,_signature
    with _lock:
        candidates=sorted({p for p in MODELS.rglob('*') if p.is_file() and p.suffix.lower() in ('.pt','.bin','.safetensors','.gguf','.json','.yaml','.model','.txt') and '.cache' not in p.parts})
        candidates += [ROOT/'rules/rules.yaml',ROOT.parent/'fonts/chinese.ttf']
        signature=[(str(p),p.stat().st_size,p.stat().st_mtime_ns) for p in candidates]
        if _inventory is not None:
            if signature!=_signature:raise ValueError('模型、规则或字体文件已变化，禁止运行中热换；请验证离线包并重启')
            return _inventory
        items=[]
        for p in candidates:
            h=hashlib.sha256()
            with p.open('rb') as f:
                for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
            items.append(dict(path=str(p.relative_to(MODELS)) if MODELS in p.parents else str(p.relative_to(ROOT.parent)),bytes=p.stat().st_size,sha256=h.hexdigest()))
        expected=ROOT.parent/'model-manifest.json'
        if expected.is_file() and json.loads(expected.read_text('utf-8'))!=items:
            raise ValueError('固定模型包、规则或字体hash与发布清单不一致')
        _signature=signature;_inventory=items;return items
