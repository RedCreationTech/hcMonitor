"""Reconstruct exact installed distributions without recompiling unavailable Intel wheels.

Uses each distribution's own WHEEL tags and installed files; offline reinstall is
validated separately. This is a local reproducibility bundle, not an upstream wheel.
"""
import hashlib
import importlib.metadata as metadata
import json
from pathlib import Path
import re
import sys
import zipfile
import base64
import csv
import io
from packaging.tags import sys_tags,parse_tag


def build(target):
    target=Path(target);target.mkdir(parents=True,exist_ok=True);records=[];lock=[]
    for dist in sorted(metadata.distributions(),key=lambda d:d.metadata['Name'].lower()):
        files=list(dist.files or [])
        wheel=next((f for f in files if str(f).endswith('.dist-info/WHEEL')),None)
        if not wheel:raise ValueError('缺少可封装WHEEL元数据：'+dist.metadata['Name'])
        info=dist.read_text('WHEEL');available=set(sys_tags());tag=next(l[5:] for l in info.splitlines() if l.startswith('Tag: ') and parse_tag(l[5:]) & available)
        stem=str(wheel).split('/')[0].removesuffix('.dist-info')
        name=stem+'-'+tag+'.whl';output=target/name
        record_rows=[]
        with zipfile.ZipFile(str(output),'w',zipfile.ZIP_DEFLATED,compresslevel=3) as archive:
            for f in files:
                rel=str(f)
                if rel.startswith('../') or rel.endswith('/RECORD') or '__pycache__/' in rel or rel.endswith('.pyc'):continue
                source=Path(dist.locate_file(f))
                if source.is_file():
                    data=source.read_bytes();archive.writestr(rel,data)
                    record_rows.append([rel,'sha256='+base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('='),len(data)])
            record_name=stem+'.dist-info/RECORD';record_rows.append([record_name,'',''])
            record=io.StringIO(newline='');csv.writer(record).writerows(record_rows);archive.writestr(record_name,record.getvalue())
        digest=hashlib.sha256(output.read_bytes()).hexdigest();package=dist.metadata['Name'];version=dist.version
        records.append(dict(package=package,version=version,file=name,sha256=digest,origin='repacked exact installed distribution'))
        lock.append(f'{package}=={version} --hash=sha256:{digest}')
    (target/'wheels.json').write_text(json.dumps(records,indent=2),'utf-8')
    (target/'offline.lock').write_text('\n'.join(lock)+'\n','utf-8')
    print(json.dumps(dict(wheels=len(records),bytes=sum(p.stat().st_size for p in target.glob('*.whl')))))

if __name__=='__main__':build(sys.argv[1])
