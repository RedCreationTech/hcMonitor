import copy
import csv
import hashlib
import io
import json
import time
from concurrent.futures import ThreadPoolExecutor
from fastapi.testclient import TestClient
from pypdf import PdfReader
from app import main
from app.store import Store
from app.security import password_hash
from app.worker import Scheduler,content_hash
from conftest import PASSWORD,create,seal,analyzed,reviewed,published,fake_compute


def test_untrusted_identity_channels_and_logout(workspace,media_bytes):
    store,c,_=workspace;sid=create(c,media_bytes)
    stranger=TestClient(main.app)
    assert stranger.get('/v1/state').status_code==401
    assert stranger.get(f'/v1/sessions/{sid}/assets/AS-1/media').status_code==401
    assert stranger.post(f'/v1/sessions/{sid}/analyze-offline?actor=R-01',json={}).status_code==401
    import pytest
    with pytest.raises(Exception):
        with stranger.websocket_connect('/v1/analysis/stream') as ws:ws.receive_json()
    assert c['A-01'].get('/v1/state').json()['sessions']==[]
    assert c['R-01'].post(f'/v1/sessions/{sid}/analyze-offline?actor=W-02',json={}).status_code==403
    assert c['W-02'].post('/v1/auth/logout',json={}).status_code==200
    assert c['W-02'].get('/v1/state').status_code==401
    assert store.verify_chain()


def test_lockout_and_origin(workspace):
    _,c,_=workspace
    stranger=TestClient(main.app)
    for _ in range(3):assert stranger.post('/v1/auth/login',json=dict(employee='W-02',pin='wrong')).status_code==401
    assert stranger.post('/v1/auth/login',json=dict(employee='W-02',pin=PASSWORD)).status_code==401
    assert c['A-01'].post('/v1/auth/logout',json={},headers={'origin':'http://evil.example'}).status_code==403


def test_purpose_scope_expiry_and_assignment(workspace,media_bytes):
    store,c,_=workspace
    sid=create(c,media_bytes)
    with store.transaction():
        s=store.get_session(sid);s['participants'][0]['expires_at']=time.time()-1;store.upsert_session(s)
    assert c['W-02'].get('/v1/state').json()['sessions']==[]
    assert c['W-02'].post(f'/v1/sessions/{sid}/analyze-offline',json={}).status_code==403
    with store.transaction():
        s=store.get_session(sid);s['participants'][0].pop('expires_at');s['participants'][0]['purposes']['review']=False;store.upsert_session(s)
    assert c['R-01'].get('/v1/state').json()['sessions']==[]
    with store.transaction():
        s=store.get_session(sid);s['participants'][0]['purposes']['review']=True;s['project_id']='OTHER';store.upsert_session(s)
    assert c['W-02'].get(f'/v1/sessions/{sid}/runs').status_code==404


def test_stream_is_scoped_and_rechecks_logout(workspace,media_bytes):
    _,c,_=workspace;sid=create(c,media_bytes)
    with c['A-01'].websocket_connect('/v1/analysis/stream') as ws:
        assert ws.receive_json()['payload']['sessions']==[]
    with c['W-02'].websocket_connect('/v1/analysis/stream') as ws:
        assert ws.receive_json()['payload']['sessions'][0]['id']==sid
    import pytest
    with pytest.raises(Exception):
        with c['W-02'].websocket_connect('/v1/analysis/stream?channel=field') as ws:ws.receive_json()


def test_upload_rejects_unknown_incomplete_duplicate_and_bad_format(workspace,media_bytes):
    store,c,root=workspace;sid=create(c,media_bytes)
    def upload(data,aid='AS-1'):
        return c['W-02'].post(f'/v1/sessions/{sid}/assets',files={'file':('../../same.wav',data)},data=dict(kind='audio',asset_id=aid))
    assert upload(media_bytes,'UNKNOWN').status_code==404
    assert upload(media_bytes[:-2]).status_code==409
    assert c['W-02'].post(f'/v1/sessions/{sid}/analyze-offline',json={}).status_code==409
    assert upload(media_bytes).status_code==200
    s=store.get_session(sid);assert s['assets'][0]['sha256']==hashlib.sha256(media_bytes).hexdigest()
    assert upload(media_bytes).status_code==409
    assert not list((root/'uploads'/sid).glob('*.partial'))
    assert not (root/'same.wav').exists()
    sid2=create(c,b'not-media')
    assert c['W-02'].post(f'/v1/sessions/{sid2}/assets',files={'file':('fake.wav',b'not-media')},data=dict(kind='audio',asset_id='AS-1')).status_code==422


def test_chunk_resume_integrity_and_idempotent_complete(workspace,media_bytes):
    store,c,_=workspace;sid=create(c,media_bytes);client=c['W-02']
    path=f'/v1/sessions/{sid}/assets/AS-1/upload'
    x=client.post(path,json=dict(sha256=hashlib.sha256(media_bytes).hexdigest())).json()
    part=media_bytes[:1000];headers={'x-upload-offset':'0','x-chunk-sha256':hashlib.sha256(part).hexdigest()}
    assert client.put(f"/v1/uploads/{x['id']}",content=part,headers=headers).status_code==200
    assert client.put(f"/v1/uploads/{x['id']}",content=b'x',headers=headers).status_code==409
    assert client.post(path,json=dict(sha256=hashlib.sha256(media_bytes).hexdigest())).json()['bytes']==1000
    assert client.put(f"/v1/uploads/{x['id']}",content=part,headers=headers).json()['duplicate']
    tail=media_bytes[1000:];assert client.put(f"/v1/uploads/{x['id']}",content=tail,headers={'x-upload-offset':'1000','x-chunk-sha256':hashlib.sha256(tail).hexdigest()}).status_code==200
    assert client.post(f"/v1/uploads/{x['id']}/complete",json={}).status_code==200
    assert client.post(f"/v1/uploads/{x['id']}/complete",json={}).json()['duplicate']
    assert store.get_session(sid)['assets'][0]['upload_status']=='complete'


def test_authorized_range_and_restriction(workspace,media_bytes):
    _,c,_=workspace;sid=create(c,media_bytes);seal(c,sid,media_bytes)
    path=f'/v1/sessions/{sid}/assets/AS-1/media'
    r=c['W-02'].get(path,headers={'Range':'bytes=10-19'});assert r.status_code==206 and r.content==media_bytes[10:20]
    assert r.headers['content-range']==f'bytes 10-19/{len(media_bytes)}'
    assert c['READ-01'].get(path).status_code==403
    assert c['W-02'].get(path,headers={'Range':'bytes=999999999-'}).status_code==416
    assert c['A-01'].post(f'/v1/admin/sessions/{sid}/restrict',json=dict(note='撤回用途',restricted=True)).status_code==200
    assert c['W-02'].get(path).status_code==403


def test_persistent_serial_queue_cancel_failure_recovery(workspace,media_bytes):
    store,c,_=workspace;sid=create(c,media_bytes);seal(c,sid,media_bytes)
    client=c['W-02'];path=f'/v1/sessions/{sid}/analyze-offline'
    a=client.post(path,json={'request_key':'same'}).json()['job']
    assert client.post(path,json={'request_key':'same'}).json()['job']['id']==a['id']
    assert client.post(f"/v1/jobs/{a['id']}/cancel",json={}).status_code==200
    assert store.get('jobs',a['id'])['status']=='cancelled'
    b=client.post(path,json={'request_key':'retry'}).json()['job']
    def fail(*args):raise ValueError('all assets failed')
    Scheduler(store,compute=fail).tick();assert store.get('jobs',b['id'])['status']=='failed';assert not store.reports()
    j=client.post(path,json={'request_key':'crash'}).json()['job']
    j.update(status='running',lease_until=time.time()-1);store.put('jobs',j)
    Scheduler(store,compute=fake_compute).recover();assert store.get('jobs',j['id'])['status']=='interrupted'
    assert not store.reports()


def test_corrections_conflict_run_and_original_immutability(workspace,media_bytes):
    store,c,_=workspace;sid,rid,runid=analyzed(workspace,media_bytes)
    original=store.get('runs',runid);s=store.get_session(sid);turns=copy.deepcopy(s['offline']['turns']);turns[0].update(speaker='subject',participant_id='P2',text='经人工核对的文字')
    response=c['W-02'].post(f'/v1/sessions/{sid}/corrections',json=dict(revision=s['revision'],turns=turns,topics=[]));assert response.status_code==200,response.text
    assert c['W-02'].post(f'/v1/sessions/{sid}/corrections',json=dict(revision=s['revision'],turns=turns,topics=[])).status_code==409
    assert c['W-02'].post(f'/v1/reports/{rid}/submit',json=dict(revision=1)).status_code==409
    assert store.get('runs',runid)==original
    assert store.get_session(sid)['stale']
    assert c['W-02'].post(f'/v1/sessions/{sid}/analyze-offline',json={'request_key':'rev2'}).status_code==200
    Scheduler(store,compute=fake_compute).tick()
    assert store.get_session(sid)['current_run_id']!=runid
    assert len(store.reports())==2


def test_review_roles_cap_and_stale_references(workspace,media_bytes):
    store,c,_=workspace;sid,_,run=analyzed(workspace,media_bytes)
    body=dict(run_id=run,behavior='confirmed',explanation='abstain',note='独立观察与候选解释分开')
    assert c['W-02'].post(f'/v1/sessions/{sid}/events/EV-001/review',json=body).status_code==403
    assert c['R-01'].post(f'/v1/sessions/{sid}/events/EV-001/review',json={**body,'run_id':'OLD'}).status_code==409
    with store.transaction():
        r=store.get('runs',run);r['result']['anomalies'][0]['cap_note']='only trend';store.put('runs',r)
    assert c['R-01'].post(f'/v1/sessions/{sid}/events/EV-001/review',json={**body,'explanation':'supported'}).status_code==422
    assert c['R-01'].post(f'/v1/sessions/{sid}/events/EV-001/review',json=body).status_code==200


def test_report_cannot_self_approve_or_edit_approved(workspace,media_bytes):
    store,c,_=workspace;sid,rid,run=analyzed(workspace,media_bytes);reviewed(workspace,sid,rid,run)
    assert c['W-02'].post(f'/v1/reports/{rid}/approve',json={}).status_code==403
    with store.transaction():
        u=store.get('users','R-01');u['person_id']='W-02';store.put('users',u)
    assert c['R-01'].post(f'/v1/reports/{rid}/approve',json={}).status_code==403
    with store.transaction():
        u=store.get('users','R-01');u['person_id']='R-01';store.put('users',u)
    assert c['R-01'].post(f'/v1/reports/{rid}/approve',json={}).status_code==200
    assert c['W-02'].post(f'/v1/reports/{rid}/section',json=dict(key='overview',text='rewrite',revision=1)).status_code==409
    old=store.get_report(rid)
    r=c['W-02'].post(f'/v1/reports/{rid}/new-version',json={});assert r.status_code==200
    assert store.get_report(rid)==old
    assert store.get_report(r.json()['id'])['status']=='drafting'


def test_export_formats_hashes_repeated_delivery_and_revocation(workspace,media_bytes):
    store,c,_=workspace;sid,rid,_=published(workspace,media_bytes);reader=c['READ-01'];report=store.get_report(rid)
    assert reader.get(f'/v1/reports/{rid}/read').status_code==200
    for fmt in ['html','csv','pdf']:
        r=reader.post(f'/v1/reports/{rid}/export',json=dict(format=fmt,purpose='内部测试'));assert r.status_code==200,r.text
        d=reader.get(r.json()['url']);assert d.status_code==200;assert hashlib.sha256(d.content).hexdigest()==r.json()['hash']
        assert reader.get(r.json()['url']).status_code==200
        if fmt=='pdf':
            pdf=PdfReader(io.BytesIO(d.content));text=''.join(p.extract_text() for p in pdf.pages);assert '免责' in text and '报告' in text and rid in text
        if fmt=='csv':
            rows=list(csv.DictReader(io.StringIO(d.content.decode('utf-8-sig'))));assert '\n' in rows[0]['observation'] or '\\n' in rows[0]['observation'];assert rows[0]['content_hash']==report['content_hash']
        last=r.json()['url']
    assert reader.post(f'/v1/reports/{rid}/export',json=dict(format='pdf',purpose='其他用途')).status_code==403
    assert c['W-02'].post(f'/v1/reports/{rid}/export',json=dict(format='pdf',purpose='内部测试')).status_code==403
    g=report['grants'][0]
    assert c['R-01'].post(f"/v1/reports/{rid}/grants/{g['id']}/revoke",json={}).status_code==200
    assert reader.get(last).status_code==403
    assert reader.get('/v1/state').json()['reports']==[]
    assert store.verify_chain()


def test_read_only_grant_expiry_and_restriction(workspace,media_bytes):
    store,c,_=workspace;sid,rid,_=published(workspace,media_bytes,actions=['read'])
    assert c['READ-01'].post(f'/v1/reports/{rid}/export',json=dict(format='pdf',purpose='内部测试')).status_code==403
    with store.transaction():
        r=store.get_report(rid);r['grants'][0]['expires_at']=time.time()-1;store.upsert_report(r)
    assert c['READ-01'].get(f'/v1/reports/{rid}/read').status_code==403
    assert c['A-01'].post(f'/v1/admin/sessions/{sid}/restrict',json={'note':'test'}).status_code==200
    assert c['R-01'].get('/v1/state').json()['reports']==[]


def test_transactions_and_multi_connection_audit(tmp_path):
    path=tmp_path/'db';a=Store(path,database_url='');b=Store(path,database_url='')
    try:
        with a.transaction() as db:db['seq']=999;raise ValueError()
    except ValueError:pass
    assert a.db['seq']==0
    def write(pair): pair[0].audit('actor','change',str(pair[1]))
    with ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(write,[(a if i%2 else b,i) for i in range(20)]))
    assert len(a.db['audit'])==20 and a.verify_chain() and b.verify_chain()


def test_capture_lease_and_unique_auto_queue(workspace,media_bytes):
    store,c,_=workspace
    lease=c['C-04'].post('/v1/capture/lease',json={});assert lease.status_code==200
    assert c['W-02'].post('/v1/capture/lease',json={}).status_code==409
    assert c['C-04'].post('/v1/capture/lease',json=dict(lease_id=lease.json()['id'])).status_code==200
    assert c['C-04'].post('/v1/capture/lease/release',json=dict(lease_id=lease.json()['id'])).status_code==200
    sid=create(c,media_bytes,source='live');seal(c,sid,media_bytes)
    p=f'/v1/sessions/{sid}/capture-complete'
    a=c['W-02'].post(p,json=dict(request_key='recording'));b=c['W-02'].post(p,json=dict(request_key='recording'))
    assert a.status_code==b.status_code==200 and a.json()['job']['id']==b.json()['job']['id']


def test_same_name_assets_do_not_overwrite(workspace,media_bytes):
    store,c,root=workspace
    assets=[dict(id=aid,name='same.wav',kind='audio',size_bytes=len(media_bytes),duration_seconds=3) for aid in ('AS-A','AS-B')]
    sid=create(c,media_bytes,assets=assets,primary_asset_id='AS-B')
    for aid in ('AS-A','AS-B'):seal(c,sid,media_bytes,aid)
    a,b=store.get_session(sid)['assets']
    assert a['storage_key']!=b['storage_key'] and store.get_session(sid)['primary_asset_id']=='AS-B'
    assert (root/'uploads'/sid/a['storage_key']).is_file() and (root/'uploads'/sid/b['storage_key']).is_file()
