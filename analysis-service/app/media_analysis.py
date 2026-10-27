"""Analyze continuous parts separately; map derived evidence back to original file seconds."""
import json
import subprocess
import wave
from pathlib import Path
from .capture import unmapped_gap, validate_intervals
from .config import FFMPEG
from .pipeline import preprocess


def crop(source, start, end, destination, video):
    args = [FFMPEG, '-hide_banner', '-nostdin', '-y', '-i', str(source), '-ss', str(start), '-t', str(end-start)]
    if video:
        args += ['-map', '0:v:0', '-map', '0:a:0', '-vf', 'fps=25,setpts=PTS-STARTPTS', '-af', 'asetpts=PTS-STARTPTS',
                 '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-c:a', 'pcm_s16le']
    else:
        args += ['-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le']
    r = subprocess.run(args+[str(destination)], capture_output=True, text=True, timeout=600)
    if r.returncode or not destination.is_file() or not destination.stat().st_size:
        raise ValueError('有效区间截取失败：'+r.stderr[-200:])
    return destination


def continuous(path, wav, asset, session, out, stage, *, start=0, end=None, segment_id=None, transcription_only=False):
    from .pipeline import speech, acoustic, semantic
    stage(15, '转写与说话人识别（含本地模型加载）')
    original = speech.run(wav, out)['turns']
    for i, t in enumerate(original):
        t.update(id=f"{asset['id']}-{segment_id+'-' if segment_id else ''}T{i+1:04d}", asset_id=asset['id'])
    corrections = session.get('corrections')
    turns = [dict(t, ts=t['ts']-start, end=t['end']-start) for t in corrections['turns']
             if t['asset_id']==asset['id'] and t['ts']>=start and (end is None or t['end']<=end)] if corrections else [t.copy() for t in original]
    note, baseline, quality = '', None, 'ok'
    events, impacts, mods = [], [], ['voice']
    if transcription_only:
        baseline='capture_gap';quality='degraded'
        note='此素材缺口未可靠映射至文件轴；仅转写与回看。可逐段回看并登记有效区间后重算，其他已确认连续片段不受影响。'
        for t in turns:t['speech_rate']=None
    else:
        stage(45, '声学特征与个人基线')
        ac=acoustic.run(wav, turns, out);baseline=ac.get('baseline_status');events=ac['anomalies']
        if baseline!='available':quality='degraded';note+='；个人声学基线不足，不生成个人声学偏离'
        topics=[dict(t,boundary=[v-start for v in t['boundary']]) for t in (corrections or {}).get('topics',[])
                if t['asset_id']==asset['id'] and t['boundary'][0]>=start and (end is None or t['boundary'][1]<=end)]
        try:
            stage(60, '话题与语义分析（含本地模型加载）')
            sr=semantic.run(turns, out, topics or None);events+=sr['anomalies'];impacts=sr['impacts']
            if any(t.get('text','').strip() for t in turns):mods.append('semantic')
        except Exception as exc:quality='degraded';note+='；语义通道失败：'+str(exc)[:180]
        if not any(t.get('participant_id') for t in turns):quality='degraded';note+='；说话人身份待人工绑定；无个人基线或个人心理解释'
        if asset['kind']=='video':
            from .pipeline import vision, rppg
            stage(75, '视觉证据分析')
            try:vr=vision.run(path,out)
            except Exception as exc:vr=dict(anomalies=[],modality_available=[],quality='degraded',quality_note='视觉通道失败：'+str(exc)[:180])
            stage(90, '视频生理质量检查')
            try:rr=rppg.run(path,out)
            except Exception as exc:rr=dict(anomalies=[],hr_series=[],quality='degraded',quality_note='视频生理通道失败：'+str(exc)[:180])
            for result in (vr,rr):
                for ev in result['anomalies']:ev.cap_note='画面目标身份尚未确认；仅观察，不作个人心理解释或融合升级'
                if result.get('quality')!='ok':quality='degraded';note+='；'+result.get('quality_note','视觉质量不足')
            events+=vr['anomalies']+rr['anomalies'];mods+=vr.get('modality_available',[])
            if any(40<=h.get('hr',0)<=180 for h in rr.get('hr_series',[])):mods.append('physio')
    # Boundary-crossing detector output is discarded, never clipped into apparently valid evidence.
    if end is not None:
        span=end-start
        events=[e for e in events if 0<=e.window[0]<=e.ts<=e.window[1]<=span+1e-6]
        turns=[t for t in turns if 0<=t['ts']<t.get('end',0)<=span+1e-6]
        impacts=[t for t in impacts if 0<=t['boundary'][0]<t['boundary'][1]<=span+1e-6]
    for t in original+turns:
        t['ts']+=start;t['end']=t.get('end',t['ts']-start)+start
        if segment_id:t['segment_id']=segment_id
    for e in events:
        e.ts+=start;e.window=tuple(v+start for v in e.window);e.segment_id=segment_id
    for t in impacts:
        t['ts']+=start;t['boundary']=[v+start for v in t['boundary']]
        if segment_id:t['topic_id']=segment_id+'-'+t['topic_id'];t['segment_id']=segment_id
    return dict(events=events,turns=turns,original=original,impacts=impacts,mods=mods,baseline=baseline,quality=quality,note=note)


def analyze(path, asset, session, out, stage):
    stage(5, '音轨解码')
    wav=preprocess.audio_to_wav(path)
    with wave.open(str(wav)) as f:duration=f.getnframes()/f.getframerate()
    asset['duration_seconds']=round(duration)
    saved=session.get('analysis_intervals') or {}
    ranges=[r for r in saved.get('ranges',[]) if r['asset_id']==asset['id']]
    if not ranges:
        result=continuous(path,wav,asset,session,out,stage,transcription_only=unmapped_gap(session,asset))
        if (session.get('capture') or {}).get('mode')=='independent-segments-v1':
            result['note']='连续片段独立文件；暂停未写入本文件，各片段独立基线与窗口，不跨暂停融合。'+result['note']
    else:
        validate_intervals(saved['ranges'],session['assets'])
        if saved.get('asset_hashes',{}).get(asset['id'])!=asset['sha256']:raise ValueError('有效区间所绑定的原件指纹不一致')
        if any(r['end']>duration+.02 for r in ranges):raise ValueError('有效区间超出实际解码时长，请校正文件秒数')
        result=dict(events=[],turns=[],original=[],impacts=[],mods=[],baseline='segmented',quality='degraded',note='仅分析人工核验连续区间；排除其余区间；分段独立基线、话题、连续窗与融合。',segments=[])
        for i,r in enumerate(ranges):
            segment_id=f'SEG-{i+1:03d}';folder=out/segment_id;folder.mkdir()
            def part_stage(percent,label):stage(5+(i+percent/100)*90/len(ranges),f'{segment_id} {label}')
            try:
                clip=crop(path,r['start'],r['end'],folder/('source.mkv' if asset['kind']=='video' else 'source.wav'),asset['kind']=='video')
                part=continuous(clip,preprocess.audio_to_wav(clip),asset,session,folder,part_stage,start=r['start'],end=r['end'],segment_id=segment_id)
                for key in ('events','turns','original','impacts','mods'):result[key]+=part[key]
                quality,note,baseline=part['quality'],part['note'],part['baseline']
            except Exception as exc:quality,note,baseline='degraded',str(exc)[:300],'unavailable'
            result['segments'].append(dict(id=segment_id,start=r['start'],end=r['end'],quality=quality,quality_note=note,baseline_status=baseline))
        result['mods']=sorted(set(result['mods']))
        result['note']+=' '+'；'.join(f"{s['id']} {s['start']:.2f}—{s['end']:.2f}s：{s['quality_note'] or s['quality']}" for s in result['segments'])
        result['analyzed_duration_seconds']=round(sum(r['end']-r['start'] for r in ranges),3)
    (out/'original-turns.json').write_text(json.dumps(result['original'],ensure_ascii=False),'utf-8')
    result['duration']=duration
    return result
