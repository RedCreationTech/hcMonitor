"""Real local model smoke. Run from analysis-service; no mock generation."""
import json
import socket
import sys
from pathlib import Path
socket.socket.connect=lambda *a,**kw: (_ for _ in ()).throw(RuntimeError('offline smoke: network prohibited'))
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.pipeline import attribution,fusion
from app.pipeline.events import RawEvent
from app.narrative import assemble

if __name__=='__main__':
    # Child inherits offline env; localhost and Internet sockets are both forbidden in this invocation.
    ev=RawEvent(ts=10,modality='voice',type='jitter 异常升高',severity='WARN',confidence=.7,asset_id='SMOKE',participant_id='P2',window=(5,15))
    e=attribution.fill_attribution(fusion.to_contract_event(ev,1,'SMOKE'),attribution.load_rules());e['participant_id']='P2'
    result=assemble([e],'SMOKE-REAL-LLM')
    assert result['status']=='generated',result
    assert result['citations'] and result['citations'][0]['event_id']=='EV-001'
    print(json.dumps(result,ensure_ascii=False,indent=2))
