"""M1 LAN workspace: trusted identity, immutable runs, review and version grants."""
from __future__ import annotations
import asyncio
import copy
import hashlib
import json
import os
import re
import math
import secrets
import subprocess
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse
from fastapi import FastAPI, Depends, File, Form, HTTPException, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.exceptions import RequestValidationError
from .config import DATA, UPLOADS, ARTIFACTS, FFPROBE, MAX_UPLOAD_BYTES, DISCLAIMER, PIPELINE_VERSION
from .seed import now_str
from .store import Store
from .security import authenticate, check_password, password_hash, public_user, require, session_access
from .worker import Scheduler, enqueue, content_hash, TERMINAL
from . import reporting

store=Store(); scheduler=Scheduler(store)
ID=re.compile(r'^[A-Za-z0-9_-]{1,80}$')


@asynccontextmanager
async def lifespan(app):
    if os.getenv('WORKER_DISABLED')!='1': scheduler.start()
    yield
    scheduler.stop()


app=FastAPI(title='言心 M1',version='2.0.0',lifespan=lifespan)


@app.middleware('http')
async def boundary(request,call_next):
    rid=uuid.uuid4().hex
    if request.url.path.startswith('/v1/') and request.url.path not in ('/v1/auth/login','/v1/health'):
        try:authenticate(store,token_of(request))
        except HTTPException as exc:return JSONResponse(dict(code='UNAUTHENTICATED',message=str(exc.detail),request_id=rid),exc.status_code)
    try:length=int(request.headers.get('content-length','0'))
    except ValueError:return JSONResponse(dict(code='INVALID_INPUT',message='请求长度无效',request_id=rid),422)
    limit=MAX_UPLOAD_BYTES+2*1024*1024 if request.url.path.endswith('/assets') else 8*1024*1024
    if length>limit:return JSONResponse(dict(code='UPLOAD_TOO_LARGE',message='请求超过配置限额',request_id=rid),413)
    if request.method not in ('GET','HEAD','OPTIONS') and request.headers.get('origin'):
        origin=urlparse(request.headers['origin'])
        if origin.netloc!=request.headers.get('host'):
            return JSONResponse(dict(code='ORIGIN_REJECTED',message='请求来源不允许',request_id=rid),403)
    try: response=await call_next(request)
    except Exception:
        store.audit('系统','request.failed',rid)
        response=JSONResponse(dict(code='INTERNAL_ERROR',message='服务执行失败，请凭请求编号查询审计',request_id=rid),500)
    response.headers['X-Request-ID']=rid
    response.headers['X-Contract-Version']='2.0'
    response.headers['Cache-Control']='no-store'
    response.headers['X-Content-Type-Options']='nosniff'
    response.headers['Referrer-Policy']='no-referrer'
    return response


@app.exception_handler(HTTPException)
async def http_error(request,exc):
    return JSONResponse(dict(code={401:'UNAUTHENTICATED',403:'FORBIDDEN',404:'NOT_FOUND',409:'CONFLICT',422:'INVALID_INPUT'}.get(exc.status_code,'REQUEST_FAILED'),message=str(exc.detail),detail=exc.detail),exc.status_code)


@app.exception_handler(RequestValidationError)
async def input_error(request,exc):
    return JSONResponse(dict(code='INVALID_INPUT',message='请求参数格式不正确'),422)


def token_of(request):
    value=request.headers.get('authorization','')
    return value[7:] if value.startswith('Bearer ') else request.cookies.get('m1_session','')


def principal(request:Request): return authenticate(store,token_of(request))

def uid(prefix): return prefix+'-'+uuid.uuid4().hex[:16]

def need(condition,message,status=422):
    if not condition: raise HTTPException(status,message)

def expected(record,body):
    need(type(body.get('revision')) is int and body.get('revision')==record['revision'],'内容已变化，请保留本地草稿并重新载入',409)

def ses(sid,user,purpose='read'):
    return session_access(user,store.get_session(sid),purpose)

def mutable(s): need(s.get('status')!='closed' and not s.get('offline_job'),'会话已归档或作业进行中',409)

def consent(s,purpose):
    people=s.get('participants',[])
    return len(people)==2 and all(p.get('purposes',{}).get(purpose) and (not p.get('expires_at') or p['expires_at']>time.time()) for p in people)


def validate_people(people):
    need(isinstance(people,list) and len(people)==2 and all(isinstance(p,dict) for p in people),'首期需逐人登记两名参与者')
    need(all(isinstance(p.get('id'),str) and isinstance(p.get('role'),str) for p in people),'匿名编号与角色必须是文字')
    need({p.get('role') for p in people}=={'interviewer','subject'},'参与者角色无效')
    need(len({p.get('id') for p in people})==2 and all(isinstance(p.get('id'),str) and ID.fullmatch(p['id']) for p in people),'匿名参与者编号无效')
    for p in people:
        need(isinstance(p.get('purposes'),dict) and all(isinstance(v,bool) for v in p['purposes'].values()),'用途必须为明确布尔值')
        expires=p.get('expires_at')
        need(expires is None or isinstance(expires,(int,float)) and math.isfinite(expires) and expires>time.time(),'授权截止时间无效或已过期')
    return people


def public_session(s,user):
    result=copy.deepcopy(s)
    for a in result.get('assets',[]): a.pop('storage_key',None)
    if result.get('asset'): result['asset'].pop('storage_key',None)
    if user['role']=='collector':
        for key in ('offline','corrections'): result.pop(key,None)
    return result


def grant_for(report,user,action,purpose=None,grant_id=None):
    s=store.get_session(report['session_id'])
    need(s and not s.get('restricted') and consent(s,'report'),'报告用途已受限',403)
    need(report['status']=='published','仅已发布版本可阅读或导出',409)
    for g in report.get('grants',[]):
        if g['recipient']==user['id'] and action in g['actions'] and g['expires_at']>time.time() and not g.get('revoked') and (purpose is None or purpose==g['purpose']) and (not grant_id or g['id']==grant_id): return g
    raise HTTPException(403,'缺少此版本、人、用途或动作的有效授权')


def report_access(rid,user,action='read'):
    r=store.get_report(rid); need(r,'报告不存在',404)
    if r.get('snapshot') and r['status'] in ('pending_review','approved','published'):
        need(r['snapshot'].get('metadata')=={k:r.get(k) for k in ('id','session_id','subject_code','title','version','source_run_id','source_hash')} and r['content_hash']==content_hash(r['snapshot']),'报告具体内容与版本指纹不一致',409)
    if user['role']=='reader': grant_for(r,user,'read');return r
    ses(r['session_id'],user,'review' if user['role']=='reviewer' else 'read')
    return r


def fresh(report):
    s=store.get_session(report['session_id'])
    need(not s.get('stale') and s.get('current_run_id')==report['source_run_id'] and s['revision']==report['source_revision'],'报告引用已过时，需重算并重新复核',409)
    need(consent(s,'report') and consent(s,'review'),'报告或复核用途未获授权',403)
    run=store.get('runs',report['source_run_id'])
    need(run and run.get('result_hash')==report['source_hash'],'来源快照不一致',409)
    if report['status'] in ('pending_review','approved'):
        need(report['snapshot']['reviews']==current_reviews(report['source_run_id']),'送审后的复核决定已变化，请驳回并重新送审',409)
    return s,run


def visible_state(user):
    sessions=[]; reports=[]
    for s in store.sessions():
        try:
            if user['role']=='collector': ses(s['id'],user,'capture')
            else: ses(s['id'],user)
            sessions.append(public_session(s,user))
        except HTTPException: pass
    for r in store.reports():
        try:
            report_access(r['id'],user)
            item=copy.deepcopy(r)
            item.pop('snapshot',None)
            if r.get('snapshot',{}).get('presentation'):item['preview_sections']=r['snapshot']['presentation']
            if user['role']=='reader':
                item={k:r.get(k) for k in ('id','session_id','subject_code','title','status','version','source_run_id','content_hash','origin','published_at')}
                item.update(sections=[],assets=[],revisions=[],reviewer=None,precision_note=None,
                    grants=[g for g in r.get('grants',[]) if g['recipient']==user['id']])
            reports.append(item)
        except HTTPException: pass
    audit=[]
    if user['role'] in ('admin','auditor'):
        project_ids=set(user['projects']);visible_ids=set(project_ids)|{user['id']}
        owned_sessions={s['id'] for s in store.sessions() if s.get('project_id') in project_ids};visible_ids|=owned_sessions
        for collection in ('reports','jobs','runs','exports'):
            for item in store.collection(collection):
                if item.get('session_id') in owned_sessions or item.get('project_id') in project_ids or item.get('report_id') in visible_ids:visible_ids.add(item['id'])
        visible_ids|={u['id'] for u in store.collection('users') if set(u['projects'])&project_ids}
        audit=[e for e in store.db['audit'] if e['resource'].split('/')[0] in visible_ids][-100:]
    # No raw payload is broadcast to unassigned seats or non-workstation channels.
    return dict(session_id='offline',running=False,clock=0,speed=1,form='B',field_view_enabled=False,consent=True,
        lamp='green',advice='',buffer_seconds=0,weak_network=False,modality_health={m:'off' for m in ['voice','semantic','face','pose','hand','physio']},
        collector=dict(device='局域网工作站',person=user['name'],authed_until=None),viewer=dict(person=user['name'],channel='workstation'),
        markers=[],tickets=[],anomalies=[],impacts=[],turns=[],audit=audit,sessions=sessions,reports=reports,annotations=[],rules=[],
        members=[dict(id=u['id'],name=u['name'],role=u['role'],seat=u['seat'],online=True,forms=['B']) for u in store.collection('users') if set(u['projects'])&set(user['projects'])],
        integrations=[],admin=dict(form_d_enabled=False,field_view_enabled=False,modality_whitelist_d=[],retention_days=0,auto_escalate_seconds=0,annotation_reflow=False),local_cache_bytes=0)


@app.get('/v1/health')
def health(): return dict(status='ok',pipeline=PIPELINE_VERSION,mode='real',storage='postgresql' if store.postgres else 'sqlite',initialized=bool(store.collection('users')))


@app.post('/v1/auth/login')
def login(body:dict,response:Response):
    employee=str(body.get('employee','')).strip().upper();password=str(body.get('pin',''))
    with store.transaction() as db:
        u=store.get('users',employee)
        valid=u and u.get('enabled') and u.get('locked_until',0)<=time.time() and check_password(password,u['password'])
        if not valid:
            if u:
                u['failed']=u.get('failed',0)+1
                if u['failed']>=3: u['locked_until']=time.time()+900
                store.put('users',u)
            store.audit('匿名','auth.login_failed',employee[:30])
        else:
            u.update(failed=0,locked_until=0);store.put('users',u)
            token=secrets.token_urlsafe(32);db['tokens'][hashlib.sha256(token.encode()).hexdigest()]=dict(user_id=u['id'],expires=time.time()+8*3600)
            store.audit(u['id'],'auth.login',u['id'])
    need(valid,'账号、口令错误或账号已锁定',401)
    response.set_cookie('m1_session',token,httponly=True,samesite='strict',secure=os.getenv('COOKIE_SECURE')=='1',max_age=8*3600)
    return dict(ok=True,member=public_user(u))


@app.get('/v1/auth/me')
def me(user=Depends(principal)): return dict(member=public_user(user))


@app.post('/v1/auth/logout')
def logout(request:Request,response:Response,user=Depends(principal)):
    with store.transaction() as db:
        db['tokens'].pop(hashlib.sha256(token_of(request).encode()).hexdigest(),None)
        store.audit(user['id'],'auth.logout',user['id'])
    response.delete_cookie('m1_session');return dict(ok=True)


@app.post('/v1/auth/password')
def change_password(body:dict,user=Depends(principal)):
    need(check_password(body.get('old',''),user['password']),'原口令错误',403)
    need(len(body.get('password',''))>=12,'新口令至少12位')
    with store.transaction() as db:
        user['password']=password_hash(body['password']);store.put('users',user)
        db['tokens']={k:v for k,v in db['tokens'].items() if v['user_id']!=user['id']}
        store.audit(user['id'],'auth.password',user['id'])
    return dict(ok=True)


@app.get('/v1/state')
def state(user=Depends(principal)): return visible_state(user)


@app.websocket('/v1/analysis/stream')
async def stream(ws:WebSocket,channel:str='workstation'):
    try:
        need(channel=='workstation','此通道未开放',403)
        origin=ws.headers.get('origin')
        need(not origin or urlparse(origin).netloc==ws.headers.get('host'),'来源不允许',403)
        authenticate(store,ws.cookies.get('m1_session',''))
    except HTTPException: await ws.close(code=4403);return
    await ws.accept()
    store.audit(authenticate(store,ws.cookies.get('m1_session',''))['id'],'state.subscribe','workstation')
    try:
        last=None
        while True:
            user=authenticate(store,ws.cookies.get('m1_session',''))
            snapshot=visible_state(user);digest=content_hash(snapshot)
            if digest!=last: await ws.send_json(dict(event='state',ts=time.time(),payload=snapshot));last=digest
            try:
                message=await asyncio.wait_for(ws.receive(),timeout=1)
                if message['type']=='websocket.disconnect':break
            except asyncio.TimeoutError:pass
    except (WebSocketDisconnect,RuntimeError): pass
    except HTTPException: await ws.close(code=4401)


@app.get('/v1/sessions')
def list_sessions(user=Depends(principal)): return visible_state(user)['sessions']


@app.post('/v1/sessions')
def create_session(body:dict,user=Depends(principal)):
    require(user,'capture')
    project=body.get('project_id','PRJ-LOCAL');need(project in user['projects'],'项目不可见',404)
    need(isinstance(body.get('consent_doc'),str) and body['consent_doc'].strip(),'缺少告知文书号',403)
    participants=validate_people(body.get('participants',[]))
    need(len(participants)==2 and {p.get('role') for p in participants}=={'interviewer','subject'},'首期需逐人登记访谈员和受访者')
    need(len({p.get('id') for p in participants})==2 and all(isinstance(p.get('id'),str) and ID.fullmatch(p['id']) for p in participants),'匿名参与者编号无效')
    need(all(p.get('purposes',{}).get('capture') and p.get('purposes',{}).get('analyze') for p in participants),'采集与分析用途未逐人授权',403)
    assets=body.get('assets',[]);need(isinstance(assets,list) and 1<=len(assets)<=12 and all(isinstance(a,dict) for a in assets),'需登记1至12份素材')
    need(all(isinstance(a.get('id'),str) for a in assets),'素材编号必须是文字')
    need(len({a.get('id') for a in assets})==len(assets),'素材ID重复')
    for a in assets:
        need(isinstance(a.get('id'),str) and ID.fullmatch(a['id']) and a.get('kind') in ('audio','video','nir','mmwave'),'素材编号或类型无效')
        need(isinstance(a.get('name'),str) and 0<len(a['name'])<=180 and '/' not in a['name'] and '\\' not in a['name'],'素材名称无效')
        need(type(a.get('size_bytes')) is int and 0<a['size_bytes']<=MAX_UPLOAD_BYTES,'素材大小超出范围')
        a.update(upload_status='pending',duration_seconds=0)
    primary=body.get('primary_asset_id') or next((a['id'] for a in assets if a['kind'] in ('audio','video')),None)
    need(isinstance(primary,str) and primary in {a['id'] for a in assets if a['kind'] in ('audio','video')},'须显式选择音视频主素材')
    analyst=body.get('analyst_id',user['id'] if user['role']=='analyst' else 'W-02');reviewer=body.get('reviewer_id','R-01')
    for identifier,role in [(analyst,'analyst'),(reviewer,'reviewer')]:
        member=store.get('users',identifier);need(member and member['role']==role and project in member['projects'],'分派成员与项目不匹配')
    s=dict(id=uid('SES'),project_id=project,subject_code=str(body.get('subject_code','匿名对象'))[:80],scene=str(body.get('scene','访谈'))[:120],
        form='B',collector=user['name'],analyst=analyst,owner_id=user['id'],analyst_id=analyst,reviewer_id=reviewer,
        status='draft',started_at=now_str(),duration_seconds=0,peak_lamp='green',anomaly_count=0,marker_count=0,
        consent_doc=body['consent_doc'],participants=participants,modality_set=[],source='live' if body.get('source')=='live' else 'imported',
        assets=assets,asset=assets[0],primary_asset_id=primary,capture=body.get('capture'),offline_job=None,offline=None,revision=1,stale=False,restricted=False)
    with store.transaction(): store.upsert_session(s);store.audit(user['id'],'session.create',s['id'])
    return dict(id=s['id'],revision=1)


def probe(path,kind):
    if kind in ('audio','video'):
        r=subprocess.run([FFPROBE,'-v','error','-show_format','-show_streams','-of','json',str(path)],capture_output=True,text=True,timeout=30)
        need(r.returncode==0,'素材无法解码')
        metadata=json.loads(r.stdout);streams=metadata.get('streams',[])
        need(any(x.get('codec_type')=='audio' for x in streams),'音视频须有可解析音轨')
        if kind=='video': need(any(x.get('codec_type')=='video' for x in streams),'登记为视频但不含视频轨')
        raw=metadata.get('format',{}).get('duration','0')
        try: duration=float(raw)
        except ValueError: duration=0
        return round(duration),metadata
    from .pipeline.series import load
    cols,duration=load(path);need(len(next(iter(cols.values())))>=30,'采样行数不足30')
    return round(duration),dict(columns=list(cols))


@app.post('/v1/sessions/{sid}/assets')
async def upload_asset(sid:str,file:UploadFile=File(...),kind:str=Form(...),asset_id:str=Form(...),client_duration:float=Form(0),user=Depends(principal)):
    s=ses(sid,user,'capture');mutable(s)
    asset=next((a for a in s['assets'] if a['id']==asset_id),None);need(asset and asset['kind']==kind,'未知素材或类型不一致',404)
    need(asset.get('upload_status')!='complete','原件已封存，不允许覆盖',409)
    target=UPLOADS/sid;target.mkdir(parents=True,exist_ok=True)
    key=uid('blob')+Path(asset['name']).suffix.lower();temp=target/(key+'.partial');dest=target/key
    digest=hashlib.sha256();size=0
    try:
        with temp.open('xb') as f:
            while chunk:=await file.read(1024*1024):
                size+=len(chunk);need(size<=MAX_UPLOAD_BYTES and size<=asset['size_bytes'],'上传超过登记大小或系统限额',413)
                digest.update(chunk);f.write(chunk)
            f.flush();os.fsync(f.fileno())
        need(size==asset['size_bytes'],'素材字节数与登记不一致，原件未封存',409)
        try:duration,metadata=probe(temp,kind)
        except (ValueError,subprocess.TimeoutExpired) as exc: raise HTTPException(422,'素材预检失败：'+str(exc))
        # File naming is independent of user filenames. The transaction rechecks concurrent finalization.
        with store.transaction():
            s=ses(sid,user,'capture');mutable(s);a=next(a for a in s['assets'] if a['id']==asset_id)
            need(a.get('upload_status')!='complete','素材已被另一次上传封存',409)
            temp.replace(dest)
            a.update(storage_key=key,sha256=digest.hexdigest(),size_bytes=size,duration_seconds=duration,upload_status='complete',probe=metadata)
            s['asset']=s['assets'][0];store.upsert_session(s);store.audit(user['id'],'asset.seal',f"{sid}/{asset_id}/{a['sha256']}")
        return dict(ok=True,sha256=digest.hexdigest(),duration_seconds=duration,size_bytes=size)
    finally: temp.unlink(missing_ok=True);await file.close()


@app.get('/v1/sessions/{sid}/assets/{aid}/media')
def media(sid:str,aid:str,request:Request,user=Depends(principal)):
    s=ses(sid,user);a=next((a for a in s['assets'] if a['id']==aid),None)
    need(a and a.get('storage_key'),'素材不存在',404)
    p=UPLOADS/sid/a['storage_key'];need(p.is_file(),'原件不可用',404);size=p.stat().st_size
    start,end=0,size-1;range_header=request.headers.get('range');status=200
    if range_header:
        match=re.fullmatch(r'bytes=(\d*)-(\d*)',range_header);need(match and any(match.groups()),'Range无效',416)
        lo,hi=match.groups()
        if not lo: start=max(0,size-int(hi))
        else: start=int(lo);end=min(size-1,int(hi) if hi else size-1)
        need(0<=start<=end<size,'Range超出范围',416);status=206
    def chunks():
        with p.open('rb') as f:
            f.seek(start);remaining=end-start+1
            while remaining:
                # Access is checked again for every chunk; revocation stops existing streams too.
                try:
                    current_user=authenticate(store,token_of(request));ses(sid,current_user)
                except HTTPException:return
                chunk=f.read(min(256*1024,remaining))
                if not chunk:return
                remaining-=len(chunk);yield chunk
    import mimetypes
    headers={'Accept-Ranges':'bytes','Content-Length':str(end-start+1)}
    if status==206:headers['Content-Range']=f'bytes {start}-{end}/{size}'
    store.audit(user['id'],'media.read',f'{sid}/{aid}/{start}-{end}')
    return StreamingResponse(chunks(),status_code=status,headers=headers,media_type=mimetypes.guess_type(a['name'])[0] or 'application/octet-stream')


@app.post('/v1/sessions/{sid}/analyze-offline')
def analyze(sid:str,body:dict,user=Depends(principal)):
    require(user,'analyze')
    with store.transaction():
        s=ses(sid,user);need(s['status']!='closed','已归档不可重算',409)
        need(consent(s,'analyze'),'分析用途未授权或过期',403)
        need(all(a.get('upload_status')=='complete' for a in s['assets']),'素材尚未完整上传及封存',409)
        job=enqueue(store,s,user,body.get('request_key'))
    return dict(ok=True,job=job)


@app.get('/v1/sessions/{sid}/runs')
def runs(sid:str,user=Depends(principal)):
    ses(sid,user)
    return [{k:v for k,v in r.items() if k not in ('input','result')} for r in store.collection('runs') if r['session_id']==sid]


@app.get('/v1/runs/{rid}')
def run_detail(rid:str,user=Depends(principal)):
    r=store.get('runs',rid);need(r,'运行不存在',404);ses(r['session_id'],user);return r


@app.get('/v1/sessions/{sid}/jobs')
def jobs(sid:str,user=Depends(principal)):
    ses(sid,user);return [j for j in store.collection('jobs') if j['session_id']==sid]


@app.post('/v1/jobs/{jid}/cancel')
def cancel(jid:str,user=Depends(principal)):
    require(user,'analyze')
    with store.transaction():
        j=store.get('jobs',jid);need(j,'作业不存在',404);s=ses(j['session_id'],user)
        need(j['status'] not in TERMINAL,'作业已结束',409)
        j['cancel_requested']=True
        if j['status']=='queued':
            j['status']='cancelled';s['offline_job']=None;store.upsert_session(s)
            run=store.get('runs',j['run_id']);run['status']='cancelled';store.put('runs',run)
        store.put('jobs',j);store.audit(user['id'],'job.cancel',jid)
    return dict(ok=True)


def validate_corrections(s,body):
    turns=body.get('turns',[]);topics=body.get('topics',[])
    need(isinstance(turns,list) and 0<len(turns)<=20000 and all(isinstance(t,dict) for t in turns),'转写轮次为空或超过上限')
    assets={a['id']:a for a in s['assets']};people={p['id']:p['role'] for p in s['participants']}
    need(len({t.get('id') for t in turns})==len(turns),'轮次编号重复')
    last={}
    for t in turns:
        need(isinstance(t.get('id'),str) and ID.fullmatch(t['id']) and isinstance(t.get('asset_id'),str) and t.get('asset_id') in assets,'轮次或素材编号无效')
        need(t.get('speaker') in ('interviewer','subject','unknown','overlap'),'角色无效')
        need(isinstance(t.get('text'),str) and 0<len(t['text'])<=10000,'转写文字无效')
        need(isinstance(t.get('ts'),(int,float)) and isinstance(t.get('end'),(int,float)) and math.isfinite(t['ts']) and math.isfinite(t['end']) and 0<=t['ts']<t['end']<=assets[t['asset_id']].get('duration_seconds',0)+1,'轮次时段超出素材')
        if t['speaker'] in ('unknown','overlap'): need(not t.get('participant_id'),'未知或重叠不能绑定个人')
        else: need(people.get(t.get('participant_id'))==t['speaker'],'角色与参与者绑定不一致')
        need(t['ts']>=last.get(t['asset_id'],-1),'轮次必须按时序排列')
        last[t['asset_id']]=t['end'] if t['speaker']!='overlap' else t['ts']
    need(isinstance(topics,list) and all(isinstance(t,dict) for t in topics),'话题列表无效')
    last={}
    for topic in topics:
        need(isinstance(topic.get('asset_id'),str) and topic.get('asset_id') in assets and str(topic.get('label','')).strip(),'话题来源与标题必填')
        bound=topic.get('boundary',[]);need(len(bound)==2 and all(isinstance(v,(int,float)) and math.isfinite(v) for v in bound) and 0<=bound[0]<bound[1]<=assets[topic['asset_id']].get('duration_seconds',0)+1,'话题边界无效')
        need(bound[0]>=last.get(topic['asset_id'],0),'话题边界不能重叠');last[topic['asset_id']]=bound[1]
    return dict(turns=turns,topics=topics)


@app.post('/v1/sessions/{sid}/corrections')
def corrections(sid:str,body:dict,user=Depends(principal)):
    require(user,'edit')
    with store.transaction():
        s=ses(sid,user);mutable(s);expected(s,body);need(s.get('offline'),'尚无可校正转写',409)
        corrected=validate_corrections(s,body)
        s['corrections']=corrected;s['revision']+=1;s['stale']=True
        store.upsert_session(s);store.audit(user['id'],'evidence.revise',f"{sid}/revision{s['revision']}")
    return dict(ok=True,revision=s['revision'],stale=True,impact='全素材重算；旧run、原文、复核及已发布报告保留')


@app.post('/v1/sessions/{sid}/events/{eid}/review')
def review_event(sid:str,eid:str,body:dict,user=Depends(principal)):
    require(user,'review')
    with store.transaction():
        s=ses(sid,user,'review');need(user['id']==s['reviewer_id'],'非本任务指定复核人',403)
        need(not s.get('stale') and body.get('run_id')==s.get('current_run_id'),'引用已过时',409)
        r=store.get('runs',s['current_run_id']);need(user['person_id']!=r.get('actor_person_id'),'同一自然人不能独立复核自己运行的证据',403);result=r['result'];e=next((e for e in result['anomalies'] if e['id']==eid),None)
        need(e,'证据不存在',404)
        need(body.get('behavior') in ('confirmed','rejected','abstain') and body.get('explanation') in ('supported','rejected','abstain'),'复核决定无效')
        need(isinstance(body.get('note'),str) and body['note'].strip(),'复核理由必填')
        if body['explanation']=='supported':
            need(body['behavior']=='confirmed' and not e.get('cap_note') and e.get('participant_id'),'封顶、未知归属或不成立行为不能支持心理解释')
        review=dict(behavior=body['behavior'],explanation=body['explanation'],note=body['note'][:4000],reviewer_id=user['id'],person_id=user['person_id'],at=now_str(),run_id=r['id'])
        # Reviews are append-only, separate from immutable algorithm result/hash.
        db=store.db; db.setdefault('reviews',[]).append(dict(id=uid('REV'),session_id=sid,event_id=eid,**review))
        store.audit(user['id'],'evidence.review',f"{r['id']}/{eid}")
    return dict(ok=True,review=review)


def current_reviews(run_id):
    out={}
    for review in store.db.get('reviews',[]):
        if review['run_id']==run_id:out[review['event_id']]=review
    return out


@app.get('/v1/runs/{rid}/reviews')
def reviews(rid:str,user=Depends(principal)):
    r=store.get('runs',rid);need(r,'运行不存在',404);ses(r['session_id'],user,'review' if user['role']=='reviewer' else 'read')
    return current_reviews(rid)


@app.post('/v1/reports/{rid}/section')
def section(rid:str,body:dict,user=Depends(principal)):
    require(user,'edit')
    with store.transaction():
        r=report_access(rid,user);expected(r,body)
        need(r['status'] in ('drafting','rejected'),'此版本已锁定，请创建新版本',409)
        sec=next((s for s in r['sections'] if s['key']==body.get('key')),None);need(sec,'章节不存在',404)
        need(isinstance(body.get('text'),str) and len(body['text'])<=50000,'章节文字无效')
        if sec['key']=='limit':need(DISCLAIMER in body['text'],'免责原文必须完整保留')
        sec['text']=body['text'];r['revision']+=1;r['author_id']=user['id'];r['author_person_id']=user['person_id']
        r['revisions'].append(dict(ts=now_str(),actor=user['id'],action='edit',note=sec['key']))
        store.upsert_report(r);store.audit(user['id'],'report.edit',rid)
    return dict(ok=True,revision=r['revision'])


@app.post('/v1/reports/{rid}/submit')
def submit(rid:str,body:dict,user=Depends(principal)):
    require(user,'review_request')
    with store.transaction():
        r=report_access(rid,user);expected(r,body);need(r['status'] in ('drafting','rejected'),'当前状态不可提交',409)
        s,run=fresh(r);review=current_reviews(run['id'])
        need(all(e['id'] in review for e in run['result']['anomalies']),'每条证据须先完成行为与解释的独立复核',409)
        need(any(sec['key']=='limit' and DISCLAIMER in sec['text'] for sec in r['sections']),'缺少完整免责章节')
        snapshot=dict(metadata={k:r.get(k) for k in ('id','session_id','subject_code','title','version','source_run_id','source_hash')},sections=copy.deepcopy(r['sections']),result=copy.deepcopy(run['result']),reviews=review)
        snapshot['disclaimer']=DISCLAIMER
        _,presentation=reporting.document({**r,'snapshot':snapshot,'content_hash':'送审前'})
        snapshot['presentation']=[dict(key=f'frozen-{i}',title=title,text=text) for i,(title,text) in enumerate(presentation)]
        r.update(status='pending_review',snapshot=snapshot,content_hash=content_hash(snapshot),reviewer=s['reviewer_id'],reviewer_id=s['reviewer_id'])
        r['revisions'].append(dict(ts=now_str(),actor=user['id'],action='submit'))
        store.upsert_report(r);store.audit(user['id'],'report.submit',rid)
    return dict(ok=True,content_hash=r['content_hash'])


def reviewer(r,user):
    require(user,'review')
    need(user['id']==r['reviewer_id'],'非指定复核人',403)
    need(user['person_id']!=r['author_person_id'],'同一自然人不能批准自己的报告',403)


@app.post('/v1/reports/{rid}/approve')
def approve(rid:str,body:dict,user=Depends(principal)):
    with store.transaction():
        r=report_access(rid,user);reviewer(r,user);fresh(r)
        need(r['status']=='pending_review','仅待复核版本可批准',409)
        need(r['content_hash']==content_hash(r['snapshot']),'送审内容hash不一致',409)
        r.update(status='approved',approved_hash=r['content_hash'],approved_by=user['id'])
        r['revisions'].append(dict(ts=now_str(),actor=user['id'],action='approve'));store.upsert_report(r);store.audit(user['id'],'report.approve',rid)
    return dict(ok=True)


@app.post('/v1/reports/{rid}/reject')
def reject(rid:str,body:dict,user=Depends(principal)):
    with store.transaction():
        r=report_access(rid,user);reviewer(r,user);need(r['status']=='pending_review','仅待复核可驳回',409)
        need(isinstance(body.get('note'),str) and body['note'].strip(),'驳回理由必填')
        r['status']='rejected';r['revisions'].append(dict(ts=now_str(),actor=user['id'],action='reject',note=body['note'][:4000]))
        store.upsert_report(r);store.audit(user['id'],'report.reject',rid)
    return dict(ok=True)


def validate_grants(grants,report):
    need(isinstance(grants,list) and 1<=len(grants)<=100,'至少授予一名接收人阅读权限')
    result=[]
    for g in grants:
        need(isinstance(g,dict),'授权格式无效')
        u=store.get('users',g.get('recipient'))
        need(u and u.get('enabled') and report['project_id'] in u['projects'],'接收人不属于项目')
        actions=g.get('actions',[]);need(isinstance(actions,list) and all(isinstance(a,str) for a in actions) and 'read' in actions and set(actions)<={'read','download','print'},'动作需包含阅读且限阅读/下载/打印')
        need(isinstance(g.get('expires_at'),(int,float)) and math.isfinite(g['expires_at']) and time.time()<g['expires_at']<=time.time()+366*86400,'授权需指定未来一年以内的截止时间')
        need(isinstance(g.get('purpose'),str) and g['purpose'].strip(),'用途必填')
        result.append(dict(id=uid('GRANT'),recipient=u['id'],purpose=g['purpose'][:200],actions=actions,expires_at=g['expires_at'],revoked=False,report_id=report['id']))
    return result


@app.post('/v1/reports/{rid}/publish')
def publish(rid:str,body:dict,user=Depends(principal)):
    with store.transaction():
        r=report_access(rid,user);reviewer(r,user)
        if r['status']=='published':return dict(ok=True,id=rid,already_published=True)
        fresh(r);need(r['status']=='approved' and r.get('approved_hash')==content_hash(r['snapshot']),'仅已批准具体内容可发布',409)
        r['grants']=validate_grants(body.get('grants',[]),r);r.update(status='published',published_at=now_str())
        r['revisions'].append(dict(ts=now_str(),actor=user['id'],action='publish'));store.upsert_report(r);store.audit(user['id'],'report.publish',rid)
    return dict(ok=True,id=rid)


@app.post('/v1/reports/{rid}/grants')
def grants(rid:str,body:dict,user=Depends(principal)):
    require(user,'grant')
    with store.transaction():
        r=report_access(rid,user);reviewer(r,user);need(r['status']=='published','尚未发布',409)
        r['grants']+=validate_grants(body.get('grants',[]),r);store.upsert_report(r);store.audit(user['id'],'grant.create',rid)
    return dict(ok=True)


@app.post('/v1/reports/{rid}/grants/{gid}/revoke')
def revoke(rid:str,gid:str,body:dict,user=Depends(principal)):
    require(user,'grant')
    with store.transaction():
        r=report_access(rid,user);reviewer(r,user);g=next((g for g in r['grants'] if g['id']==gid),None);need(g,'授权不存在',404)
        g['revoked']=True;store.upsert_report(r);store.audit(user['id'],'grant.revoke',gid)
    return dict(ok=True)


@app.post('/v1/reports/{rid}/new-version')
def new_version(rid:str,body:dict,user=Depends(principal)):
    require(user,'edit')
    with store.transaction():
        r=report_access(rid,user);need(r['status'] in ('approved','published'),'此状态无需另建版本',409)
        next_version=max(x.get('version',1) for x in store.reports() if x['session_id']==r['session_id'])+1
        clone=copy.deepcopy(r);clone.update(id=uid('RP'),parent_id=rid,status='drafting',version=next_version,revision=1,grants=[],published_at=None,
            author_id=user['id'],author_person_id=user['person_id'],revisions=[dict(ts=now_str(),actor=user['id'],action='create',note='由 '+rid+' 创建新版')])
        for k in ('snapshot','content_hash','approved_hash','approved_by'):clone.pop(k,None)
        store.upsert_report(clone);store.audit(user['id'],'report.new_version',clone['id'])
    return dict(id=clone['id'])


@app.get('/v1/reports/{rid}/read')
def read_report(rid:str,user=Depends(principal)):
    r=report_access(rid,user);g=grant_for(r,user,'read');store.audit(user['id'],'report.read',rid)
    return dict(report_id=rid,version=r['version'],content_hash=r['content_hash'],sections=r['snapshot'].get('presentation',r['snapshot']['sections']),grant=g,disclaimer=r['snapshot'].get('disclaimer',DISCLAIMER))


@app.post('/v1/reports/{rid}/export')
def export_report(rid:str,body:dict,user=Depends(principal)):
    fmt=body.get('format','pdf');action='print' if body.get('mode')=='print' else 'download'
    need(fmt in ('pdf','html','csv'),'格式无效')
    with store.transaction():
        r=report_access(rid,user);g=grant_for(r,user,action,body.get('purpose'),body.get('grant_id'))
        need(body.get('purpose')==g['purpose'],'导出用途必须与授权一致',403)
        record=dict(id=uid('EXPORT'),report_id=rid,recipient=user['id'],grant_id=g['id'],purpose=g['purpose'],action=action,status='generating',format=fmt)
        store.put('exports',record);store.audit(user['id'],'export.request',record['id'])
    try:
        data,mime=reporting.render(r,fmt,user['id'],g['purpose']);digest=hashlib.sha256(data).hexdigest()
        target=DATA/'exports';target.mkdir(parents=True,exist_ok=True);dest=target/(record['id']+'.'+fmt)
        dest.write_bytes(data)
        with store.transaction():
            latest=store.get_report(rid);grant_for(latest,user,action,g['purpose'],g['id'])
            record.update(status='ready',sha256=digest,mime=mime,path=dest.name,bytes=len(data));store.put('exports',record);e=store.audit(user['id'],'export.ready',record['id'])
        return dict(ok=True,id=record['id'],status='ready',filename=rid+'.'+fmt,hash=digest,audit_seq=e['seq'],url='/v1/exports/'+record['id']+'/file')
    except Exception as exc:
        record.update(status='failed',error=str(exc)[:300]);store.put('exports',record);store.audit(user['id'],'export.failed',record['id'])
        if isinstance(exc,HTTPException):raise
        raise HTTPException(422,'导出失败：'+str(exc))


@app.get('/v1/exports/{xid}/file')
def export_file(xid:str,user=Depends(principal)):
    with store.transaction():
        x=store.get('exports',xid);need(x and x['recipient']==user['id'],'文件不存在',404)
        need(x['status']=='ready','文件尚未生成完成',409)
        r=report_access(x['report_id'],user);grant_for(r,user,x['action'],x['purpose'],x['grant_id'])
        path=DATA/'exports'/x['path'];need(path.is_file(),'导出文件不存在',404);data=path.read_bytes()
        need(hashlib.sha256(data).hexdigest()==x['sha256'],'导出文件指纹不一致',409)
        store.audit(user['id'],'export.deliver',xid)
    return Response(data,media_type=x['mime'],headers={'Content-Disposition':f'attachment; filename="{r["id"]}.{x["format"]}"','X-Artifact-SHA256':x['sha256']})


@app.post('/v1/sessions/{sid}/analyze-offline/csv')
def old_csv(sid:str,body:dict,user=Depends(principal)):
    s=ses(sid,user);need(s.get('offline'),'无分析产物',404)
    raise HTTPException(409,'请从已发布报告按具体版本授权导出CSV')


@app.get('/v1/admin/overview')
def admin_overview(user=Depends(principal)):
    require(user,'manage')
    return dict(projects=[p for p in store.collection('projects') if p['id'] in user['projects']],users=[public_user(u) for u in store.collection('users') if set(u['projects'])&set(user['projects'])],
        sessions=[{k:s.get(k) for k in ('id','project_id','owner_id','analyst_id','reviewer_id','restricted','revision','status')} for s in store.sessions() if s.get('project_id') in user['projects']],
        storage='postgresql' if store.postgres else 'sqlite',policy='手动留存；不自动删除；研究/训练用途未开放')


@app.post('/v1/admin/sessions/{sid}/assignment')
def assignment(sid:str,body:dict,user=Depends(principal)):
    require(user,'manage')
    with store.transaction():
        s=store.get_session(sid);need(s and s['project_id'] in user['projects'],'任务不可见',404);mutable(s);expected(s,body)
        for key,role in [('owner_id','collector'),('analyst_id','analyst'),('reviewer_id','reviewer')]:
            if key in body:
                u=store.get('users',body[key]);need(u and u['role']==role and s['project_id'] in u['projects'],'分派无效')
                s[key]=body[key]
        s['revision']+=1
        if s.get('offline'):s['stale']=True
        store.upsert_session(s);store.audit(user['id'],'assignment.change',sid)
    return dict(ok=True)


@app.post('/v1/admin/sessions/{sid}/restrict')
def restrict(sid:str,body:dict,user=Depends(principal)):
    require(user,'manage');need(isinstance(body.get('note'),str) and body['note'].strip(),'用途限制理由必填')
    with store.transaction() as db:
        s=store.get_session(sid);need(s and s['project_id'] in user['projects'],'任务不可见',404)
        s['restricted']=bool(body.get('restricted',True));s['restriction_note']=body['note'][:2000]
        store.upsert_session(s)
        db.setdefault('restrictions',[]).append(dict(id=uid('RES'),session_id=sid,restricted=s['restricted'],note=body['note'],at=now_str()))
        store.audit(user['id'],'session.restrict' if s['restricted'] else 'session.release',sid)
    return dict(ok=True)


@app.get('/v1/audit/verify')
def audit_verify(user=Depends(principal)):
    require(user,'audit');return dict(chain_ok=store.verify_chain(),total=len(store.db['audit']))

# Resumable upload is optional for small integrations; browser uses it for all files.
@app.post('/v1/sessions/{sid}/assets/{aid}/upload')
def upload_init(sid:str,aid:str,body:dict,user=Depends(principal)):
    with store.transaction() as db:
        s=ses(sid,user,'capture');mutable(s);a=next((a for a in s['assets'] if a['id']==aid),None)
        need(a,'未知素材',404)
        if a.get('upload_status')=='complete':return dict(id='',bytes=a['size_bytes'],status='complete',sha256=a['sha256'])
        wanted=body.get('sha256')
        need(wanted,'需提供完整原件SHA256，保证续传仍是同一原件')
        need(not wanted or re.fullmatch(r'[a-f0-9]{64}',str(wanted)),'完整文件SHA256无效')
        existing=next((x for x in db.get('uploads',[]) if x['session_id']==sid and x['asset_id']==aid and x['owner_id']==user['id'] and x.get('expected_sha256')==wanted and x['status']=='uploading'),None)
        if existing:return existing
        need(not any(x for x in db.get('uploads',[]) if x['session_id']==sid and x['asset_id']==aid and x['status']=='uploading'),'此素材已绑定其他原件，请为不同原件新建任务',409)
        record=dict(id=uid('UPLOAD'),session_id=sid,asset_id=aid,owner_id=user['id'],expected_sha256=wanted,sha256=None,bytes=0,total=a['size_bytes'],chunks=[],status='uploading')
        target=DATA/'staging';target.mkdir(parents=True,exist_ok=True);(target/record['id']).touch(exist_ok=False)
        store.put('uploads',record);store.audit(user['id'],'upload.init',record['id']);return record


@app.put('/v1/uploads/{identifier}')
async def upload_chunk(identifier:str,request:Request,user=Depends(principal)):
    need(ID.fullmatch(identifier),'上传编号无效')
    raw=bytearray()
    async for chunk in request.stream():
        raw.extend(chunk);need(len(raw)<=8*1024*1024,'分块超过8MB',413)
    digest=hashlib.sha256(raw).hexdigest()
    need(raw and digest==request.headers.get('x-chunk-sha256'),'分块SHA256不一致',409)
    try:offset=int(request.headers.get('x-upload-offset','-1'))
    except ValueError:raise HTTPException(422,'分块偏移无效')
    with store.transaction():
        x=store.get('uploads',identifier);need(x and x['owner_id']==user['id'],'上传任务不存在',404)
        s=ses(x['session_id'],user,'capture');mutable(s);need(x['status']=='uploading','上传已结束',409)
        previous=next((c for c in x['chunks'] if c['offset']==offset),None)
        if previous:
            need(previous['sha256']==digest and previous['size']==len(raw),'同偏移分块内容冲突',409)
            return dict(bytes=x['bytes'],duplicate=True)
        need(offset==x['bytes'] and offset+len(raw)<=x['total'],'分块偏移或总长度不一致',409)
        path=DATA/'staging'/identifier
        # Crash after bytes before metadata is repaired by truncating to the committed offset.
        with path.open('r+b') as f:
            f.truncate(offset);f.seek(offset);f.write(raw);f.flush();os.fsync(f.fileno())
        x['chunks'].append(dict(offset=offset,size=len(raw),sha256=digest));x['bytes']+=len(raw);store.put('uploads',x)
    return dict(bytes=x['bytes'])


@app.post('/v1/uploads/{identifier}/complete')
def upload_complete(identifier:str,body:dict,user=Depends(principal)):
    with store.transaction():
        x=store.get('uploads',identifier);need(x and x['owner_id']==user['id'],'上传任务不存在',404)
        s=ses(x['session_id'],user,'capture');mutable(s)
        if x['status']=='complete':return dict(ok=True,sha256=x['sha256'],duplicate=True)
        need(x['bytes']==x['total'],'上传尚未完整',409)
        path=DATA/'staging'/identifier
        from .engine import sha
        actual=sha(path)
        need(not x.get('expected_sha256') or actual==x['expected_sha256'],'原件SHA256不一致',409)
        x['sha256']=actual
        a=next(a for a in s['assets'] if a['id']==x['asset_id']);need(a.get('upload_status')!='complete','原件已封存',409)
        try:duration,metadata=probe(path,a['kind'])
        except (ValueError,subprocess.TimeoutExpired) as exc:raise HTTPException(422,'预检失败：'+str(exc))
        key=uid('blob')+Path(a['name']).suffix.lower();dest=UPLOADS/s['id']/key;dest.parent.mkdir(parents=True,exist_ok=True)
        # Copy first; staging remains intact if the DB transaction rolls back.
        import shutil
        shutil.copyfile(path,dest)
        a.update(storage_key=key,sha256=x['sha256'],upload_status='complete',duration_seconds=duration,probe=metadata)
        s['asset']=s['assets'][0];x['status']='complete';store.upsert_session(s);store.put('uploads',x);store.audit(user['id'],'asset.seal',f"{s['id']}/{a['id']}/{a['sha256']}")
    return dict(ok=True,sha256=x['sha256'],duration_seconds=duration)


@app.post('/v1/capture/lease')
def capture_lease(body:dict,user=Depends(principal)):
    require(user,'capture');room=str(body.get('room','本地访谈室'))[:80]
    with store.transaction() as db:
        leases=db.setdefault('capture_leases',[]);now=time.time()
        active=next((l for l in leases if l['room']==room and l['until']>now),None)
        if active:
            need(active['owner_id']==user['id'] and active['id']==body.get('lease_id'),'此采集位已有控制者',409)
            active['until']=now+60;return active
        lease=dict(id=uid('LEASE'),room=room,owner_id=user['id'],until=now+60)
        leases.append(lease);store.audit(user['id'],'capture.claim',lease['id']);return lease


@app.post('/v1/capture/lease/release')
def capture_release(body:dict,user=Depends(principal)):
    with store.transaction() as db:
        lease=next((l for l in db.get('capture_leases',[]) if l['id']==body.get('lease_id') and l['owner_id']==user['id']),None)
        need(lease,'控制租约不存在',404);lease['until']=0;store.audit(user['id'],'capture.release',lease['id'])
    return dict(ok=True)

@app.post('/v1/sessions/{sid}/capture-complete')
def capture_complete(sid:str,body:dict,user=Depends(principal)):
    with store.transaction():
        s=ses(sid,user,'capture');need(s['source']=='live','非录制任务',409)
        need(consent(s,'analyze') and all(a.get('upload_status')=='complete' for a in s['assets']),'用途或素材预检未完成',409)
        analyst=store.get('users',s['analyst_id']);session_access(analyst,s)
        job=enqueue(store,s,analyst,body.get('request_key'))
        store.audit(user['id'],'capture.complete',sid)
    return dict(ok=True,job=job)

@app.post('/v1/admin/sessions/{sid}/consent')
def update_consent(sid:str,body:dict,user=Depends(principal)):
    require(user,'manage')
    people=validate_people(body.get('participants',[]))
    need(len(people)==2 and {p.get('role') for p in people}=={'interviewer','subject'},'须逐人登记两名参与者')
    need(len({p.get('id') for p in people})==2 and all(isinstance(p.get('id'),str) and ID.fullmatch(p['id']) for p in people),'参与者匿名编号无效')
    need(str(body.get('consent_doc','')).strip() and str(body.get('note','')).strip(),'文书号与变更依据必填')
    with store.transaction() as db:
        s=store.get_session(sid);need(s and s['project_id'] in user['projects'],'任务不可见',404);mutable(s);expected(s,body)
        db.setdefault('consent_history',[]).append(dict(session_id=sid,revision=s['revision'],participants=s['participants'],consent_doc=s['consent_doc']))
        s.update(participants=people,consent_doc=body['consent_doc'],revision=s['revision']+1,stale=bool(s.get('offline')))
        store.upsert_session(s);store.audit(user['id'],'consent.revise',sid)
    return dict(ok=True,revision=s['revision'])



@app.get('/v1/projects')
def projects(user=Depends(principal)):
    return [p for p in store.collection('projects') if p['id'] in user['projects']]

@app.post('/v1/admin/projects')
def create_project(body:dict,user=Depends(principal)):
    require(user,'manage');need(isinstance(body.get('name'),str) and body['name'].strip(),'项目名称必填')
    with store.transaction() as db:
        project=dict(id=uid('PRJ'),name=body['name'][:100]);db['projects'].append(project)
        current=store.get('users',user['id']);current['projects'].append(project['id']);store.put('users',current)
        store.audit(user['id'],'project.create',project['id'])
    return project

@app.post('/v1/admin/users')
def create_user(body:dict,user=Depends(principal)):
    require(user,'manage')
    need(isinstance(body.get('id'),str) and ID.fullmatch(body['id']) and body.get('role') in ('analyst','reviewer','collector','reader','admin','auditor'),'账号或职责无效')
    need(str(body.get('person_id','')).strip(),'自然人编号必填；同一人多账号须使用相同编号')
    need(len(body.get('password',''))>=12,'初始口令至少12位')
    need(body.get('projects') and set(body['projects'])<=set(user['projects']),'成员项目须在管理员范围内')
    with store.transaction() as db:
        need(not store.get('users',body['id']),'账号已存在',409)
        record=dict(id=body['id'],name=body.get('name',body['id'])[:80],seat=body['id'],role=body['role'],person_id=body['person_id'],projects=body['projects'],enabled=True,password=password_hash(body['password']))
        db['users'].append(record);store.audit(user['id'],'user.create',record['id'])
    return public_user(record)

@app.post('/v1/admin/users/{identifier}/enabled')
def user_enabled(identifier:str,body:dict,user=Depends(principal)):
    require(user,'manage');need(isinstance(body.get('enabled'),bool),'启停状态无效')
    with store.transaction() as db:
        target=store.get('users',identifier);need(target and set(target['projects'])<=set(user['projects']),'成员不可见',404)
        need(identifier!=user['id'],'不能停用当前账号')
        target['enabled']=body['enabled'];store.put('users',target)
        db['tokens']={k:v for k,v in db['tokens'].items() if v['user_id']!=identifier}
        store.audit(user['id'],'user.enabled',identifier)
    return dict(ok=True)

# Built UI and all assets are served locally; offline installations need no Node process.
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StaticHTTPException
from fastapi.responses import FileResponse
class WorkspaceUI(StaticFiles):
    async def get_response(self,path,scope):
        try:return await super().get_response(path,scope)
        except StaticHTTPException as exc:
            if exc.status_code==404 and not path.startswith('v1/') and '.' not in Path(path).name:
                return FileResponse(Path(self.directory)/'index.html')
            raise
ui_dist=Path(os.getenv('UI_DIST',str(Path(__file__).resolve().parents[2]/'prototype-lite'/'dist')))
if ui_dist.is_dir():app.mount('/',WorkspaceUI(directory=ui_dist,html=True),name='workspace-ui')
