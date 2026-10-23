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
  document.querySelectorAll('.ant-message-notice-wrapper,.ant-message-notice').forEach((n)=>n.remove());await sleep(1600);
  const txt=(x)=>x.textContent.replace(/\s+/g,'');
  const tr=[...document.querySelectorAll('.ant-table-tbody tr')].find(r=>r.textContent.includes("RP-2026-05"));
  if(tr) tr.click(); await sleep(1100);
  const pick=(label)=>[...document.querySelectorAll('button')].find(x=>txt(x)===label);
  
  
  const err=[...document.querySelectorAll('.ant-message-notice')].map(e=>e.textContent).join('');
  return ["RP-2026-05",'席位='+(localStorage.getItem('yansin.actor')??'-').replace(/"/g,''),
    '提示'+(err?('「'+err+'」'):'无'),
    '按钮='+['提交复核','通过','驳回','发布'].map((l)=>{const b=[...document.querySelectorAll('button')].find((x)=>txt(x).includes(l));return l+(b?(b.disabled?'=禁用':'=可点'):'=无');}).join(',')].join(' | ');return 'ok'}catch(e){return 'ERR:'+(e&&e.message?e.message:String(e))}})()