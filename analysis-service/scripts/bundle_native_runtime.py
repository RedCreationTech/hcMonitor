"""Copy the current Intel macOS Python/ffmpeg runtime and relocate non-system dylibs.

Original installations are read-only inputs. Only copied binaries are rewritten.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def build(target):
    target=Path(target).resolve()
    if target.exists():raise ValueError('目标已存在，拒绝覆盖')
    target.mkdir(parents=True);source=Path(sys.base_prefix).resolve();python=target/'python'
    shutil.copytree(source,python,symlinks=False)
    roots=[(source,python)]
    pg=os.getenv('PG_ROOT')
    if pg:
        pg=Path(pg).resolve();shutil.copytree(pg,target/'postgresql',symlinks=False);roots.append((pg,target/'postgresql'))
    (target/'bin').mkdir();(target/'lib').mkdir()
    external={};processed=set();manifest=[]
    def relocate(src,dest):
        src=Path(src).resolve();dest=Path(dest)
        if str(dest) in processed:return
        processed.add(str(dest));dest.chmod(dest.stat().st_mode|0o200)
        p=subprocess.run(['otool','-L',str(src)],capture_output=True,text=True,check=True)
        dependencies=[line.strip().split(' (compatibility')[0] for line in p.stdout.splitlines()[1:]]
        for dependency in dependencies:
            if not dependency.startswith('/') or dependency.startswith(('/usr/lib/','/System/')):continue
            lib=Path(dependency).resolve()
            local=next(((src_root,dst_root) for src_root,dst_root in roots if src_root in lib.parents),None)
            if local:
                copy=local[1]/lib.relative_to(local[0])
            else:
                if str(lib) not in external:
                    name=hashlib.sha256(str(lib).encode()).hexdigest()[:8]+'-'+lib.name
                    external[str(lib)]=target/'lib'/name;shutil.copy2(lib,external[str(lib)])
                copy=external[str(lib)]
            if copy.resolve()!=dest.resolve():relocate(lib,copy)
            replacement='@loader_path/'+os.path.relpath(copy,dest.parent)
            subprocess.run(['install_name_tool','-change',dependency,replacement,str(dest)],capture_output=True,check=True)
        subprocess.run(['codesign','--force','--sign','-',str(dest)],capture_output=True,check=True)
        manifest.append(dict(path=str(dest.relative_to(target)),source=str(src),sha256=hashlib.sha256(dest.read_bytes()).hexdigest()))
    candidates=[]
    for p in python.rglob('*'):
        if p.is_file() and (p.suffix in ('.so','.dylib') or p.name in ('Python','python3.11')):
            if p.read_bytes()[:4] in (b'\xcf\xfa\xed\xfe',b'\xfe\xed\xfa\xcf',b'\xca\xfe\xba\xbe'):candidates.append(p)
    for p in candidates:relocate(source/p.relative_to(python),p)
    if pg:
        for p in (target/'postgresql').rglob('*'):
            if p.is_file() and p.read_bytes()[:4] in (b'\xcf\xfa\xed\xfe',b'\xfe\xed\xfa\xcf',b'\xca\xfe\xba\xbe'):
                relocate(pg/p.relative_to(target/'postgresql'),p)
    for name in ('ffmpeg','ffprobe'):
        static_dir=os.getenv('STATIC_FFMPEG_DIR',str(Path(__file__).resolve().parents[1]/'data/static-ffmpeg'))
        if not (Path(static_dir)/name).is_file():raise ValueError('请先运行 scripts/prepare_static_ffmpeg.py 准备固定静态工具')
        src=Path(static_dir)/name if static_dir else Path(shutil.which(name));dest=target/'bin'/name;shutil.copy2(src,dest)
        if static_dir:manifest.append(dict(path=str(dest.relative_to(target)),source=str(src),sha256=hashlib.sha256(dest.read_bytes()).hexdigest(),static=True))
        else:relocate(src,dest)
    (target/'native-manifest.json').write_text(json.dumps(manifest,indent=2),'utf-8')
    (target/'ffmpeg-license.txt').write_text(subprocess.run(['ffmpeg','-L'],capture_output=True,text=True).stdout,'utf-8')
    print(json.dumps(dict(native_files=len(manifest),external_libraries=len(external),runtime=str(target))))

if __name__=='__main__':build(sys.argv[1])
