/* WebRTC 活体采集链路技术自检：在 CDP1234 Chrome 里走通
 * getUserMedia → MediaRecorder → 上传 → 起批 的前端同款链路（fake 音视频源）。
 * 用法: node tools/webrtc-selftest.mjs
 */
const page = await (async () => {
  const list = await (await fetch('http://127.0.0.1:1234/json/list')).json();
  return list.find((t) => t.type === 'page');
})();
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { resolve } = pending.get(m.id); pending.delete(m.id); resolve(m.result); }
});
const ready = new Promise((r) => ws.addEventListener('open', r));
await ready;
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, { resolve: r })); };

await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:5185/t/workstation' });
await new Promise((r) => setTimeout(r, 4000));

const result = await send('Runtime.evaluate', {
  awaitPromise: true, returnByValue: true,
  expression: `(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 }, audio: true });
    const tracks = stream.getTracks().map(t => t.kind + ':' + t.readyState);
    const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm' });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => rec.onstop = r);
    rec.start(1000);
    await new Promise((r) => setTimeout(r, 15000));
    rec.stop();
    await stopped;
    stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(chunks, { type: 'video/webm' });
    // 前端同款：建会话 → 上传 → 起批
    const s = await (await fetch('/v1/sessions', { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ subject_code: '对象 W-TEST', scene: 'WebRTC 链路自检', form: 'B',
        consent_doc: 'SQ-SELFTEST', source: 'imported',
        assets: [{ id: 'video:live', name: '活体采集_selftest.webm', size_bytes: blob.size, duration_seconds: 15, kind: 'video' }] }) })).json();
    const fd = new FormData();
    fd.append('file', blob, '活体采集_selftest.webm');
    fd.append('kind', 'video');
    fd.append('asset_id', 'video:live');
    const up = await (await fetch('/v1/sessions/' + s.id + '/assets', { method: 'POST', body: fd })).json();
    const an = await (await fetch('/v1/sessions/' + s.id + '/analyze-offline', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' })).json();
    return { tracks, blobBytes: blob.size, session: s.id, upload: up, analyze: an };
  })()`,
});
console.log(JSON.stringify(result.result.value, null, 1));
ws.close();
