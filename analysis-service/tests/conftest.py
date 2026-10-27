import os
os.environ['WORKER_DISABLED']='1'
os.environ['MODEL_DOWNLOAD_POLICY']='offline'
import copy
import hashlib
import io
import time
import wave
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from app import main
from app.store import Store
from app.security import bootstrap
from app.worker import Scheduler
from app.pipeline.attribution import fill_attribution,load_rules

PASSWORD='Local-Test-Password-2026!'

@pytest.fixture
def workspace(tmp_path,monkeypatch):
    store=Store(tmp_path/'state.sqlite3',database_url='');bootstrap(store,PASSWORD)
    monkeypatch.setattr(main,'store',store);monkeypatch.setattr(main,'DATA',tmp_path)
    monkeypatch.setattr(main,'UPLOADS',tmp_path/'uploads');monkeypatch.setattr(main,'ARTIFACTS',tmp_path/'artifacts')
    clients={}
    for name in ('W-02','R-01','C-04','A-01','READ-01','AUD-01'):
        c=TestClient(main.app);assert c.post('/v1/auth/login',json=dict(employee=name,pin=PASSWORD)).status_code==200;clients[name]=c
    return store,clients,tmp_path

@pytest.fixture
def media_bytes():
    buf=io.BytesIO()
    with wave.open(buf,'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(b'\x00\x00'*16000*3)
    return buf.getvalue()


def create(clients,data,asset_id='AS-1',**patch):
    body=dict(subject_code='TEST-P',scene='自动化合成用例',consent_doc='TEST-CONSENT',source='imported',
        participants=[dict(id='P1',role='interviewer',purposes=dict(capture=True,analyze=True,review=True,report=True)),dict(id='P2',role='subject',purposes=dict(capture=True,analyze=True,review=True,report=True))],
        assets=[dict(id=asset_id,name='sample.wav',kind='audio',size_bytes=len(data),duration_seconds=3)],primary_asset_id=asset_id)
    body.update(patch)
    r=clients['W-02'].post('/v1/sessions',json=body);assert r.status_code==200,r.text
    return r.json()['id']


def seal(clients,sid,data,aid='AS-1'):
    r=clients['W-02'].post(f'/v1/sessions/{sid}/assets',files={'file':('sample.wav',data,'audio/wav')},data=dict(kind='audio',asset_id=aid))
    assert r.status_code==200,r.text


def fake_compute(s,r,progress):
    s=copy.deepcopy(s)
    for asset in s['assets']:
        if asset['kind'] in ('audio','video'):asset['duration_seconds']=3
    aid=s['assets'][0]['id']
    e=dict(id='EV-001',session_id=s['id'],run_id=r['id'],event='anomaly',ts=1.,modality='voice',type='停顿升高',severity='WARN',confidence=.7,lamp='orange',advice='',participant_id='P2',source_assets=[dict(id=aid,name='sample.wav',kind='audio')],attribution=dict(observation=[dict(modality='voice',text='观察逗号,换行\n=公式',ts_from=0.,ts_to=2.)],candidate_rules=[],conclusion={}),cap_note=None)
    fill_attribution(e,load_rules())
    result=dict(run_id=r['id'],finished_at='2026-10-26',asset_kind='audio',assets=copy.deepcopy(s['assets']),slices=[dict(asset_id=aid,quality='ok',quality_note='合成测试夹具',asset_name='sample.wav',kind='audio',modality_available=['voice'],modality_unavailable=['face','pose','hand','physio'],steps=[],event_ids=['EV-001'],suppressed=[],trend=None,cap_note=None,role='primary',size_bytes=s['assets'][0]['size_bytes'],duration_seconds=3)],modality_available=['voice'],duration_seconds=3,turns=[dict(id='T-1',event='dialogue',asset_id=aid,ts=0.,end=3.,speaker='unknown',participant_id=None,text='用于自动化校正测试',diar_state='degraded',diar_confidence=None)],impacts=[],anomalies=[e],suppressed=[],pipeline='test-fixture-not-real',narrative=dict(status='not_applicable',reason='自动化合成夹具',text='',citations=[]),manifest=dict(test_fixture=True))

    for asset in s['assets'][1:]:
        if asset['kind'] not in ('nir','mmwave'):continue
        sensor=copy.deepcopy(e);sensor.update(id='EV-002',type='合成采样趋势事件',modality='physio',ts=4.,participant_id=None,cap_note='合成测试：文件趋势封顶',source_assets=[dict(id=asset['id'],name=asset['name'],kind=asset['kind'])])
        fill_attribution(sensor,load_rules());result['anomalies'].append(sensor)
        sl=copy.deepcopy(result['slices'][0]);sl.update(asset_id=asset['id'],asset_name=asset['name'],kind=asset['kind'],role='extension',duration_seconds=59,event_ids=['EV-002'],cap_note=sensor['cap_note'],modality_available=['physio'],trend=dict(sensor_label='合成测试采样序列',samples=60,time_base='素材登记时长',metrics=[dict(name='合成趋势',unit='相对值',decimals=1,baseline=1.,peak=2.,peak_ts=4.,end_value=1.,series=[1.,2.,1.])],limits=['仅测试UI，不代表真实量测']))
        result['slices'].append(sl)
    return result


def analyzed(workspace,data):
    store,clients,_=workspace;sid=create(clients,data);seal(clients,sid,data)
    response=clients['W-02'].post(f'/v1/sessions/{sid}/analyze-offline',json=dict(request_key='first'));assert response.status_code==200,response.text
    Scheduler(store,compute=fake_compute).tick()
    s=store.get_session(sid);assert s['offline'];return sid,s['offline']['report_id'],s['current_run_id']


def reviewed(workspace,sid,rid,run):
    store,clients,_=workspace
    response=clients['R-01'].post(f'/v1/sessions/{sid}/events/EV-001/review',json=dict(run_id=run,behavior='confirmed',explanation='abstain',note='行为成立，候选解释证据不足，弃权'))
    assert response.status_code==200,response.text
    report=store.get_report(rid)
    response=clients['W-02'].post(f'/v1/reports/{rid}/submit',json=dict(revision=report['revision']));assert response.status_code==200,response.text


def published(workspace,data,actions=None):
    store,clients,_=workspace;sid,rid,run=analyzed(workspace,data);reviewed(workspace,sid,rid,run)
    response=clients['R-01'].post(f'/v1/reports/{rid}/approve',json={});assert response.status_code==200,response.text
    grants=[dict(recipient='READ-01',purpose='内部测试',actions=actions or ['read','download','print'],expires_at=time.time()+3600)]
    response=clients['R-01'].post(f'/v1/reports/{rid}/publish',json=dict(grants=grants));assert response.status_code==200,response.text
    return sid,rid,run
