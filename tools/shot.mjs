#!/usr/bin/env node
/* 本地截图工装：in-app Browser 面板不可见时，用系统 Chrome 无头模式补拍实机画面。
 * 本文件是 精简版/ 自带的独立副本（精简版所有产物单存一处，不依赖仓库根的共享工装），
 * 与 ../../tools/shot.mjs 同源；改了一边记得同步另一边。
 * 用法 node 精简版/tools/shot.mjs --url=... --out=... [--wait=1200] [--pre=JS] [--post=JS] [--w=1280] [--h=800] [--actor=W-02]
 * --actor 会在页面脚本执行前写入席位 localStorage，等价于在登录页点过一次登录。 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf('=');
    return i < 0 ? [a.replace(/^--?/, ''), true] : [a.slice(2, i), a.slice(i + 1)];
  }),
);
if (!argv.url || !argv.out) {
  console.error('需要 --url= 与 --out=');
  process.exit(2);
}
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = Number(argv.w || 1280);
const H = Number(argv.h || 800);
const ACTORS = {
  'W-02': { id: 'W-02', name: '分析师 W-02', role: 'analyst', seat: '研判席 2' },
  'R-01': { id: 'R-01', name: '复核人 R-01', role: 'reviewer', seat: '复核席' },
  'C-04': { id: 'C-04', name: '采集员 C-04', role: 'collector', seat: '谈话室 03' },
  'A-01': { id: 'A-01', name: 'Admin', role: 'admin', seat: '管理后台' },
};

const profile = mkdtempSync(join(tmpdir(), 'yansin-shot-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--allow-file-access-from-files',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--force-device-scale-factor=2',
    `--window-size=${W},${H}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function devtoolsWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return { port, ws: page.webSocketDebuggerUrl };
    } catch {
      /* 还没写文件 */
    }
    await sleep(200);
  }
  throw new Error('Chrome 未就绪');
}

function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  let seq = 0;
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method) events.push(m);
  });
  const ready = new Promise((r) => ws.addEventListener('open', r));
  return {
    ready,
    send(method, params = {}) {
      const id = ++seq;
      pending.set(id, { method });
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) =>
        pending.set(id, {
          resolve,
          reject: (err) => reject(new Error(`${method}: ${err.message}`)),
        }),
      );
    },
    wait(method, timeout = 20_000) {
      const hit = events.find((e) => e.method === method);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout ${method}`)), timeout);
        const iv = setInterval(() => {
          const h = events.find((e) => e.method === method);
          if (h) { clearTimeout(t); clearInterval(iv); resolve(h); }
        }, 60);
      });
    },
    close: () => ws.close(),
  };
}

const { port, ws: wsUrl } = await devtoolsWs();
const cdp = client(wsUrl);
await cdp.ready;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
if (argv.actor && ACTORS[argv.actor]) {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('yansin.actor', ${JSON.stringify(JSON.stringify(ACTORS[argv.actor]))})}catch(e){}`,
  });
}
await cdp.send('Page.navigate', { url: argv.url });
await cdp.wait('Page.loadEventFired');
await sleep(Number(argv.settle || 1200));

const run = async (expr) => {
  if (!expr) return;
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) console.error('EVAL:', r.exceptionDetails.text);
  else console.log('PRE:', JSON.stringify(r.result.value).slice(0, 300));
};
await run(argv.pre);
await sleep(Number(argv.wait || 0));
await run(argv.post);

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync(argv.out, Buffer.from(shot.data, 'base64'));
console.log('SAVED', argv.out);
cdp.close();
chrome.kill();
await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
void port;
