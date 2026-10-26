import copy
import json
from fastapi.testclient import TestClient
from app import main
from conftest import create,seal,analyzed,reviewed


def test_new_review_invalidates_pending_approval(workspace,media_bytes):
    store,c,_=workspace;sid,rid,run=analyzed(workspace,media_bytes);reviewed(workspace,sid,rid,run)
    r=c['R-01'].post(f'/v1/sessions/{sid}/events/EV-001/review',json=dict(run_id=run,behavior='rejected',explanation='rejected',note='复核后发现另有解释'))
    assert r.status_code==200
    assert c['R-01'].post(f'/v1/reports/{rid}/approve',json={}).status_code==409


def test_correction_cannot_exceed_its_file_clock(workspace,media_bytes):
    store,c,_=workspace;sid,_,_=analyzed(workspace,media_bytes);s=store.get_session(sid)
    turns=copy.deepcopy(s['offline']['turns']);turns[0]['end']=30
    r=c['W-02'].post(f'/v1/sessions/{sid}/corrections',json=dict(revision=s['revision'],turns=turns,topics=[]))
    assert r.status_code==422


def test_disabled_seat_and_active_ws_cannot_read(workspace,media_bytes):
    _,c,_=workspace;sid=create(c,media_bytes)
    with c['W-02'].websocket_connect('/v1/analysis/stream') as ws:
        assert ws.receive_json()['payload']['sessions'][0]['id']==sid
        assert c['A-01'].post('/v1/admin/users/W-02/enabled',json={'enabled':False}).status_code==200
        import pytest
        with pytest.raises(Exception):ws.receive_json()
    assert c['W-02'].get('/v1/state').status_code==401


def test_spa_deep_links_and_unknown_api(workspace):
    c=TestClient(main.app)
    response=c.get('/t/workstation/offline/SESSION-ID')
    assert response.status_code==200 and '<html' in response.text
    assert c.get('/v1/nonexistent').status_code==401
    assert workspace[1]['W-02'].get('/v1/nonexistent').status_code==404


def slow_compute(session,run,progress):
    import time
    progress(10,'cancellable detector')
    time.sleep(20)
    return {}


def test_revocation_stops_actual_child_process(workspace,media_bytes):
    import threading,time
    from app.worker import Scheduler
    store,c,_=workspace;sid=create(c,media_bytes);seal(c,sid,media_bytes)
    response=c['W-02'].post(f'/v1/sessions/{sid}/analyze-offline',json={});job=response.json()['job']
    scheduler=Scheduler(store,compute=slow_compute,isolate=True)
    thread=threading.Thread(target=scheduler.tick);thread.start()
    deadline=time.time()+10
    while time.time()<deadline and store.get('jobs',job['id']).get('progress')!=10:time.sleep(.1)
    assert store.get('jobs',job['id'])['progress']==10
    assert c['A-01'].post(f'/v1/admin/sessions/{sid}/restrict',json={'note':'active revocation'}).status_code==200
    thread.join(timeout=4);assert not thread.is_alive()
    assert store.get('jobs',job['id'])['status']=='failed' and not store.reports()


def test_noncooperative_detector_timeout(workspace,media_bytes,monkeypatch):
    from app.worker import Scheduler
    store,c,_=workspace;sid=create(c,media_bytes);seal(c,sid,media_bytes)
    job=c['W-02'].post(f'/v1/sessions/{sid}/analyze-offline',json={}).json()['job']
    monkeypatch.setenv('JOB_TIMEOUT_SECONDS','1')
    Scheduler(store,compute=slow_compute,isolate=True).tick()
    j=store.get('jobs',job['id']);assert j['status']=='failed' and '超' in j['error']
    assert not store.reports()


def test_branching_report_versions_are_unique(workspace,media_bytes):
    from conftest import published
    store,c,_=workspace;_,rid,_=published(workspace,media_bytes)
    a=c['W-02'].post(f'/v1/reports/{rid}/new-version',json={}).json()['id']
    b=c['W-02'].post(f'/v1/reports/{rid}/new-version',json={}).json()['id']
    assert [store.get_report(a)['version'],store.get_report(b)['version']]==[2,3]


def test_snapshot_binds_title_and_identity(workspace,media_bytes):
    store,c,_=workspace;sid,rid,run=analyzed(workspace,media_bytes);reviewed(workspace,sid,rid,run)
    r=store.get_report(rid);r['title']='changed after submission';store.upsert_report(r)
    assert c['R-01'].post(f'/v1/reports/{rid}/approve',json={}).status_code==409


def test_nested_wrong_types_are_validation_errors(workspace,media_bytes):
    _,c,_=workspace
    assert c['A-01'].post('/v1/admin/projects',json={'name':{}}).status_code==422
    assert c['A-01'].post('/v1/admin/users',json={'id':7,'role':'reader'}).status_code==422
    people=[dict(id={},role='subject',purposes={}),dict(id='P2',role='interviewer',purposes={})]
    response=c['W-02'].post('/v1/sessions',json=dict(consent_doc='TEST',participants=people))
    assert response.status_code==422


def test_reader_state_never_discloses_internal_draft_notes(workspace,media_bytes):
    from conftest import published
    store,c,_=workspace;_,rid,_=published(workspace,media_bytes)
    r=store.get_report(rid);r['revisions'].append(dict(ts='test',actor='internal',action='note',note='PRIVATE-DRAFT-COMMENT'));store.upsert_report(r)
    response=c['READ-01'].get('/v1/state');assert response.status_code==200
    report=response.json()['reports'][0]
    assert report['revisions']==[] and report['sections']==[] and 'snapshot' not in report
    assert 'PRIVATE-DRAFT-COMMENT' not in response.text
    assert c['READ-01'].get(f'/v1/reports/{rid}/read').json()['sections']


def test_published_presentation_survives_template_wording_changes(workspace,media_bytes,monkeypatch):
    from conftest import published
    from app import reporting
    store,c,_=workspace;_,rid,_=published(workspace,media_bytes)
    before=store.get_report(rid);assert before['snapshot']['presentation']
    html_before=reporting.render(before,'html','READ-01','内部测试')[0]
    monkeypatch.setattr(reporting,'DISCLAIMER','UNAPPROVED-TEMPLATE-TEXT')
    monkeypatch.setattr(main,'DISCLAIMER','UNAPPROVED-TEMPLATE-TEXT')
    html_after=reporting.render(before,'html','READ-01','内部测试')[0]
    csv_after=reporting.render(before,'csv','READ-01','内部测试')[0]
    assert html_after==html_before and b'UNAPPROVED-TEMPLATE-TEXT' not in csv_after
    response=c['READ-01'].get(f'/v1/reports/{rid}/read').json()
    assert response['sections']==before['snapshot']['presentation'] and response['disclaimer']==before['snapshot']['disclaimer']


def test_report_explicitly_labels_recorded_batch_origin_and_gaps(workspace,media_bytes):
    from app.worker import Scheduler
    from conftest import fake_compute
    store,c,_=workspace;sid=create(c,media_bytes,source='live',capture={'gaps':[{'kind':'pause','at':1.}]});seal(c,sid,media_bytes)
    assert c['W-02'].post(f'/v1/sessions/{sid}/capture-complete',json={'request_key':'gap'}).status_code==200
    Scheduler(store,compute=fake_compute).tick()
    report=store.get_report(store.get_session(sid)['offline']['report_id'])
    assert '现场录制，结束后批分析' in report['sections'][0]['text'] and '暂停/设备故障' in report['sections'][0]['text']
