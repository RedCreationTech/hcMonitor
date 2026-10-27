import hashlib
import wave
import pytest
from app import engine,model_inventory
from app.pipeline import speech,acoustic,semantic,vision,rppg


@pytest.mark.parametrize('code_changed',[False,True])
@pytest.mark.parametrize('asset_count',[1,2])
def test_failed_visual_detectors_preserve_valid_audio_without_fake_physiology(tmp_path,monkeypatch,code_changed,asset_count):
    updates=[]
    def progress(percent,label):updates.append((percent,label))
    monkeypatch.setattr(engine,'UPLOADS',tmp_path/'uploads');monkeypatch.setattr(engine,'ARTIFACTS',tmp_path/'artifacts')
    monkeypatch.setattr(model_inventory,'frozen_inventory',lambda:[])
    folder=tmp_path/'uploads/SID';folder.mkdir(parents=True);path=folder/'source.wav'
    with wave.open(str(path),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(b'\x00\x00'*16000*3)
    monkeypatch.setattr(engine.preprocess,'audio_to_wav',lambda _:path)
    def transcribe(*args):
        assert 0 < updates[-1][0] < 100 and '转写与说话人识别' in updates[-1][1]
        return dict(turns=[dict(ts=0,end=3,speaker='unknown',text='质量测试',participant_id=None)])
    monkeypatch.setattr(speech,'run',transcribe)
    monkeypatch.setattr(acoustic,'run',lambda *a:dict(anomalies=[],baseline_status='insufficient'))
    monkeypatch.setattr(semantic,'run',lambda *a:dict(anomalies=[],impacts=[]))
    def fail(*a,**kw):raise ValueError('video channel unavailable')
    monkeypatch.setattr(vision,'run',fail);monkeypatch.setattr(rppg,'run',fail)
    asset=dict(id='AS-V',kind='video',name='x.mp4',storage_key='source.wav',sha256=hashlib.sha256(path.read_bytes()).hexdigest(),size_bytes=path.stat().st_size,duration_seconds=3)
    session=dict(id='SID',assets=[dict(asset,id='AS-V' if i==0 else f'AS-V{i+1}') for i in range(asset_count)],primary_asset_id='AS-V',revision=1)
    if code_changed:
        snapshots=iter([engine.code_hash(),'after']);monkeypatch.setattr(engine,'code_hash',lambda:next(snapshots))
        with pytest.raises(ValueError,match='代码已变化'):
            engine.compute(session,dict(id='RUN',source_revision=1),progress)
        return
    result=engine.compute(session,dict(id='RUN',source_revision=1),progress)
    assert [p for p,_ in updates]==sorted(p for p,_ in updates)
    assert all(0 < p < 100 for p,_ in updates)
    assert sum('转写与说话人识别' in label for _,label in updates)==asset_count
    assert any('视觉证据分析' in label for _,label in updates)
    assert any('本地候选叙述' in label for _,label in updates)
    assert updates[-1]==(95,'结果指纹与固定版本复核')
    assert (tmp_path/'artifacts/SID/RUN/_code/engine.py').is_file()
    assert result['manifest']['environment']['python']
    sl=result['slices'][0];assert sl['modality_available']==['voice','semantic']
    assert 'physio' in sl['modality_unavailable'] and sl['quality']=='degraded'
    assert result['narrative']['status']=='not_applicable'


def test_recording_gaps_only_allow_transcription(tmp_path,monkeypatch):
    monkeypatch.setattr(engine,'UPLOADS',tmp_path/'uploads');monkeypatch.setattr(engine,'ARTIFACTS',tmp_path/'artifacts');monkeypatch.setattr(model_inventory,'frozen_inventory',lambda:[])
    folder=tmp_path/'uploads/SID';folder.mkdir(parents=True);path=folder/'source.wav'
    with wave.open(str(path),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(b'\x00\x00'*16000*3)
    monkeypatch.setattr(engine.preprocess,'audio_to_wav',lambda _:path)
    monkeypatch.setattr(speech,'run',lambda *a:dict(turns=[dict(ts=0,end=3,speaker='unknown',text='有暂停的转写',participant_id=None,speech_rate=4.)]))
    def forbidden(*a,**kw):raise AssertionError('gapped capture must not produce continuous measurements')
    for module in (acoustic,semantic,vision,rppg):monkeypatch.setattr(module,'run',forbidden)
    asset=dict(id='AS',kind='video',name='gap.webm',storage_key='source.wav',sha256=hashlib.sha256(path.read_bytes()).hexdigest(),size_bytes=path.stat().st_size,duration_seconds=3)
    result=engine.compute(dict(id='SID',assets=[asset],primary_asset_id='AS',revision=1,capture={'gaps':[{'kind':'pause','at':1.}]}),dict(id='RUN',source_revision=1),lambda *a:None)
    assert result['turns'] and result['turns'][0]['speech_rate'] is None
    assert not result['anomalies'] and not result['impacts'] and result['slices'][0]['baseline_status']=='capture_gap'
    assert result['slices'][0]['quality']=='degraded'
