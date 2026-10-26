import copy
import json
import os
from pathlib import Path
import pytest
from app import cli,main
from app.store import Store
from app.security import bootstrap
from conftest import published,PASSWORD


def test_backup_restore_hashes_restriction_and_corruption(workspace,media_bytes,monkeypatch,tmp_path):
    store,c,root=workspace;sid,rid,_=published(workspace,media_bytes)
    monkeypatch.setattr(cli,'DATA',root)
    destination=tmp_path.parent/(tmp_path.name+'-backup')
    cli.backup(store,destination)
    saved=store.get_report(rid)['content_hash']
    restored=Store(tmp_path/'restore.sqlite',database_url='');restored_root=root/'restored';monkeypatch.setattr(cli,'DATA',restored_root)
    with restored.transaction() as db:db['restrictions']=[dict(session_id=sid,restricted=True,note='post-backup withdrawal')]
    cli.restore(restored,destination)
    assert restored.get_session(sid)['restricted'] and restored.get_report(rid)['content_hash']==saved
    assert restored.db['tokens']=={} and restored.verify_chain()
    (destination/'database.json').write_text('tampered')
    fresh=Store(tmp_path/'fresh.sqlite',database_url='')
    with pytest.raises(ValueError,match='hash'):cli.restore(fresh,destination)
    assert not fresh.sessions()


def test_legacy_import_preserves_original_and_quarantines(workspace,monkeypatch,tmp_path):
    store,_,root=workspace;legacy=tmp_path/'legacy';legacy.mkdir()
    original=dict(sessions=[dict(id='LEGACY',subject_code='P',scene='旧记录',consent_doc='C',assets=[dict(id='audio:same.wav',name='same.wav',kind='audio',size_bytes=3,duration_seconds=1)])],reports=[dict(id='OLD-REPORT',text='original')])
    (legacy/'store.json').write_text(json.dumps(original));p=legacy/'uploads/LEGACY';p.mkdir(parents=True);(p/'same.wav').write_bytes(b'123')
    monkeypatch.setattr(cli,'DATA',root/'new');result=cli.migrate_legacy(store,legacy)
    assert result['restricted'] and result['missing']==0
    s=store.get_session('LEGACY');assert s['restricted'] and s['participants']==[]
    assert json.loads((legacy/'store.json').read_text())==original
    assert (root/'new/uploads/LEGACY/legacy-000.wav').read_bytes()==b'123'
    assert store.db['legacy_reports']==original['reports']


def test_project_admin_scope_and_distinct_people(workspace,media_bytes):
    store,c,_=workspace
    r=c['A-01'].post('/v1/admin/projects',json={'name':'隔离项目'});assert r.status_code==200;project=r.json()['id']
    assert c['W-02'].get('/v1/projects').json()==[dict(id='PRJ-LOCAL',name='本地访谈项目')]
    body=dict(id='SECOND',role='reviewer',person_id='W-02',password=PASSWORD,projects=[project])
    assert c['A-01'].post('/v1/admin/users',json=body).status_code==200
    assert store.get('users','SECOND')['person_id']=='W-02'
    assert c['A-01'].post('/v1/admin/users/SECOND/enabled',json={'enabled':False}).status_code==200


def test_postgres_adapter_real_concurrent_transactions():
    url=os.getenv('TEST_POSTGRES_URL')
    if not url:pytest.skip('set TEST_POSTGRES_URL for an isolated PostgreSQL database')
    from concurrent.futures import ThreadPoolExecutor
    a=Store(database_url=url);b=Store(database_url=url);base=len(a.db['audit'])
    with ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(lambda i:(a if i%2 else b).audit('QA','parallel',str(i)),range(20)))
    assert len(a.db['audit'])==base+20 and a.verify_chain()


def test_preflight_checks_executability_not_only_tool_path(workspace,tmp_path,monkeypatch):
    from app import model_dl
    bad=tmp_path/'bad-probe';bad.write_text('#!/bin/sh\nexit 1\n');bad.chmod(0o755)
    monkeypatch.setattr(cli,'FFPROBE',str(bad));monkeypatch.setattr(cli,'FFMPEG','/usr/bin/true')
    monkeypatch.setattr(model_dl,'ms_download',lambda _:tmp_path);monkeypatch.setattr(model_dl,'hf_download',lambda _:tmp_path)
    assert not cli.preflight()['checks']['ffprobe']['ok']


def test_operator_credentials_are_private(tmp_path):
    import stat
    target=tmp_path/'private-workspace'/'credentials.json'
    cli.secure_json(target,{'not_a_real_password':'test'})
    assert stat.S_IMODE(target.stat().st_mode)==0o600
    assert stat.S_IMODE(target.parent.stat().st_mode)==0o700
