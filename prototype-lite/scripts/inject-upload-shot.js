/* 截图用注入脚本：作为 tools/shot.mjs 的 --pre 参数，把四路素材真实拖进上传框。
 * 走的是页面自己的 drop → probeDuration / probeSeries → onPick 链路，所以画面里的时长与大小是本机读出来的，不是写死的。
 * 用法见 ../../README.md「可视稿重拍」。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建会话'));
  btn.click();
  await sleep(500);

  const setVal = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  for (const [ph, v] of [['M-121', 'M-118'], ['经侦询问 · 谈话室 03', '多信号源离线复盘 · 谈话室 03'], ['SQ-2026-121', 'SQ-2026-118（含录像二次使用授权）']]) {
    const el = [...document.querySelectorAll('.ant-modal input')].find((i) => i.placeholder === ph);
    if (el) setVal(el, v);
  }

  const drops = [
    ['询问谈话_录像样例_156s.mp4', 'video/mp4'],
    ['谈话录音_音频样例_156s.m4a', 'audio/mp4'],
    ['nir_hbo_152s.csv', 'text/csv'],
    ['mmwave_resp_152s.csv', 'text/csv'],
  ];
  const zones = [...document.querySelectorAll('.ant-modal .ant-upload-drag')];
  const out = [];
  for (let i = 0; i < drops.length; i++) {
    const [name, type] = drops[i];
    const buf = await (await fetch('/demo/' + encodeURIComponent(name))).arrayBuffer();
    const dt = new DataTransfer();
    dt.items.add(new File([buf], name, { type }));
    const zone = zones[i];
    /* 先走隐藏 input（与点选文件同一条链路），再补一次 drop（与拖拽同一条链路） */
    const input = zone.querySelector('input[type=file]');
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    out.push(name + '@' + (input ? 'input+drop' : zone ? 'drop' : 'nozone'));
    await sleep(1400);
  }
  await sleep(900);
  return {
    zones: zones.length,
    drops: out,
    registered: [...document.querySelectorAll('.ant-modal .mono')].map((e) => e.textContent).filter((t) => /\.(mp4|m4a|csv)$/.test(t)),
  };
})()
