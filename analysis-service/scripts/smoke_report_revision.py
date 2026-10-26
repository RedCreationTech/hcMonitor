"""Report-layer regression reuses real inference artifacts; it is not another algorithm evaluation."""
import os,sys,json,secrets,hashlib,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
os.environ['DATA_ROOT']=os.getenv('M1_REAL_DATA_ROOT',str(ROOT/'data/offline-validation/analysis-service/data/cold-qa-frozen'))
os.environ['DATABASE_URL']='';os.environ['WORKER_DISABLED']='1'

if __name__=='__main__':
    qa_root=Path(os.environ['DATA_ROOT']).resolve()
    evidence=json.loads((qa_root/'smoke-summary.json').read_text())
    if qa_root==(ROOT/'data/m1').resolve() or 'synthetic demo' not in evidence.get('fixture',''):
        raise ValueError('仅允许已有合成推理QA目录，禁止对业务数据库轮换账号')
    from app import main
    from app.security import password_hash
    from fastapi.testclient import TestClient
    store=main.store;old=next(r for r in store.reports() if r['status']=='published');old_hash=old['content_hash'];password=secrets.token_urlsafe(24)
    with store.transaction() as db:
        for user in db['users']:user['password']=password_hash(password)
        db['tokens']={};store.audit('QA','qa.rotate_credentials','isolated-report-regression')
    clients={}
    for uid in ['W-02','R-01','READ-01']:
        c=TestClient(main.app);r=c.post('/v1/auth/login',json=dict(employee=uid,pin=password));assert r.status_code==200,r.text;clients[uid]=c
    r=clients['W-02'].post(f"/v1/reports/{old['id']}/new-version",json={});assert r.status_code==200,r.text;rid=r.json()['id'];report=store.get_report(rid)
    r=clients['W-02'].post(f'/v1/reports/{rid}/section',json=dict(key='overview',text='来源：既有文件导入，离线批分析；复用已冻结的实际模型运行，仅做报告层版本回归。',revision=report['revision']));assert r.status_code==200,r.text
    r=clients['W-02'].post(f'/v1/reports/{rid}/submit',json=dict(revision=r.json()['revision']));assert r.status_code==200,r.text
    assert clients['R-01'].post(f'/v1/reports/{rid}/approve',json={}).status_code==200
    r=clients['R-01'].post(f'/v1/reports/{rid}/publish',json=dict(grants=[dict(recipient='READ-01',purpose='报告模板回归',actions=['read','download','print'],expires_at=time.time()+3600)]));assert r.status_code==200,r.text
    report=store.get_report(rid);assert report['snapshot']['presentation'] and any('系统能力与质量记录' in s['title'] for s in report['snapshot']['presentation'])
    output=ROOT.parent/'docs/qa-m1/runtime/final-report';output.mkdir(parents=True,exist_ok=True);exports=[]
    for fmt in ['pdf','html','csv']:
        r=clients['READ-01'].post(f'/v1/reports/{rid}/export',json=dict(format=fmt,purpose='报告模板回归'));assert r.status_code==200,r.text;x=r.json();blob=clients['READ-01'].get(x['url']);assert blob.status_code==200
        assert hashlib.sha256(blob.content).hexdigest()==x['hash'];(output/f'report.{fmt}').write_bytes(blob.content);exports.append(dict(format=fmt,sha256=x['hash'],bytes=len(blob.content)))
    assert store.get_report(old['id'])['content_hash']==old_hash
    summary=dict(passed=True,kind='report-layer regression, reuses frozen real inference',old_version_unchanged=True,old_report_id=old['id'],new_report_id=rid,new_version=report['version'],frozen_presentation=True,fixed_quality_appendix=True,code_snapshot_files=sum('/_code/' in '/'+f['path'] for f in report['snapshot']['result']['manifest']['files']),exports=exports,audit_chain=store.verify_chain())
    (ROOT.parent/'docs/qa-m1/report-revision-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),'utf-8');print(json.dumps(summary,ensure_ascii=False,indent=2))
