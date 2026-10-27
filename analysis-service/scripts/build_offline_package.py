"""Assemble the already-tested exact native runtime, wheels, models and compiled UI."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

root=Path(__file__).resolve().parents[1];repo=root.parent

def link_or_copy(src,dst):
    try:os.link(src,dst)
    except OSError:shutil.copy2(src,dst)
    return dst

def build(target):
    target=Path(target).resolve()
    if target.exists():raise ValueError('目标已存在，拒绝覆盖')
    target.mkdir(parents=True)
    shutil.copytree(root/'data/offline-runtime-pg',target/'runtime',symlinks=True)
    shutil.copytree(root/'data/offline-wheels-exact',target/'wheels',copy_function=link_or_copy)
    server=target/'analysis-service';server.mkdir()
    for folder in ('app','fonts','scripts'):
        shutil.copytree(root/folder,server/folder,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    for name in ('manage.py','README.md','requirements.txt','requirements-macos-x86_64.lock','model-manifest.json','postgres-source.json','ffmpeg-source.json'):
        shutil.copy2(root/name,server/name)
    shutil.copytree(root/'models',server/'models',copy_function=link_or_copy,ignore=shutil.ignore_patterns('*.partial','.DS_Store'))
    shutil.copytree(repo/'prototype-lite/dist',target/'prototype-lite/dist')
    for name in ('package.json','package-lock.json'):
        shutil.copy2(repo/'prototype-lite'/name,target/'prototype-lite'/name)
    (target/'docs').mkdir()
    for name in ('M1人工复测执行说明.md','M1架构与实施对照.md','M1自测报告.md','M1实施记录.md','暂停录制分段分析方案.md'):
        shutil.copy2(repo/'docs'/name,target/'docs'/name)
    shutil.copy2(repo/'README.md',target/'README.md')
    (target/'fixtures').mkdir();shutil.copy2(root/'data/uploads/SES-20261024-001/谈话录音_音频样例_156s.m4a',target/'fixtures/demo-audio.m4a')
    (server/'data').mkdir();(target/'scripts').mkdir();shutil.copy2(root/'scripts/install_offline.py',target/'scripts/install_offline.py')
    for name,body in {'install.command':'''#!/bin/zsh
set -e
cd "$(dirname "$0")"
export DYLD_LIBRARY_PATH="$PWD/runtime/lib"
exec "$PWD/runtime/python/bin/python3.11" "$PWD/scripts/install_offline.py"
''','start.command':'''#!/bin/zsh
set -e
cd "$(dirname "$0")"
export DYLD_LIBRARY_PATH="$PWD/runtime/lib"
exec "$PWD/analysis-service/.venv/bin/python" "$PWD/analysis-service/manage.py" serve
'''}.items():
        (target/name).write_text(body);(target/name).chmod(0o755)
    files={}
    for p in sorted(target.rglob('*')):
        if p.is_file():
            h=hashlib.sha256()
            with p.open('rb') as f:
                for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
            files[str(p.relative_to(target))]=h.hexdigest()
    manifest=dict(platform='macOS Intel x86_64 / Python 3.11.11',files=files,models='fixed local package; no runtime downloads',wheels='repacked exact installed versions; per-wheel SHA256 required',limitations='Same-Mac relocated clean-venv validation is separate from clean physical OS acceptance')
    (target/'package-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),'utf-8')
    print(json.dumps(dict(package=str(target),files=len(files),manifest_sha256=hashlib.sha256((target/'package-manifest.json').read_bytes()).hexdigest())))
if __name__=='__main__':build(sys.argv[1])
