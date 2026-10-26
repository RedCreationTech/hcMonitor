"""Actual ASR on a Chrome synthetic recording; verify gaps never become continuous measurements."""
import os,sys,json,sqlite3,shutil,uuid,socket
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
os.environ['DATA_ROOT']=str(ROOT/'data'/('qa-capture-gap-'+uuid.uuid4().hex[:8]));os.environ['MODEL_DOWNLOAD_POLICY']='offline'
os.environ['DATABASE_URL']=''
socket.socket.connect=lambda *a,**kw: (_ for _ in ()).throw(RuntimeError('network prohibited'))

if __name__=='__main__':
    from app.engine import compute
    from app.config import DATA,UPLOADS
    source=Path(os.getenv('M1_BROWSER_DATA_ROOT',str(ROOT/'data/qa-browser-frozen')))
    db=sqlite3.connect(source/'workspace.sqlite3');state=json.loads(db.execute('select payload from minddialogue_state where id=1').fetchone()[0]);db.close()
    session=next(s for s in state['sessions'] if s['subject_code']=='CAMERA-SYNTHETIC' and s.get('capture',{}).get('gaps'))
    dest=UPLOADS/session['id'];dest.mkdir(parents=True)
    for asset in session['assets']:shutil.copy2(source/'uploads'/session['id']/asset['storage_key'],dest/asset['storage_key'])
    result=compute(session,dict(id='RUN-GAP',source_revision=session['revision']),lambda *a:None)
    assert result['turns'] and not result['anomalies'] and not result['impacts']
    assert result['slices'][0]['baseline_status']=='capture_gap' and result['slices'][0]['quality']=='degraded'
    out=DATA/'artifacts'/session['id']/'RUN-GAP'/session['assets'][0]['id']
    assert all(not (out/name).exists() for name in ('acoustic','semantic','vision','rppg'))
    summary=dict(passed=True,fixture='Chrome synthetic camera/microphone; actual local ASR, not human accuracy',gaps=session['capture']['gaps'],turns=len(result['turns']),events=0,impacts=0,continuous_measurements='abstained',quality=result['slices'][0]['quality_note'])
    (DATA/'smoke-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),'utf-8');print(json.dumps(summary,ensure_ascii=False,indent=2))
