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
  for(const [ph,v] of [["M-121","M-N2"],["经侦询问 · 谈话室 03","验证 N2 · 表单填全但不拖文件 · 谈话室 03"],["SQ-2026-121","SQ-2026-N2"]]){
    if(v===undefined) continue;
    const el=[...document.querySelectorAll('.ant-modal input')].find(i=>i.placeholder===ph); if(el) setVal(el,v); }
  document.querySelector('.ant-modal-footer .ant-btn-primary').click();
  await sleep(900);
  const err=[...document.querySelectorAll('.ant-message-notice')].map(e=>e.textContent).join(' / ');
  const field=[...document.querySelectorAll('.ant-modal .ant-form-item-explain-error')].map(e=>e.textContent).join(' / ');
  return '提示：' + (err || field || '未出现拦截提示');;return 'ok'}catch(e){return 'ERR:'+(e&&e.message?e.message:String(e))}})()