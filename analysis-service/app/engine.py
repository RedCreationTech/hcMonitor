"""Immutable run computation using the existing real detectors."""
import hashlib
import json
import wave
import platform
from importlib.metadata import version, PackageNotFoundError
from pathlib import Path
from .config import ARTIFACTS, UPLOADS, PIPELINE_VERSION, CAP_NOTE
from .pipeline import preprocess, fusion, attribution
from . import narrative

MODS = ['voice', 'semantic', 'face', 'pose', 'hand', 'physio']


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024*1024), b''): h.update(chunk)
    return h.hexdigest()


def code_hash():
    root=Path(__file__).parent
    return hashlib.sha256(''.join(str(p.relative_to(root))+sha(p) for p in sorted(root.rglob('*.py'))).encode()).hexdigest()

def environment():
    from .config import FFMPEG,FFPROBE
    packages={}
    for name in ('torch','funasr','sentence-transformers','transformers','mediapipe','numpy','llama-cpp-python','reportlab','fastapi'):
        try:packages[name]=version(name)
        except PackageNotFoundError:packages[name]='unavailable'
    import shutil
    tools={}
    for name,path in [('ffmpeg',FFMPEG),('ffprobe',FFPROBE)]:
        resolved=shutil.which(path)
        tools[name]=dict(sha256=sha(resolved),bytes=Path(resolved).stat().st_size) if resolved else dict(status='unavailable')
    return dict(python=platform.python_version(),platform=platform.platform(),packages=packages,tools=tools)


def compute(session, run, progress):
    progress(1, '固定模型校验')
    from .model_inventory import frozen_inventory
    models=frozen_inventory()
    progress(3, '运行环境与源码快照')
    source_code=code_hash();runtime=environment()
    assets = session['assets']
    root = ARTIFACTS / session['id'] / run['id']
    root.mkdir(parents=True, exist_ok=False)
    # Keep the exact source alongside this run, rather than relying on an uncommitted working tree.
    source_root=Path(__file__).parent;source_records=[]
    for source in sorted(source_root.rglob('*.py')):
        relative=source.relative_to(source_root);data=source.read_bytes();destination=root/'_code'/relative
        destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(data)
        source_records.append(str(relative)+hashlib.sha256(data).hexdigest())
    if hashlib.sha256(''.join(source_records).encode()).hexdigest()!=source_code:
        raise ValueError('创建快照时检测到代码已变化，拒绝混合版本')
    all_events, slices, all_turns, all_impacts = [], [], [], []
    manifests = []
    for index, asset in enumerate(assets):
        def stage(percent, label):
            progress(5 + 75 * (index + percent / 100) / len(assets), f"{label} · {asset['name']}")
        stage(0, '原件完整性检查')
        path = UPLOADS / session['id'] / asset['storage_key']
        if sha(path) != asset['sha256']: raise ValueError('原件hash不一致')
        out = root / asset['id']
        out.mkdir()
        events, turns, impacts, mods = [], [], [], []
        quality, note, trend, baseline = 'ok', '', None, None
        try:
            if asset['kind'] in ('audio', 'video'):
                from .pipeline import speech, acoustic, semantic
                stage(5, '音轨解码')
                wav = preprocess.audio_to_wav(path)
                with wave.open(str(wav)) as f: duration = f.getnframes()/f.getframerate()
                asset['duration_seconds']=round(duration)
                stage(15, '转写与说话人识别（含本地模型加载）')
                original = speech.run(wav, out)['turns']
                for i, t in enumerate(original):
                    t.update(id=f"{asset['id']}-T{i+1:04d}", asset_id=asset['id'])
                turns = [t.copy() for t in session.get('corrections', {}).get('turns', []) if t['asset_id']==asset['id']] if session.get('corrections') else original
                (out/'original-turns.json').write_text(json.dumps(original, ensure_ascii=False), 'utf-8')
                if (session.get('capture') or {}).get('gaps'):
                    quality='degraded';baseline='capture_gap';mods=['voice']
                    note='采集含未可靠映射至文件轴的暂停/设备故障；本轮仅转写与回看，连续声学/视觉/生理指标、话题影响和心理解释均弃权。'
                    for turn in turns:turn['speech_rate']=None
                else:
                    stage(45, '声学特征与个人基线')
                    ac = acoustic.run(wav, turns, out)
                    baseline = ac.get('baseline_status')
                    if baseline!='available':quality='degraded';note+='；个人声学基线不足，不生成个人声学偏离'
                    corrected_topics = [t for t in session.get('corrections', {}).get('topics', []) if t['asset_id']==asset['id']]
                    try:
                        stage(60, '话题与语义分析（含本地模型加载）')
                        sr = semantic.run(turns, out, corrected_topics or None)
                        impacts = sr['impacts']; mods=['voice']+(['semantic'] if any(t.get('text','').strip() for t in turns) else [])
                    except Exception as exc:
                        sr={'anomalies':[]};quality='degraded';note='语义通道失败：'+str(exc)[:180];mods=['voice']
                    events = ac['anomalies'] + sr['anomalies']
                    if not any(t.get('participant_id') for t in turns):
                        quality='degraded';note += '；说话人身份待人工绑定；无个人基线或个人心理解释'
                    if asset['kind'] == 'video':
                        from .pipeline import vision, rppg
                        stage(75, '视觉证据分析')
                        try:vr=vision.run(path,out)
                        except Exception as exc:vr=dict(anomalies=[],modality_available=[],quality='degraded',quality_note='视觉通道失败：'+str(exc)[:180])
                        stage(90, '视频生理质量检查')
                        try:rr=rppg.run(path,out)
                        except Exception as exc:rr=dict(anomalies=[],hr_series=[],quality='degraded',quality_note='视频生理通道失败：'+str(exc)[:180])
                        for result in (vr, rr):
                            for ev in result['anomalies']:
                                ev.cap_note = '画面目标身份尚未确认；仅观察，不作个人心理解释或融合升级'
                            if result.get('quality') != 'ok':
                                quality='degraded'; note += '；'+result.get('quality_note','视觉质量不足')
                        events += vr['anomalies'] + rr['anomalies']
                        mods += vr.get('modality_available',[])
                        if any(40 <= h.get('hr',0) <= 180 for h in rr.get('hr_series',[])):mods.append('physio')
            else:
                from .pipeline import ext_nir, ext_mmwave
                stage(20, '传感器文件解析与质量检查')
                result = (ext_nir if asset['kind']=='nir' else ext_mmwave).run(path, out, asset['id'])
                duration=result['duration_seconds']; events=result['anomalies']; trend=result['trend']
                quality=result['quality']; note='部分采样因运动伪迹降级；不生成事件' if quality!='ok' else ''; mods=['physio']
            for raw_index, ev in enumerate(events):
                ev.member_ids=[f"{asset['id']}-RAW-{raw_index+1:04d}"]
                ev.asset_id = asset['id']; ev.asset_ids=[asset['id']]
                if ev.modality in ('voice','semantic'):
                    people = {t.get('participant_id') for t in turns if t['ts'] <= ev.ts < t.get('end', t['ts']) and t.get('participant_id')}
                    ev.participant_id = next(iter(people)) if len(people)==1 else None
                    if not ev.participant_id: ev.cap_note = '证据目标未确认，仅观察，不作个人心理解释或升级'
            for t in turns: t['asset_id']=asset['id']
            for topic in impacts: topic['asset_id']=asset['id']; topic['topic_id']=f"{asset['id']}-{topic['topic_id']}"
            all_turns.extend(turns); all_impacts.extend(impacts)
            all_events.extend(events)
        except Exception as exc:
            quality, note, mods, duration = 'degraded', f'{type(exc).__name__}: {str(exc)[:300]}', [], 0
        slices.append(dict(asset_id=asset['id'], asset_name=asset['name'], kind=asset['kind'],
            role='primary' if asset['kind'] in ('audio','video') else 'extension', size_bytes=asset['size_bytes'],
            duration_seconds=round(duration), modality_available=mods, modality_unavailable=[m for m in MODS if m not in mods],
            quality=quality, quality_note=note, trend=trend, baseline_status=baseline, steps=[], event_ids=[],
            suppressed=[dict(id=f"{asset['id']}-{m}", reason=f'{m}不可用') for m in MODS if m not in mods],
            cap_note=CAP_NOTE if asset['kind'] in ('nir','mmwave') else None))
        manifests.append(dict(id=asset['id'], sha256=asset['sha256'], kind=asset['kind']))
        stage(100, '素材处理结束')
    if not any(s['modality_available'] and s['asset_id']==session['primary_asset_id'] for s in slices): raise ValueError('主素材解析失败：'+ '; '.join(s['quality_note'] for s in slices))
    progress(85, '融合与可追溯叙述')
    # Independent file clocks never fuse with each other. Duplicate tracks cannot count as separate evidence.
    fused=[]
    for asset in assets:
        people={e.participant_id for e in all_events if e.asset_id==asset['id']}
        for person in sorted(people,key=lambda p:p or ''):
            fused.extend(fusion.fuse([e for e in all_events if e.asset_id==asset['id'] and e.participant_id==person], session['id']))
    rules=attribution.load_rules(); anomalies=[]
    for i, ev in enumerate(fused,1):
        source=[dict(id=a['id'],name=a['name'],kind=a['kind']) for a in assets if a['id'] in (ev.asset_ids or [ev.asset_id])]
        event=attribution.fill_attribution(fusion.to_contract_event(ev,i,session['id'],source),rules)
        event['run_id']=run['id']; event['participant_id']=getattr(ev,'participant_id',None)
        if event['type']=='跨模态同窗聚合升级':
            people={getattr(x,'participant_id',None) for x in all_events if x.asset_id in ev.asset_ids and ev.window[0]<=x.ts<ev.window[1] and not x.cap_note}
            if len(people)==1: event['participant_id']=next(iter(people))
            else: continue
        anomalies.append(event)
        for sl in slices:
            if sl['asset_id'] in [a['id'] for a in source]: sl['event_ids'].append(event['id'])
    # Persist artifact hashes before output publication; no generated artifacts can overwrite a previous run.
    files=[dict(path=str(p.relative_to(root)),sha256=sha(p)) for p in sorted(root.rglob('*')) if p.is_file()]
    progress(90, '本地候选叙述与引用校验')
    result=dict(schema_version='2.0',run_id=run['id'], finished_at=__import__('datetime').datetime.now().isoformat(timespec='seconds'),
        asset_kind=next((a['kind'] for a in assets if a['id']==session['primary_asset_id']), 'audio'),
        assets=assets,slices=slices,modality_available=sorted({m for s in slices for m in s['modality_available']}),
        duration_seconds=next(s['duration_seconds'] for s in slices if s['asset_id']==session['primary_asset_id']),turns=all_turns,impacts=all_impacts,anomalies=anomalies,
        raw_events=[e.__dict__ for e in all_events],
        suppressed=[x for s in slices for x in s['suppressed']],pipeline=PIPELINE_VERSION,
        narrative=narrative.assemble(anomalies,run['id']), reviews={},
        manifest=dict(code_hash=source_code,environment=runtime,models=models,assets=manifests,files=files,revision=run['source_revision'],pipeline=PIPELINE_VERSION,
                      formula='topic-v1-relative-within-file',capture=session.get('capture'),clock_policy='independent-files-no-cross-fusion'))
    progress(95, '结果指纹与固定版本复核')
    frozen_inventory()
    if code_hash()!=source_code:raise ValueError('执行期间代码已变化，拒绝发布混合版本结果')
    (root/'result.json').write_text(json.dumps(result,ensure_ascii=False,allow_nan=False),'utf-8')
    return result
