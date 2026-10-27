import copy
import hashlib
import wave
import pytest
from app import engine, model_inventory, media_analysis
from app.capture import validate_capture, unmapped_gap
from app.pipeline import speech, acoustic, semantic, vision, rppg, fusion
from app.pipeline.events import RawEvent
from conftest import analyzed


@pytest.fixture
def continuous_media(tmp_path, monkeypatch):
    monkeypatch.setattr(engine,'UPLOADS',tmp_path/'uploads');monkeypatch.setattr(engine,'ARTIFACTS',tmp_path/'artifacts')
    monkeypatch.setattr(model_inventory,'frozen_inventory',lambda:[])
    monkeypatch.setattr(engine.narrative,'assemble',lambda *a:dict(status='not_applicable',text='',citations=[]))
    p=tmp_path/'uploads/SID/source.wav';p.parent.mkdir(parents=True)
    with wave.open(str(p),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(b'\x00\x00'*16000*30)
    monkeypatch.setattr(engine.preprocess,'audio_to_wav',lambda _:p)
    calls=[]
    def asr(wav,out):
        calls.append(('speech',str(out)));return dict(turns=[dict(ts=1.,end=2.,speaker='unknown',text='独立连续片段',participant_id=None)])
    def ac(wav,turns,out):
        calls.append(('acoustic',str(out)));return dict(anomalies=[],baseline_status='insufficient')
    def sm(turns,out,topics):
        calls.append(('semantic',str(out)));return dict(anomalies=[],impacts=[])
    monkeypatch.setattr(speech,'run',asr);monkeypatch.setattr(acoustic,'run',ac);monkeypatch.setattr(semantic,'run',sm)
    monkeypatch.setattr(vision,'run',lambda *a:dict(anomalies=[],modality_available=['face'],quality='ok'))
    monkeypatch.setattr(rppg,'run',lambda *a:dict(anomalies=[],hr_series=[],quality='degraded',quality_note='短片段心率不足'))
    asset=dict(id='AS-1',name='source.webm',kind='video',storage_key=p.name,sha256=hashlib.sha256(p.read_bytes()).hexdigest(),size_bytes=p.stat().st_size,duration_seconds=30)
    return asset,calls,p


def compute(assets,capture,**extra):
    return engine.compute(dict(id='SID',assets=assets,primary_asset_id=assets[0]['id'],revision=1,capture=capture,**extra),dict(id='RUN',source_revision=1),lambda *a:None)


@pytest.mark.parametrize('fault',[False,True])
def test_pause_segments_keep_valid_media_and_limit_only_faulty_tail(continuous_media,fault):
    asset,calls,_=continuous_media;second=dict(asset,id='AS-2')
    capture=dict(mode='independent-segments-v1',gaps=[dict(kind='pause',at=30)],segments=[dict(asset_id='AS-1',wall_start=0,wall_end=30,closed_by='pause'),dict(asset_id='AS-2',wall_start=40,wall_end=70,closed_by='device-ended' if fault else 'stop')])
    result=compute([asset,second],capture)
    assert sum(kind=='acoustic' for kind,_ in calls)==(1 if fault else 2)
    assert sum(kind=='semantic' for kind,_ in calls)==(1 if fault else 2)
    assert result['slices'][0]['baseline_status']!='capture_gap'
    assert ('face' in result['slices'][1]['modality_available']) is (not fault)
    if fault:assert result['slices'][1]['baseline_status']=='capture_gap'
    else:assert all('semantic' in s['modality_available'] for s in result['slices'])


def test_recovered_tail_is_limited_even_without_pause_mark(continuous_media):
    asset,_,_=continuous_media
    s=dict(assets=[asset],capture=dict(mode='independent-segments-v1',gaps=[],segments=[dict(asset_id=asset['id'],wall_start=0,wall_end=1,closed_by='recovered')]))
    assert unmapped_gap(s,asset)


def test_manual_file_ranges_map_times_and_do_not_bridge_gap(continuous_media,monkeypatch):
    asset,calls,p=continuous_media
    monkeypatch.setattr(media_analysis,'crop',lambda *a:p)
    def ac(wav,turns,out):
        calls.append(('acoustic',str(out)));return dict(baseline_status='available',anomalies=[RawEvent(ts=1.,modality='voice',type='片段观察',severity='WARN',confidence=.8,window=(1.,2.))])
    def sm(turns,out,topics):
        assert turns[0]['ts']==1. and turns[0]['end']==2.
        return dict(impacts=[dict(topic_id='T1',ts=1.,boundary=[1.,2.],label='片段话题')],anomalies=[RawEvent(ts=1.,modality='semantic',type='片段语义',severity='WARN',confidence=.8,window=(1.,2.))])
    monkeypatch.setattr(acoustic,'run',ac);monkeypatch.setattr(semantic,'run',sm)
    ranges=dict(ranges=[dict(asset_id='AS-1',start=0.,end=5.),dict(asset_id='AS-1',start=10.,end=15.)],asset_hashes={'AS-1':asset['sha256']})
    corrections=dict(turns=[dict(id='T1',asset_id='AS-1',ts=1.,end=2.,speaker='subject',participant_id='P2',text='第一段'),dict(id='CUT',asset_id='AS-1',ts=4.,end=12.,speaker='subject',participant_id='P2',text='跨缺口不应进入分析'),dict(id='T2',asset_id='AS-1',ts=11.,end=12.,speaker='subject',participant_id='P2',text='第二段')],topics=[])
    result=compute([asset],dict(gaps=[dict(kind='pause',at=5)]),analysis_intervals=ranges,corrections=corrections)
    assert [t['ts'] for t in result['turns']]==[1.,11.]
    assert {e['segment_id'] for e in result['anomalies']}=={'SEG-001','SEG-002'}
    for event in result['raw_events']:
        start,end=(0,5) if event['segment_id']=='SEG-001' else (10,15)
        assert start<=event['window'][0]<=event['ts']<=event['window'][1]<=end
    assert len([e for e in result['anomalies'] if e['type']=='跨模态同窗聚合升级'])==2
    assert [t['boundary'] for t in result['impacts']]==[[1.,2.],[11.,12.]]
    assert (engine.ARTIFACTS/'SID/RUN/AS-1/SEG-001').is_dir()
    assert p.read_bytes()


def test_fusion_entry_cannot_merge_or_escalate_across_segments():
    a=RawEvent(ts=1,modality='voice',type='same',severity='WARN',confidence=.8,window=(1,2),segment_id='S1')
    b=RawEvent(ts=3,modality='semantic',type='same',severity='WARN',confidence=.8,window=(3,4),segment_id='S2')
    assert all(e.severity!='ESCALATED' for e in fusion.fuse([a,b],'SID'))


def test_range_api_scope_validation_revision_and_history(workspace,media_bytes):
    store,c,_=workspace;sid,rid,run=analyzed(workspace,media_bytes);before=copy.deepcopy(store.get('runs',run))
    payload=dict(revision=1,verified=True,note='已回看核验文件内连续区间',ranges=[dict(asset_id='AS-1',start=0,end=1),dict(asset_id='AS-1',start=2,end=3)])
    assert c['C-04'].post(f'/v1/sessions/{sid}/analysis-intervals',json=payload).status_code==403
    for patch in (dict(verified=False),dict(ranges=[dict(asset_id='AS-1',start=0,end=9)]),dict(ranges=[dict(asset_id='AS-1',start=1,end=2),dict(asset_id='AS-1',start=0,end=1)]),dict(ranges=[dict(asset_id='unknown',start=0,end=1)])):
        assert c['W-02'].post(f'/v1/sessions/{sid}/analysis-intervals',json={**payload,**patch}).status_code==422
    r=c['W-02'].post(f'/v1/sessions/{sid}/analysis-intervals',json=payload);assert r.status_code==200,r.text
    assert store.get_session(sid)['stale'] and store.get_session(sid)['revision']==2
    assert store.get('runs',run)==before and store.get_report(rid)['source_run_id']==run
    assert c['W-02'].post(f'/v1/sessions/{sid}/analysis-intervals',json=payload).status_code==409


def test_capture_manifest_rejects_forged_or_missing_parts():
    assets=[dict(id='AS-1')]
    for segments in ([],[dict(asset_id='wrong',wall_start=0,wall_end=2,closed_by='stop')],[dict(asset_id='AS-1',wall_start=2,wall_end=1,closed_by='stop')]):
        with pytest.raises(ValueError):validate_capture(dict(mode='independent-segments-v1',segments=segments),assets)


def test_real_crop_preserves_source_and_exact_part_duration(tmp_path,media_bytes):
    source=tmp_path/'source.wav';source.write_bytes(media_bytes);sha=hashlib.sha256(media_bytes).hexdigest()
    cropped=media_analysis.crop(source,.5,1.5,tmp_path/'part.wav',False)
    with wave.open(str(cropped)) as f:assert abs(f.getnframes()/f.getframerate()-1)<.02
    assert hashlib.sha256(source.read_bytes()).hexdigest()==sha


def test_report_freezes_verified_ranges_and_exports_segment_reference(workspace,media_bytes):
    import csv,io
    from app.reporting import document,render
    store,_,_=workspace;sid,rid,_=analyzed(workspace,media_bytes);report=copy.deepcopy(store.get_report(rid))
    result=copy.deepcopy(store.get_session(sid)['offline'])
    result['manifest']['analysis_intervals']=dict(verified_by='W-02',note='已回看确认两段连续有效',ranges=[dict(asset_id='AS-1',start=0,end=1),dict(asset_id='AS-1',start=2,end=3)])
    result['anomalies'][0]['segment_id']='SEG-001'
    report['content_hash']='QA';report['snapshot']=dict(result=result,sections=report['sections'],reviews={})
    _,sections=document(report)
    quality=next(text for title,text in sections if '固定附件' in title)
    assert 'W-02' in quality and '0—1' in quality and '2—3' in quality and '其余范围排除' in quality
    data,_=render(report,'csv','READ-01','区间验证');rows=list(csv.DictReader(io.StringIO(data.decode('utf-8-sig'))))
    assert rows[0]['segment_id']=='SEG-001'
    report['snapshot']['presentation']=[dict(title=title,text=text) for title,text in sections]
    assert document(report)[1]==sections


def test_no_video_frames_is_explicit_quality_abstention(tmp_path,monkeypatch):
    from types import SimpleNamespace
    cap=SimpleNamespace(isOpened=lambda:True,get=lambda prop:25 if prop==vision.cv2.CAP_PROP_FPS else 0,read=lambda:(False,None),release=lambda:None)
    monkeypatch.setattr(vision.cv2,'VideoCapture',lambda *a:cap)
    for target,name in [(vision.mp.solutions.face_mesh,'FaceMesh'),(vision.mp.solutions.pose,'Pose'),(vision.mp.solutions.hands,'Hands')]:
        monkeypatch.setattr(target,name,lambda **kw:SimpleNamespace(close=lambda:None))
    result=vision.run(tmp_path/'empty.mkv',tmp_path)
    assert not result['anomalies'] and not result['modality_available'] and '无可解码视频帧' in result['quality_note']
