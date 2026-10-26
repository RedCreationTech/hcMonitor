"""Actual offline detectors and report pipeline on the repository's synthetic demo audio.

This verifies engineering integration, never human/clinical accuracy. Network
connections are denied in this parent and every spawned narrative child.
"""
import os
import sys
import json
import hashlib
import time
import socket
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
os.environ['WORKER_DISABLED']='1'
os.environ['DATA_ROOT']=os.environ.get('QA_DATA_ROOT',str(ROOT/'data'/'qa-real'))
os.environ['MODEL_DOWNLOAD_POLICY']='offline'
socket.socket.connect=lambda *a,**kw: (_ for _ in ()).throw(RuntimeError('offline smoke: network prohibited'))


def main():
    from fastapi.testclient import TestClient
    from app.main import app,store
    from app.security import bootstrap
    from app.worker import Scheduler
    from app.config import DATA
    if store.sessions():raise ValueError('QA目录已有会话；请使用新的QA_DATA_ROOT，避免覆盖')
    password='QA-Only-'+os.urandom(12).hex();bootstrap(store,password)
    c=TestClient(app);assert c.post('/v1/auth/login',json=dict(employee='W-02',pin=password)).status_code==200
    path=Path(os.getenv('SMOKE_MEDIA',str(ROOT/'data/uploads/SES-20261024-001/谈话录音_音频样例_156s.m4a')))
    if not path.is_file():path=ROOT.parent/'fixtures/demo-audio.m4a'
    data=path.read_bytes();started=time.monotonic()
    body=dict(subject_code='SYNTHETIC-QA',scene='合成音频集成验证',consent_doc='QA-SYNTHETIC-NOT-HUMAN',
        participants=[dict(id='P-I',role='interviewer',purposes=dict(capture=True,analyze=True,review=True,report=True)),dict(id='P-S',role='subject',purposes=dict(capture=True,analyze=True,review=True,report=True))],assets=[dict(id='AS-QA',name=path.name,size_bytes=len(data),kind='audio')],primary_asset_id='AS-QA')
    response=c.post('/v1/sessions',json=body);assert response.status_code==200,response.text;sid=response.json()['id']
    response=c.post(f'/v1/sessions/{sid}/assets',files={'file':(path.name,data)},data=dict(kind='audio',asset_id='AS-QA'));assert response.status_code==200,response.text
    assert c.post(f'/v1/sessions/{sid}/analyze-offline',json={'request_key':'raw'}).status_code==200
    Scheduler(store).tick();s=store.get_session(sid)
    assert s.get('offline'),store.collection('jobs')[-1].get('error')
    first=s['offline'];first_hash=store.get('runs',s['current_run_id'])['result_hash']
    turns=first['turns'];speakers=sorted({t['speaker_id'] for t in turns if t.get('speaker_id')})
    for t in turns:
        if t.get('speaker_id') in speakers[:2] and len(speakers)>=2:
            t.update(speaker='interviewer' if t['speaker_id']==speakers[0] else 'subject',participant_id='P-I' if t['speaker_id']==speakers[0] else 'P-S')
        else:t.update(speaker='unknown',participant_id=None)
    response=c.post(f'/v1/sessions/{sid}/corrections',json=dict(revision=s['revision'],turns=turns,topics=[]));assert response.status_code==200,response.text
    assert c.post(f'/v1/sessions/{sid}/analyze-offline',json={'request_key':'corrected'}).status_code==200
    Scheduler(store).tick();s=store.get_session(sid);result=s['offline'];assert not s['stale'];assert result['run_id']!=first['run_id']
    assert store.get('runs',first['run_id'])['result_hash']==first_hash
    assert result['narrative']['status']=='generated',result['narrative']
    assert result['manifest']['environment']['packages']['torch']!='unavailable'
    reviewer=TestClient(app);assert reviewer.post('/v1/auth/login',json=dict(employee='R-01',pin=password)).status_code==200
    for e in result['anomalies']:
        response=reviewer.post(f"/v1/sessions/{sid}/events/{e['id']}/review",json=dict(run_id=result['run_id'],behavior='abstain',explanation='abstain',note='合成音频只验证工程闭环，不构成真实业务判断'))
        assert response.status_code==200,response.text
    rid=result['report_id'];report=store.get_report(rid)
    response=c.post(f'/v1/reports/{rid}/submit',json={'revision':report['revision']});assert response.status_code==200,response.text
    assert reviewer.post(f'/v1/reports/{rid}/approve',json={}).status_code==200
    assert reviewer.post(f'/v1/reports/{rid}/publish',json=dict(grants=[dict(recipient='READ-01',purpose='合成测试归档',actions=['read','download','print'],expires_at=time.time()+3600)])).status_code==200
    reader=TestClient(app);assert reader.post('/v1/auth/login',json=dict(employee='READ-01',pin=password)).status_code==200
    exports=[]
    for fmt in ('pdf','html','csv'):
        response=reader.post(f'/v1/reports/{rid}/export',json=dict(format=fmt,purpose='合成测试归档'));assert response.status_code==200,response.text
        x=response.json();binary=reader.get(x['url']);assert binary.status_code==200 and hashlib.sha256(binary.content).hexdigest()==x['hash']
        exports.append(dict(format=fmt,sha256=x['hash'],bytes=len(binary.content)))
    summary=dict(fixture='repository synthetic demo, NOT human accuracy evaluation',network='socket.connect blocked; cold local loading',
        input_sha256=hashlib.sha256(data).hexdigest(),session_id=sid,run_ids=[first['run_id'],result['run_id']],turns=len(result['turns']),speaker_clusters=len(speakers),
        events=len(result['anomalies']),topics=len(result['impacts']),narrative=result['narrative'],quality=[dict(asset_id=x['asset_id'],quality=x['quality'],baseline=x.get('baseline_status')) for x in result['slices']],
        elapsed_seconds=round(time.monotonic()-started,3),report_id=rid,exports=exports,audit_chain=store.verify_chain())
    (DATA/'smoke-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),'utf-8')
    print(json.dumps(summary,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
