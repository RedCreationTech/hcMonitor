"""Explicit online preparation of pinned static Intel macOS tools; runtime never downloads."""
import hashlib
import io
import json
from pathlib import Path
import zipfile
import requests
ROOT=Path(__file__).resolve().parents[1]

if __name__=='__main__':
    target=ROOT/'data/static-ffmpeg';target.mkdir(parents=True,exist_ok=True)
    for record in json.loads((ROOT/'ffmpeg-source.json').read_text()):
        response=requests.get(record['source'],timeout=120);response.raise_for_status()
        if hashlib.sha256(response.content).hexdigest()!=record['archive_sha256']:raise ValueError('工具下载包hash不一致')
        archive=zipfile.ZipFile(io.BytesIO(response.content))
        entry=next(x for x in archive.namelist() if Path(x).name==record['name'] and not x.endswith('/'))
        data=archive.read(entry)
        if hashlib.sha256(data).hexdigest()!=record['binary_sha256']:raise ValueError('工具二进制hash不一致')
        path=target/record['name'];path.write_bytes(data);path.chmod(0o755)
    print('Pinned static ffmpeg/ffprobe ready')
