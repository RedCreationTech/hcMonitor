"""Local operator commands. No business data or credentials are sent externally."""
import argparse
import copy
import getpass
import hashlib
import json
import os
import secrets
import shutil
import sys
from pathlib import Path
from .config import DATA, MODELS, LLM_PATH, FFPROBE, FFMPEG, ROOT
from .store import Store,empty_db
from .security import bootstrap,password_hash
from .worker import content_hash,TERMINAL


def secure_json(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:json.dump(value,f,ensure_ascii=False,indent=2)


def initialize(store,path):
    credentials={}
    with store.transaction() as db:
        bootstrap(store,secrets.token_urlsafe(24))
        for u in db['users']:
            password=secrets.token_urlsafe(18);credentials[u['id']]=dict(name=u['name'],password=password,role=u['role']);u['password']=password_hash(password)
        secure_json(path,credentials)
    return dict(initialized=True,credential_file=str(path),accounts=len(credentials))


def preflight():
    from .config import MS_ASR,MS_VAD,MS_PUNC,MS_DIAR,MS_EMBED,NLI_HF
    from .model_dl import ms_download,hf_download
    checks={}
    for identifier in (MS_ASR,MS_VAD,MS_PUNC,MS_DIAR,MS_EMBED,'iic/speech_campplus_sv_zh-cn_16k-common'):
        try:checks[identifier]=dict(ok=True,path=str(ms_download(identifier)))
        except Exception as e:checks[identifier]=dict(ok=False,error=str(e))
    try:checks[NLI_HF]=dict(ok=True,path=str(hf_download(NLI_HF)))
    except Exception as e:checks[NLI_HF]=dict(ok=False,error=str(e))
    checks['local_llm']=dict(ok=LLM_PATH.is_file(),path=str(LLM_PATH))
    checks['pdf_font']=dict(ok=(ROOT.parent/'fonts/chinese.ttf').is_file())
    import subprocess
    for name,binary in [('ffmpeg',FFMPEG),('ffprobe',FFPROBE)]:
        try:
            response=subprocess.run([binary,'-version'],capture_output=True,text=True,timeout=15)
            checks[name]=dict(ok=response.returncode==0,version=response.stdout.splitlines()[0] if response.stdout else '')
        except Exception as exc:checks[name]=dict(ok=False,error=str(exc))
    return dict(ready=all(v['ok'] for v in checks.values()),checks=checks)


def file_manifest(root):
    from .engine import sha
    return {str(p.relative_to(root)):sha(p) for p in sorted(Path(root).rglob('*')) if p.is_file()}


def backup(store,destination):
    destination=Path(destination).resolve();need_new(destination)
    if DATA.resolve() in destination.parents:raise ValueError('备份目标必须位于DATA_ROOT之外')
    destination.mkdir(parents=True,mode=0o700)
    with store.transaction() as db:
        if any(j['status'] not in TERMINAL for j in db['jobs']):raise ValueError('请先停止新任务并等待运行/排队作业结束')
        store.audit('运维','backup.snapshot',str(destination))
        snapshot=copy.deepcopy(db);snapshot['tokens']={};snapshot['capture_leases']=[]
        secure_json(destination/'database.json',snapshot)
        for folder in ('uploads','artifacts','exports','staging'):
            source=DATA/folder
            if source.exists():shutil.copytree(source,destination/folder)
        manifest=file_manifest(destination);secure_json(destination/'manifest.json',manifest)
    return dict(backup=str(destination),files=len(manifest),audit_head=snapshot['audit'][-1]['hash'])


def need_new(path):
    if Path(path).exists():raise ValueError('目标已存在，拒绝覆盖')


def restore(store,source):
    source=Path(source);manifest=json.loads((source/'manifest.json').read_text())
    actual=file_manifest(source);actual.pop('manifest.json',None)
    if actual!=manifest:raise ValueError('备份文件hash或清单不一致')
    if any(p.is_symlink() for p in source.rglob('*')):raise ValueError('备份包含链接，拒绝恢复')
    snapshot=json.loads((source/'database.json').read_text())
    with store.transaction() as db:
        if db['sessions'] or db['reports']:raise ValueError('仅允许恢复到空工作区')
        # Replay all post-backup restrictions from the destination tombstone journal if any.
        restrictions=copy.deepcopy(db.get('restrictions',[]))
        for folder in ('uploads','artifacts','exports','staging'):
            if (source/folder).exists():
                target=DATA/folder
                if target.exists() and any(target.iterdir()):raise ValueError('目标文件目录非空')
                shutil.copytree(source/folder,target,dirs_exist_ok=True)
        db.clear();db.update(snapshot);db['tokens']={};db['restrictions']=snapshot.get('restrictions',[])+restrictions
        for restriction in db['restrictions']:
            for s in db['sessions']:
                if s['id']==restriction['session_id']:s['restricted']=restriction['restricted']
        store.audit('运维','backup.restore',str(source))
    if not store.verify_chain():raise ValueError('恢复后审计链不一致')
    return dict(restored=True,sessions=len(store.sessions()),reports=len(store.reports()),tokens_revoked=True)


def migrate_legacy(store,legacy):
    legacy=Path(legacy).resolve();source=legacy/'store.json';raw=json.loads(source.read_text())
    from .engine import sha
    archive=DATA/'legacy-snapshot';need_new(archive);archive.mkdir(parents=True,mode=0o700)
    shutil.copyfile(source,archive/'store.json')
    mapping=[]
    with store.transaction() as db:
        if db['sessions']:raise ValueError('历史迁移仅允许空业务库')
        for old in raw.get('sessions',[]):
            import re
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',old.get('id','')):raise ValueError('历史会话编号包含不安全路径')
            s=copy.deepcopy(old);s.update(project_id='PRJ-LOCAL',owner_id='W-02',analyst_id='W-02',reviewer_id='R-01',participants=[],
                revision=1,stale=True,restricted=True,restriction_note='历史用途与身份未经重新核验，禁止分析或发布',offline_job=None,offline=None)
            converted=[]
            for index,a in enumerate(old.get('assets') or []):
                item=copy.deepcopy(a);item['id']=f'AS-LEGACY-{index+1:03d}'
                path=legacy/'uploads'/s['id']/Path(a['name']).name
                item['upload_status']='missing'
                if path.is_file():
                    item['storage_key']=f'legacy-{index:03d}'+path.suffix;dest=DATA/'uploads'/s['id']/item['storage_key'];dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,dest)
                    item.update(sha256=sha(dest),upload_status='complete',size_bytes=dest.stat().st_size)
                converted.append(item);mapping.append(dict(session_id=s['id'],old_asset_id=a.get('id'),asset_id=item['id'],state=item['upload_status']))
            s['assets']=converted;s['asset']=converted[0] if converted else None;s['primary_asset_id']=next((a['id'] for a in converted if a['kind'] in ('audio','video')),None)
            store.upsert_session(s)
        db['legacy_reports']=raw.get('reports',[])
        # Old artifacts remain a separate immutable evidence archive, never promoted to new runs.
        if (legacy/'artifacts').exists():shutil.copytree(legacy/'artifacts',archive/'artifacts')
        db['legacy_source']=dict(sha256=sha(source),archive='legacy-snapshot',mapping=mapping)
        store.audit('运维','legacy.quarantine_import',sha(source))
    secure_json(archive/'migration-manifest.json',dict(source_sha256=sha(source),mapping=mapping))
    return dict(sessions=len(store.sessions()),legacy_reports=len(raw.get('reports',[])),restricted=True,missing=sum(x['state']=='missing' for x in mapping))


def main():
    parser=argparse.ArgumentParser();parser.add_argument('command',choices=['init','preflight','backup','restore','migrate','verify','add-user']);parser.add_argument('--path');parser.add_argument('--id');parser.add_argument('--role',choices=['analyst','reviewer','collector','reader','admin','auditor']);parser.add_argument('--person');args=parser.parse_args()
    store=Store()
    if args.command=='init':result=initialize(store,Path(args.path) if args.path else DATA/'initial-credentials.json')
    elif args.command=='preflight':
        result=preflight();print(json.dumps(result,ensure_ascii=False,indent=2));sys.exit(0 if result['ready'] else 1)
    elif args.command=='verify':result=dict(chain_ok=store.verify_chain(),sessions=len(store.sessions()),reports=len(store.reports()))
    elif args.command=='backup':result=backup(store,args.path)
    elif args.command=='restore':result=restore(store,args.path)
    elif args.command=='migrate':result=migrate_legacy(store,args.path)
    else:
        if not args.id or not args.role or not args.person:parser.error('add-user需--id --role --person')
        password=getpass.getpass('新账号口令（至少12位）: ')
        if len(password)<12:raise ValueError('口令过短')
        with store.transaction() as db:
            if store.get('users',args.id):raise ValueError('账号已存在')
            db['users'].append(dict(id=args.id,name=args.id,seat=args.id,role=args.role,person_id=args.person,password=password_hash(password),projects=['PRJ-LOCAL'],enabled=True))
            store.audit('运维','user.create',args.id)
        result=dict(created=args.id)
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
