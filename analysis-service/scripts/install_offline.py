"""Run with the bundle's runtime/python/bin/python3.11; no Internet or compilers."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

root=Path(__file__).resolve().parents[1]

def run(args,**kwargs):return subprocess.run([str(a) for a in args],check=True,**kwargs)

def main():
    manifest=json.loads((root/'package-manifest.json').read_text())
    for relative,expected in manifest['files'].items():
        file=root/relative;h=hashlib.sha256()
        with file.open('rb') as f:
            for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
        if h.hexdigest()!=expected:raise ValueError('离线包文件hash不一致：'+relative)
    server=root/'analysis-service';config=server/'data/runtime-config.json'
    if config.exists():raise ValueError('已安装：拒绝覆盖运行配置、账号或数据库')
    python=root/'runtime/python/bin/python3.11';venv=server/'.venv'
    run([python,'-m','venv',venv])
    env=os.environ.copy();env['DYLD_LIBRARY_PATH']=str(root/'runtime/lib');env['PIP_NO_INDEX']='1'
    run([venv/'bin/python','-m','pip','install','--no-index','--no-deps','--require-hashes','--find-links',root/'wheels','-r',root/'wheels/offline.lock'],env=env)
    pg=root/'runtime/postgresql/bin';data=server/'data';data.mkdir(exist_ok=True)
    socket=Path('/tmp')/('minddialogue-'+hashlib.sha256(str(root).encode()).hexdigest()[:12]);socket.mkdir(mode=0o700,exist_ok=True);socket.chmod(0o700)
    (data/'m1').mkdir(mode=0o700,exist_ok=True);(data/'m1').chmod(0o700)
    cluster=data/'postgres';port=int(os.getenv('PGPORT','55433'))
    run([pg/'initdb','-D',cluster,'--encoding=UTF8','--no-locale','--auth-local=trust','--auth-host=reject'],env=env,stdout=subprocess.DEVNULL)
    run([pg/'pg_ctl','-D',cluster,'-l',data/'postgres.log','-o',f"-p {port} -k {socket} -h ''",'start'],env=env)
    run([pg/'createdb','-h',socket,'-p',str(port),'minddialogue'],env=env)
    settings=dict(DATABASE_URL=f'postgresql:///minddialogue?host={socket}&port={port}',DATA_ROOT=str(data/'m1'),MODEL_ROOT=str(server/'models'),
        FFMPEG_BIN=str(root/'runtime/bin/ffmpeg'),FFPROBE_BIN=str(root/'runtime/bin/ffprobe'),MODEL_DOWNLOAD_POLICY='offline',PORT=os.getenv('PORT','5190'),
        DYLD_LIBRARY_PATH=str(root/'runtime/lib'),PG_SOCKET=str(socket),PG_PORT=port,PG_BIN=str(pg),PG_CLUSTER=str(cluster))
    fd=os.open(config,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:json.dump(settings,f,indent=2)
    run([venv/'bin/python',server/'manage.py','init'],env=env,cwd=server)
    run([venv/'bin/python',server/'manage.py','preflight'],env=env,cwd=server)
    print('离线安装完成；账号文件在 analysis-service/data/m1/initial-credentials.json；执行 start.command 启动。')

if __name__=='__main__':main()
