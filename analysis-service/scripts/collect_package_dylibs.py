"""Collect native package dependencies into a private runtime; never modify site-packages."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import sysconfig


def collect(runtime):
    runtime=Path(runtime).resolve();libdir=runtime/'lib';records=json.loads((runtime/'native-manifest.json').read_text());sources={r['source']:runtime/r['path'] for r in records};busy=set()
    def dependency(source):
        source=Path(source).resolve();key=str(source)
        if key in sources:return sources[key]
        dest=libdir/(hashlib.sha256(key.encode()).hexdigest()[:8]+'-'+source.name);sources[key]=dest;dest.write_bytes(source.read_bytes());dest.chmod(0o755)
        for dep in deps(source):
            copied=dependency(dep)
            subprocess.run(['install_name_tool','-change',dep,'@loader_path/'+copied.name,str(dest)],capture_output=True,check=True)
        subprocess.run(['codesign','--force','--sign','-',str(dest)],capture_output=True,check=True)
        records.append(dict(path=str(dest.relative_to(runtime)),source=key,sha256=hashlib.sha256(dest.read_bytes()).hexdigest()))
        return dest
    def deps(file):
        result=subprocess.run(['otool','-L',str(file)],capture_output=True,text=True,check=True)
        return [d for l in result.stdout.splitlines()[1:] if (d:=l.strip().split(' (compatibility')[0]).startswith('/') and not d.startswith(('/System/','/usr/lib/')) and Path(d).resolve()!=Path(file).resolve() and (Path(d).exists() or Path(d).name!=Path(file).name)]
    packages=Path(sysconfig.get_paths()['purelib']);count=0
    for file in packages.rglob('*'):
        if file.is_file() and file.suffix in ('.so','.dylib'):
            with file.open('rb') as f:magic=f.read(4)
            if magic not in (b'\xcf\xfa\xed\xfe',b'\xfe\xed\xfa\xcf',b'\xca\xfe\xba\xbe'):continue
            count+=1
            for dep in deps(file):dependency(dep)
    for source,dest in sources.items():
        if dest.parent!=libdir:continue
        alias=libdir/Path(source).name
        if alias.exists():
            if alias.resolve()!=dest.resolve() and hashlib.sha256(alias.read_bytes()).digest()!=hashlib.sha256(dest.read_bytes()).digest():raise ValueError('同名动态库版本冲突：'+source)
        else:alias.symlink_to(dest.name)
    (runtime/'native-manifest.json').write_text(json.dumps(records,indent=2),'utf-8')
    print(json.dumps(dict(package_native_files=count,native_records=len(records))))

if __name__=='__main__':collect(sys.argv[1])
