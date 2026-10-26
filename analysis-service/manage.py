"""Operator entry point; load this installation's private runtime configuration first."""
import json
import os
from pathlib import Path
import sys
root=Path(__file__).resolve().parent
config=root/'data/runtime-config.json'
if config.is_file():
    for key,value in json.loads(config.read_text()).items():os.environ.setdefault(key,str(value))
if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='serve':
        import subprocess
        pg_bin=os.getenv('PG_BIN');cluster=os.getenv('PG_CLUSTER')
        if pg_bin and cluster:
            socket=Path(os.environ['PG_SOCKET']);socket.mkdir(mode=0o700,parents=True,exist_ok=True);socket.chmod(0o700)
            pg_ctl=Path(pg_bin)/'pg_ctl'
            status=subprocess.run([str(pg_ctl),'-D',cluster,'status'],capture_output=True)
            if status.returncode:
                subprocess.run([str(pg_ctl),'-D',cluster,'-l',str(Path(cluster).parent/'postgres.log'),'-o',f"-p {os.environ['PG_PORT']} -k {socket} -h ''",'start'],check=True)
        import uvicorn
        from app.main import app
        uvicorn.run(app,host=os.getenv('BIND_HOST','127.0.0.1'),port=int(os.getenv('PORT','5190')),log_level='info',ssl_certfile=os.getenv('TLS_CERT_FILE'),ssl_keyfile=os.getenv('TLS_KEY_FILE'))
    else:
        from app.cli import main
        main()
