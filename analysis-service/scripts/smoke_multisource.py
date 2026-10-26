"""Real short-video + file-sensor smoke; no inference stubs and no human accuracy claims."""
import os,sys,socket,json,uuid,shutil,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT));os.environ['DATA_ROOT']=str(ROOT/'data'/('qa-video-'+uuid.uuid4().hex[:8]));os.environ['MODEL_DOWNLOAD_POLICY']='offline'
socket.socket.connect=lambda *a,**kw: (_ for _ in ()).throw(RuntimeError('network prohibited'))

def main():
    from app.config import DATA,UPLOADS,FFMPEG
    from app.engine import compute,sha
    folder=ROOT/'data/uploads/SES-20261024-001';sid='QA-VIDEO';dest=UPLOADS/sid;dest.mkdir(parents=True)
    video=dest/'video.mp4'
    subprocess.run([FFMPEG,'-v','error','-i',str(folder/'询问谈话_录像样例_156s.mp4'),'-t','12','-c','copy',str(video)],check=True)
    assets=[]
    for name,kind in [('video.mp4','video'),('nir_hbo_152s.csv','nir'),('mmwave_resp_152s.csv','mmwave')]:
        path=dest/name
        if kind!='video':shutil.copyfile(folder/name,path)
        assets.append(dict(id='AS-'+kind,name=name,kind=kind,storage_key=name,sha256=sha(path),size_bytes=path.stat().st_size,duration_seconds=12 if kind=='video' else 152))
    session=dict(id=sid,assets=assets,primary_asset_id='AS-video',revision=1)
    run=dict(id='RUN-VIDEO',source_revision=1)
    result=compute(session,run,lambda p,s:None)
    assert result['slices'][0]['modality_available'] and len(result['slices'])==3
    assert 'physio' not in result['slices'][0]['modality_available'], '12s片段没有足够心率窗口，不能显示可用'
    assert all(not e['cap_note'] or not e['attribution']['candidate_rules'] for e in result['anomalies'])
    assert all(e['source_assets'] and e['source_event_ids'] for e in result['anomalies'])
    summary=dict(fixture='repository demo video cut to12s plus original file sensors; engineering smoke only',network='socket.connect denied',
        data_root=str(DATA),slices=[{k:s[k] for k in ('kind','quality','quality_note','modality_available')} for s in result['slices']],
        events=len(result['anomalies']),narrative=result['narrative'],manifest_models=len(result['manifest']['models']))
    (DATA/'smoke-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),'utf-8');print(json.dumps(summary,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
