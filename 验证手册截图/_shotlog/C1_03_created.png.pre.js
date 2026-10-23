(async()=>{try{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const setVal=(el,v)=>{const p=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(p,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
  await sleep(900);
  const seg=[...document.querySelectorAll('.login-card .ant-segmented-item')].find(x=>x.textContent.includes("分析师"));
  const radio=seg?.querySelector('input'); if(radio) radio.click(); else if(seg) seg.click();
  await sleep(400);
  const emp=[...document.querySelectorAll('.login-card input')].find(i=>(i.placeholder||'').includes('R-01'));
  const pinEl=[...document.querySelectorAll('.login-card input')].find(i=>(i.placeholder||'').includes('1234'));
  setVal(emp,"W-02"); setVal(pinEl,'1234');
  await sleep(300);
  const ok=[...document.querySelectorAll('.login-card button')].find(b=>b.textContent.replace(/\s+/g,'').includes('登录并占用席位'));
  if(!ok) return 'ERR:登录按钮不可点（口令未填或工号为空）';
  if(ok.disabled) return 'ERR:登录按钮仍禁用';
  ok.click(); await sleep(1700);
  /* 登录提示条会在后面每张图上都压住顶栏，这里把它抹掉；本步自己触发的提示不受影响 */
  document.querySelectorAll('.ant-message-notice-wrapper,.ant-message-notice').forEach((n)=>n.remove());
  const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('新建会话'));if(!btn) return 'ERR:没找到新建会话按钮（未登录？）';btn.click();await sleep(700);
  for(const [ph,v] of [["M-121","M-T101"],["经侦询问 · 谈话室 03","验证 C1 · 音视频单路离线复盘 · 谈话室 03"],["SQ-2026-121","SQ-2026-T101"]]){
    if(v===undefined) continue;
    const el=[...document.querySelectorAll('.ant-modal input')].find(i=>i.placeholder===ph); if(el) setVal(el,v); }
  const zones=[...document.querySelectorAll('.ant-modal .ant-upload-drag')];
  for(const f of [{"name":"V1_谈话室正面_音视频_156s.mp4","type":"video/mp4","zone":0,"big":false}]){
    const buf=await (await fetch('/testkit/'+encodeURIComponent(f.name))).arrayBuffer();
    const dt=new DataTransfer(); dt.items.add(new File([buf],f.name,{type:f.type}));
    const z=zones[f.zone]; const inp=z.querySelector('input[type=file]');
    inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true}));
    z.dispatchEvent(new DragEvent('dragover',{dataTransfer:dt,bubbles:true,cancelable:true}));
    z.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));
    await sleep(f.big?2200:1700); }
  document.querySelector('.ant-modal-footer .ant-btn-primary').click();
  await sleep(2200);
  const txt=[...document.querySelectorAll('.ant-table-tbody tr')].map(r=>r.textContent).join('\n');
  const msg=[...document.querySelectorAll('.ant-message-notice')].map(e=>e.textContent).join('');
  const m=txt.match(/SES-\d{8}-N\d{2}/) ?? msg.match(/SES-\d{8}-N\d{2}/);
  return m ? m[0] : 'NO-ID';;return 'ok'}catch(e){return 'ERR:'+(e&&e.message?e.message:String(e))}})()