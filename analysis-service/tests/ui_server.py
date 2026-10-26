"""Isolated browser test server with explicitly synthetic detector output."""
import os
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]));sys.path.insert(0,str(Path(__file__).resolve().parent))
os.environ['WORKER_DISABLED']='0'
from app import main
from app.security import bootstrap
from app.worker import Scheduler
from conftest import fake_compute
os.environ['WORKER_DISABLED']='0'
if not main.store.collection('users'):bootstrap(main.store,'Browser-QA-Password-2026!')
main.scheduler=Scheduler(main.store,compute=fake_compute)
if __name__=='__main__':
    import uvicorn
    uvicorn.run(main.app,host='127.0.0.1',port=55290,log_level='warning')
