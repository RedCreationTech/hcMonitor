"""Persistent serial worker. A process lease prevents two schedulers from executing a run."""
import copy
import hashlib
import json
import os
import threading
import multiprocessing
import signal
import queue as queue_module
import time
import uuid
from .config import ARTIFACTS, DISCLAIMER
from .seed import now_str
from .security import session_access

TERMINAL = {'succeeded','partial','failed','cancelled','interrupted'}


def content_hash(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def enqueue(store, session, actor, request_key=None):
    with store.transaction() as db:
        current=store.get_session(session['id'])
        for job in db['jobs']:
            if job['session_id']==session['id'] and job['source_revision']==current['revision']:
                if job['status'] not in TERMINAL or request_key and job.get('request_key')==request_key:
                    return job
        rid='RUN-'+uuid.uuid4().hex[:16]; jid='JOB-'+uuid.uuid4().hex[:16]
        run=dict(id=rid,session_id=current['id'],source_revision=current['revision'],input=copy.deepcopy(current),
                 input_hash=content_hash(current),status='queued',created_at=now_str(),actor_id=actor['id'],actor_person_id=actor['person_id'])
        job=dict(id=jid,run_id=rid,session_id=current['id'],source_revision=current['revision'],status='queued',
                 progress=0,stage='排队',created_at=now_str(),request_key=request_key,heartbeat=0,cancel_requested=False)
        db['runs'].append(run); db['jobs'].append(job)
        current['offline_job']=job; store.upsert_session(current)
        store.audit(actor['id'],'job.enqueue',jid)
        return copy.deepcopy(job)


def draft_report(session,result,report_id,author):
    narrative=result['narrative']
    origin='现场录制，结束后批分析' if session['source']=='live' else '既有文件导入，离线批分析'
    gaps=(session.get('capture') or {}).get('gaps',[])
    capture_note=f' 客户端采集记录含{len(gaps)}个暂停/设备故障事件；文件内时间不等于包含暂停的现场耗时。' if gaps else ''
    return dict(id=report_id,session_id=session['id'],project_id=session['project_id'],subject_code=session['subject_code'],
        title=session['scene']+'证据分析报告',status='drafting',family_id=session['id'],version=1,revision=1,source_run_id=result['run_id'],
        source_revision=session['revision'],source_hash=content_hash(result),author_id=author,reviewer_id=session['reviewer_id'],
        author_person_id=None,sections=[
            dict(key='overview',title='一、素材与方法',text=f"来源：{origin}；主素材 {session['primary_asset_id']}；每个文件独立时轴；管线 {result['pipeline']}。{capture_note}"),
            dict(key='quality',title='二、质量与能力边界',text='\n'.join(f"{s['asset_name']}：{s['quality']}；{s['quality_note']}；基线 {s.get('baseline_status') or '不适用'}" for s in result['slices'])),
            dict(key='evidence',title='三、观察证据与人工复核',text=f"候选观察 {len(result['anomalies'])} 条；逐条决定见冻结证据附件，未经人工确认不作为专家结论。"),
            dict(key='narrative',title='四、本地候选叙述',text=narrative.get('text') or f"叙述状态：{narrative['status']}；{narrative.get('reason','')}。使用确定性观察和规则，等待专家决定。"),
            dict(key='limit',title='五、局限与免责',text=DISCLAIMER+' 文件传感器只报趋势；身份、基线和画面归属不足时拒绝个人解释；话题指数只作文件内相对排序。')],
        precision_note=None,origin=session['source'],assets=session['assets'],reviewer=None,published_at=None,
        revisions=[dict(ts=now_str(),actor='系统',action='create',note='不可变run自动起草')],grants=[])


def _compute_child(session,run,queue,compute=None):
    try:
        os.setsid()
        from .engine import compute as real_compute
        result=(compute or real_compute)(session,run,lambda percent,stage:queue.put(('progress',percent,stage)))
        queue.put(('result',result))
    except BaseException as exc:
        queue.put(('error',type(exc).__name__+': '+str(exc)[:1000]))


class Scheduler:
    def __init__(self,store,compute=None,isolate=None):
        self.store=store; self.owner=uuid.uuid4().hex; self.stop_event=threading.Event()
        self.compute=compute; self.thread=None; self.isolate=(compute is None) if isolate is None else isolate
    def start(self):
        self.thread=threading.Thread(target=self.loop,daemon=True,name='m1-worker'); self.thread.start()
    def stop(self):
        self.stop_event.set()
        if self.thread: self.thread.join(timeout=2)
    def recover(self):
        with self.store.transaction() as db:
            for job in db['jobs']:
                if job['status']=='running' and job.get('lease_until',0)<time.time():
                    job.update(status='interrupted',error='工作进程失联，原run保留；请重试创建新run')
                    self.store.get('runs',job['run_id'])
                    for r in db['runs']:
                        if r['id']==job['run_id']: r['status']='interrupted'
                    session=self.store.get_session(job['session_id'])
                    if (session.get('offline_job') or {}).get('id')==job['id']: session['offline_job']=None
                    self.store.upsert_session(session); self.store.audit('系统','job.interrupted',job['id'])
    def loop(self):
        while not self.stop_event.is_set():
            try: self.tick()
            except Exception:
                import traceback; traceback.print_exc()
            self.stop_event.wait(.5)
    def run_isolated(self,run,progress):
        context=multiprocessing.get_context('spawn');queue=context.Queue()
        process=context.Process(target=_compute_child,args=(run['input'],run,queue,self.compute))
        process.start();started=time.monotonic();percent,stage=0,'模型预检与加载'
        try:
            while True:
                # Enforce revocation, cancellation, source revision and deadline independently of detector callbacks.
                progress(percent,stage)
                if time.monotonic()-started>int(os.getenv('JOB_TIMEOUT_SECONDS','3600')):raise TimeoutError('作业超过执行时限')
                try:message=queue.get(timeout=.5)
                except queue_module.Empty:
                    if not process.is_alive():raise RuntimeError('分析进程异常退出；未生成成功结果')
                    continue
                if message[0]=='progress':percent,stage=message[1:]
                elif message[0]=='result':return message[1]
                elif message[0]=='error':raise RuntimeError(message[1])
        finally:
            if process.is_alive():
                try:os.killpg(process.pid,signal.SIGTERM)
                except ProcessLookupError:process.terminate()
            process.join(timeout=3)
            if process.is_alive():process.kill();process.join(timeout=1)
            queue.close()

    def tick(self):
        self.recover()
        with self.store.transaction() as db:
            if any(j['status']=='running' for j in db['jobs']): return False
            job=next((j for j in db['jobs'] if j['status']=='queued'),None)
            if not job: return False
            job.update(status='running',owner=self.owner,heartbeat=time.time(),lease_until=time.time()+30)
            job=copy.deepcopy(job)
            run=self.store.get('runs',job['run_id']); run['status']='running'; self.store.put('runs',run)
        heartbeat_stop=threading.Event()
        def heartbeat():
            while not heartbeat_stop.wait(5):
                with self.store.transaction():
                    j=self.store.get('jobs',job['id'])
                    if j.get('owner')!=self.owner: return
                    j.update(heartbeat=time.time(),lease_until=time.time()+30); self.store.put('jobs',j)
        heart=threading.Thread(target=heartbeat,daemon=True);heart.start()
        def progress(percent,stage):
            with self.store.transaction():
                j=self.store.get('jobs',job['id']); s=self.store.get_session(job['session_id'])
                actor=self.store.get('users',run['actor_id'])
                if not actor or not actor.get('enabled'):raise InterruptedError('运行主体已失效')
                if j['status']!='running' or j.get('owner')!=self.owner:raise InterruptedError('执行租约已失效')
                session_access(actor,s)
                if j.get('cancel_requested') or self.stop_event.is_set(): raise InterruptedError('作业已取消')
                if s['revision']!=run['source_revision']: raise InterruptedError('输入版本已改变')
                j.update(progress=round(percent),stage=stage);self.store.put('jobs',j)
                s['offline_job']=j;self.store.upsert_session(s)
        try:
            progress(0,'预检')
            from .engine import compute
            result=self.run_isolated(run,progress) if self.isolate else (self.compute or compute)(run['input'],run,progress)
            progress(100,'结果封存')
            algorithm_file=ARTIFACTS/job['session_id']/run['id']/'result.json'
            if algorithm_file.is_file():
                from .engine import sha
                result['manifest']['result_artifact']=dict(path='result.json',sha256=sha(algorithm_file))
            report_id='RP-'+uuid.uuid4().hex[:16];result['report_id']=report_id
            with self.store.transaction():
                s=self.store.get_session(job['session_id'])
                if s['revision']!=run['source_revision']: raise InterruptedError('输入版本已改变')
                j=self.store.get('jobs',job['id'])
                if j.get('cancel_requested') or j.get('owner')!=self.owner or j['status']!='running': raise InterruptedError('作业已取消或执行租约失效')
                status='partial' if any(x['quality']=='degraded' for x in result['slices']) or result['narrative']['status']=='degraded' else 'succeeded'
                run.update(status=status,result=result,result_hash=content_hash(result));self.store.put('runs',run)
                j.update(status=status,progress=100,stage='完成（含降级）' if status=='partial' else '完成',finished_at=now_str());self.store.put('jobs',j)
                s.update(assets=result['assets'],asset=result['assets'][0],offline=result,current_run_id=run['id'],offline_job=None,stale=False,duration_seconds=result['duration_seconds'],anomaly_count=len(result['anomalies']),status='review')
                report=draft_report(s,result,report_id,run['actor_id'])
                report['version']=max((r.get('version',1) for r in self.store.reports() if r['session_id']==s['id']),default=0)+1
                author=self.store.get('users',run['actor_id']);report['author_person_id']=author['person_id']
                self.store.upsert_report(report);self.store.upsert_session(s);self.store.audit('系统','run.complete',run['id'])
        except BaseException as exc:
            with self.store.transaction():
                j=self.store.get('jobs',job['id']);status='cancelled' if isinstance(exc,InterruptedError) else 'failed'
                j.update(status=status,error=f'{type(exc).__name__}: {str(exc)[:1000]}',finished_at=now_str());self.store.put('jobs',j)
                run.update(status=status,error=j['error']);self.store.put('runs',run)
                s=self.store.get_session(job['session_id']);s['offline_job']=None;self.store.upsert_session(s)
                self.store.audit('系统','job.'+status,job['id'])
        finally:
            heartbeat_stop.set();heart.join(timeout=1)
        return True
