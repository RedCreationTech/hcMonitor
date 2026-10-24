#!/usr/bin/env node
/* CDP 1234 截图工装：attach 到用户已启动的 Chrome（--remote-debugging-port=1234），
 * 用于正式版 PPT 素材采集（用户要求走 1234 端口）。
 * 前置：/Applications/Google Chrome.app/Contents/MacOS/Google Chrome \
 *        --remote-debugging-port=1234 --user-data-dir=<任意目录> "http://127.0.0.1:5185/"
 * 用法 node tools/shot-cdp.mjs --url=... --out=... [--wait=1500] [--pre=JS] [--post=JS] [--full=1]
 */
import { writeFileSync } from 'node:fs';

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf('=');
    return i < 0 ? [a.replace(/^--?/, ''), true] : [a.slice(2, i), a.slice(i + 1)];
  }),
);
if (!argv.url || !argv.out) {
  console.error('需要 --url= 与 --out=，且 Chrome 需以 --remote-debugging-port=1234 启动');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 找/建 page target
async function pageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:1234/json/list')).json();
      let page = list.find((t) => t.type === 'page');
      if (!page) {
        page = await (await fetch('http://127.0.0.1:1234/json/new?about:blank', { method: 'PUT' })).json();
      }
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* Chrome 未就绪 */ }
    await sleep(400);
  }
  throw new Error('连不上 127.0.0.1:1234 的 Chrome（先启动带调试端口的 Chrome）');
}

function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const ready = new Promise((r) => ws.addEventListener('open', r));
  return {
    ready,
    send(method, params = {}) {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close: () => ws.close(),
  };
}

const page = await pageTarget();
const cdp = client(page.webSocketDebuggerUrl);
await cdp.ready;
await cdp.send('Page.enable');
// --actor=W-02/R-01：导航前注入席位 localStorage（与 tools/shot.mjs 同一份身份表）
const ACTORS = {
  'W-02': { id: 'W-02', name: '分析师 W-02', role: 'analyst', seat: '研判席 2' },
  'R-01': { id: 'R-01', name: '复核人 R-01', role: 'reviewer', seat: '复核席' },
};
if (argv.actor && ACTORS[argv.actor]) {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('yansin.actor', ${JSON.stringify(JSON.stringify(ACTORS[argv.actor]))})}catch(e){}`,
  });
}
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
await cdp.send('Page.navigate', { url: argv.url });
await sleep(Number(argv.settle || 2500));
await sleep(Number(argv.wait || 1500));

const run = async (expr) => {
  if (!expr) return;
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) console.error('EVAL:', JSON.stringify(r.exceptionDetails).slice(0, 200));
  else console.log('PRE:', JSON.stringify(r.result.value).slice(0, 200));
};
await run(argv.pre);
await sleep(300);
await run(argv.post);

const params = { format: 'png' };
if (argv.full === '1') {
  const { cssContentSize } = await cdp.send('Page.getLayoutMetrics');
  params.captureBeyondViewport = true;
  params.clip = { x: 0, y: 0, width: cssContentSize.width, height: Math.min(cssContentSize.height, 12000), scale: 1 };
}
const shot = await cdp.send('Page.captureScreenshot', params);
writeFileSync(argv.out, Buffer.from(shot.data, 'base64'));
console.log('SAVED', argv.out);
cdp.close();
