/* 验证手册实拍驱动：按用例走真实 UI 链路（拖入 public/testkit 的素材 → 本机读元数据 → 建会话 → 起批 → 结果 → 报告 → 审批发布 → 导出），
 * 每一步用 tools/shot.mjs 无头 Chrome 实拍一张画面，并把服务端返回的真实数字记进 取证记录.md。
 * 前提：npm run dev 跑在 5185。
 * 用法：
 *   node scripts/testkit-shots.mjs                 # 全部主用例 + 负向用例
 *   node scripts/testkit-shots.mjs --only=C1       # 只跑一个或几个（C1..C5 / N1..N9，逗号分隔）
 *   node scripts/testkit-shots.mjs --only=C1 --steps=register,created
 * 产物与配套文档：../验证手册截图/（PNG + 取证记录）· ../07_精简版验证操作手册.md
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = join(ROOT, '..', 'tools', 'shot.mjs');
const OUT_DIR = join(ROOT, '..', '验证手册截图');
const EV_DIR = join(OUT_DIR, '取证记录');
const APP = 'http://127.0.0.1:5185';
const B = `${APP}/v1`;
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7);
const stepFilter = (process.argv.find((a) => a.startsWith('--steps=')) ?? '').slice(8).split(',').filter(Boolean);

/* ── 测试包素材：zone 0=视频 1=音频 2=近红外 3=毫米波（与新建会话弹窗四个登记框同序） ── */
const TK = {
  V1: { name: 'V1_谈话室正面_音视频_156s.mp4', type: 'video/mp4', zone: 0 },
  V2: { name: 'V2_谈话室侧面_音视频_192s.mp4', type: 'video/mp4', zone: 0 },
  A1: { name: 'A1_单对象询问_录音_156s.m4a', type: 'audio/mp4', zone: 1 },
  A2: { name: 'A2_双人谈话_录音_192s.mp3', type: 'audio/mpeg', zone: 1 },
  E1: { name: 'E1_近红外_hbo_156s_1Hz.csv', type: 'text/csv', zone: 2 },
  E2: { name: 'E2_毫米波_resp_156s_1Hz.csv', type: 'text/csv', zone: 3 },
  E3: { name: 'E3_近红外_hbo_156s_10Hz.csv', type: 'text/csv', zone: 2 },
  E4: { name: 'E4_毫米波_resp_156s_25Hz.csv', type: 'text/csv', zone: 3 },
  E5: { name: 'E5_近红外_hbo_156s_2Hz.tsv', type: 'text/tab-separated-values', zone: 2 },
  X1: { name: 'X1_短素材边界件_音视频_40s.mp4', type: 'video/mp4', zone: 0 },
  X2: { name: 'X2_边界_首列为物理量_无时间轴.csv', type: 'text/csv', zone: 2 },
  X3: { name: 'X3_边界_超4MB采样序列.csv', type: 'text/csv', zone: 3 },
  X4: { name: 'X4_边界_JSON采样序列.json', type: 'application/json', zone: 2 },
};

const CASES = {
  C1: {
    label: '音视频单路主链路', fill: { subject: 'M-T101', scene: '验证 C1 · 音视频单路离线复盘 · 谈话室 03', consent: 'SQ-2026-T101' },
    files: ['V1'], steps: ['login_gate', 'register', 'created', 'progress', 'result_top', 'slices', 'anomalies', 'attribution', 'impacts', 'transcript', 'report_draft', 'export_draft', 'submit', 'approve_publish', 'export_published'],
  },
  C2: {
    label: '纯音频单模态', fill: { subject: 'M-T102', scene: '验证 C2 · 纯音频离线分析 · 谈话室 01', consent: 'SQ-2026-T102' },
    files: ['A1'], steps: ['register', 'created', 'progress', 'result_top', 'modality', 'slices', 'report_draft'],
  },
  C3: {
    label: '音视频 + 双扩展信号', fill: { subject: 'M-T103', scene: '验证 C3 · 多信号源融合 · 谈话室 03', consent: 'SQ-2026-T103' },
    files: ['V1', 'E1', 'E2'], steps: ['register', 'created', 'progress', 'result_top', 'slices', 'ext_slice', 'anomalies', 'report_draft'],
  },
  C4: {
    label: '四份主素材多文件', fill: { subject: 'M-T104', scene: '验证 C4 · 多路文件逐份切片 · 谈话室 03', consent: 'SQ-2026-T104' },
    files: ['V1', 'V2', 'A1', 'A2'], steps: ['register', 'created', 'progress', 'result_top', 'slices', 'anomalies', 'report_draft'],
  },
  C5: {
    label: '仅扩展信号', fill: { subject: 'M-T105', scene: '验证 C5 · 无音视频仅扩展信号 · 谈话室 03', consent: 'SQ-2026-T105' },
    files: ['E3', 'E4'], steps: ['register', 'created', 'progress', 'result_top', 'ext_slice', 'suppressed'],
  },
  N1: { label: '缺授权文书号（R1 服务端卡口）', fill: { subject: 'M-N1', scene: '验证 N1 · 不填授权文书号 · 谈话室 03' }, files: ['V1'], steps: ['n1_gate'], noReset: true },
  N2: { label: '未登记素材不可起批', fill: { subject: 'M-N2', scene: '验证 N2 · 表单填全但不拖文件 · 谈话室 03', consent: 'SQ-2026-N2' }, files: [], steps: ['n2_gate'], noReset: true },
  N3: { label: '分析进行中重复起批', fill: { subject: 'M-N3', scene: '验证 N3 · 批处理未结束时再次起批 · 谈话室 03', consent: 'SQ-2026-N3' }, files: ['V1', 'V2', 'A1', 'A2'], steps: ['created', 'n3_conflict'] },
  N9: { label: '扩展信号封顶口径四处一致', fill: { subject: 'M-N9', scene: '验证 N9 · 结果页/CSV/报告/导出件同口径 · 谈话室 03', consent: 'SQ-2026-N9' }, files: ['V1', 'E1', 'E2'], steps: ['created', 'n9_matrix'] },
  N4: { label: '同名文件去重', fill: { subject: 'M-N4', scene: '验证 N4 · 同一文件重复登记 · 谈话室 03', consent: 'SQ-2026-N4' }, files: ['V1', 'V1'], steps: ['register'], noReset: true },
  N5: { label: '时基读不出的采样序列', fill: { subject: 'M-N5', scene: '验证 N5 · 首列非时间轴 + 超 4MB · 谈话室 03', consent: 'SQ-2026-N5' }, files: ['A1', 'X2', 'X3'], steps: ['register'], noReset: true },
  N7: { label: 'JSON 采样序列', fill: { subject: 'M-N7', scene: '验证 N7 · JSON 导出件 · 谈话室 03', consent: 'SQ-2026-N7' }, files: ['X4'], steps: ['register'], noReset: true },
  N8: { label: '已归档会话不可起批', files: [], steps: ['archived'] },
};

const H = { login_gate: 760, n1_gate: 1560, n2_gate: 1560, n3_conflict: 860, n9_matrix: 1420, register: 1560, created: 812, progress: 880, result_top: 980, slices: 1300, ext_slice: 1350, modality: 1010, anomalies: 1180, attribution: 940, impacts: 1080, transcript: 1120, suppressed: 1180, report_draft: 1420, submit: 1420, approve_publish: 1420, export_draft: 1300, export_published: 1300, archived: 900 };

/* ── 注入脚本 ───────────────────────────────────────────────────────────────
 * 所有片段拼进同一个 async 函数体，sleep 由 guard 统一声明一次；出错统一回 ERR: 便于定位。
 * 席位必须走登录页：服务端只认 /auth/login 落下来的 state.viewer.person（plugin.ts 的 actorOf()），
 * 只写 localStorage 的话按钮会亮但服务端按「未占席的分析师」判职责分离，审批会被 403 拦下。 */
const SLEEP = 'const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));';
/* sleep / setVal 在这里声明一次：下面各片段会拼进同一个函数体，重复 const 会直接 SyntaxError */
const guard = (body) => `(async()=>{try{${SLEEP}${SETVAL}${body};return 'ok'}catch(e){return 'ERR:'+(e&&e.message?e.message:String(e))}})()`;
const SETVAL = `
  const setVal=(el,v)=>{const p=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(p,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};`;
const LOGIN = (role) => `
  await sleep(900);
  const seg=[...document.querySelectorAll('.login-card .ant-segmented-item')].find(x=>x.textContent.includes(${JSON.stringify(role)}));
  const radio=seg?.querySelector('input'); if(radio) radio.click(); else if(seg) seg.click();
  await sleep(400);
  const emp=[...document.querySelectorAll('.login-card input')].find(i=>(i.placeholder||'').includes('R-01'));
  const pinEl=[...document.querySelectorAll('.login-card input')].find(i=>(i.placeholder||'').includes('1234'));
  setVal(emp,${JSON.stringify(role === '复核人' ? 'R-01' : 'W-02')}); setVal(pinEl,'1234');
  await sleep(300);
  const ok=[...document.querySelectorAll('.login-card button')].find(b=>b.textContent.replace(/\\s+/g,'').includes('登录并占用席位'));
  if(!ok) return 'ERR:登录按钮不可点（口令未填或工号为空）';
  if(ok.disabled) return 'ERR:登录按钮仍禁用';
  ok.click(); await sleep(1700);
  /* 登录提示条会在后面每张图上都压住顶栏，这里把它抹掉；本步自己触发的提示不受影响 */
  document.querySelectorAll('.ant-message-notice-wrapper,.ant-message-notice').forEach((n)=>n.remove());`;
const CLICK_NEW = `
  const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('新建会话'));if(!btn) return 'ERR:没找到新建会话按钮（未登录？）';btn.click();await sleep(700);`;
const FILL = (f) => `
  for(const [ph,v] of ${JSON.stringify([['M-121', f.subject], ['经侦询问 · 谈话室 03', f.scene], ['SQ-2026-121', f.consent]])}){
    if(v===undefined) continue;
    const el=[...document.querySelectorAll('.ant-modal input')].find(i=>i.placeholder===ph); if(el) setVal(el,v); }`;
const DROPS = (files) => `
  const zones=[...document.querySelectorAll('.ant-modal .ant-upload-drag')];
  for(const f of ${JSON.stringify(files)}){
    const buf=await (await fetch('/testkit/'+encodeURIComponent(f.name))).arrayBuffer();
    const dt=new DataTransfer(); dt.items.add(new File([buf],f.name,{type:f.type}));
    const z=zones[f.zone]; const inp=z.querySelector('input[type=file]');
    inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true}));
    z.dispatchEvent(new DragEvent('dragover',{dataTransfer:dt,bubbles:true,cancelable:true}));
    z.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));
    await sleep(f.big?2200:1700); }`;
const READ_REG = `
  const reg=[...document.querySelectorAll('.ant-modal .mono')].map(e=>e.textContent.trim()).filter(t=>/\\.(mp4|m4a|mp3|csv|tsv|json)$/.test(t));
  const note=[...document.querySelectorAll('.ant-modal .sub')].map(e=>e.textContent).find(t=>t.includes('主信号 '));
  const noBase=[...document.querySelectorAll('.ant-modal .sub')].map(e=>e.textContent).filter(t=>t.includes('时基未读出')).length;
  return JSON.stringify({份数:reg.filter((v,i,a)=>a.indexOf(v)===i).length, 时基未读出:noBase, 计数行:note??''});`;

/** antd 表格在 scroll.x 下会先插表头/measure 行，会话号直接从整张表的文本里正则取更稳 */
const CREATE = `
  document.querySelector('.ant-modal-footer .ant-btn-primary').click();
  await sleep(2200);
  const txt=[...document.querySelectorAll('.ant-table-tbody tr')].map(r=>r.textContent).join('\\n');
  const msg=[...document.querySelectorAll('.ant-message-notice')].map(e=>e.textContent).join('');
  const m=txt.match(/SES-\\d{8}-N\\d{2}/) ?? msg.match(/SES-\\d{8}-N\\d{2}/);
  return m ? m[0] : 'NO-ID';`;

/** N1：表单只填对象与场景，授权文书号留空 → 前端必填拦住；服务端 403 由 API 断言另记 */
const preNoConsent = (c) => `${CLICK_NEW}${FILL(c.fill)}
  document.querySelector('.ant-modal-footer .ant-btn-primary').click();
  await sleep(900);
  const err=[...document.querySelectorAll('.ant-modal .ant-form-item-explain-error')].map(e=>e.textContent).join(' / ');
  return '前端拦截：' + (err || '未出现必填提示');`;
/** N2：文书号填全但一份素材都不拖 → 前端 message.warning 拦下 */
const preNoAsset = (c) => `${CLICK_NEW}${FILL(c.fill)}
  document.querySelector('.ant-modal-footer .ant-btn-primary').click();
  await sleep(900);
  const err=[...document.querySelectorAll('.ant-message-notice')].map(e=>e.textContent).join(' / ');
  const field=[...document.querySelectorAll('.ant-modal .ant-form-item-explain-error')].map(e=>e.textContent).join(' / ');
  return '提示：' + (err || field || '未出现拦截提示');`;

const preRegister = (c) => `${CLICK_NEW}${FILL(c.fill)}${DROPS(c.files.map((k) => ({ ...TK[k], big: /X3/.test(k) })))}${READ_REG}`;
const preCreate = (c) => `${CLICK_NEW}${FILL(c.fill)}${DROPS(c.files.map((k) => ({ ...TK[k], big: /X3/.test(k) })))}${CREATE}`;

/** antd 表格在 scroll.x 下会先插表头/measure 行，取数据行要过滤掉空文本行 */
const ROWS = `const rows=[...document.querySelectorAll('.ant-table-tbody tr')].filter(r=>r.textContent.trim());`;

/** 行内点「离线分析」起批：ID 由驱动先建好会话再传进来（同一行，与用户点法一致） */
const preAnalyze = (id) => `await sleep(700);
  ${ROWS}
  const tr=rows.find(r=>r.textContent.includes(${JSON.stringify(id)}));
  const b=[...tr.querySelectorAll('button')].find(x=>x.textContent.includes('离线分析'));
  b.click();await sleep(500);return ${JSON.stringify(id)}`;

/** 结果页内层滚动的是 .stage-area：按小标题定位，别用 window.scrollTo */
const preScrollH4 = (kw) => `await sleep(1500);
  const s=document.querySelector('.stage-area');
  const h=[...s.querySelectorAll('h4')].find(n=>n.textContent.includes(${JSON.stringify(kw)}));
  if(h) s.scrollTop+=h.getBoundingClientRect().top-s.getBoundingClientRect().top-10;
  return ${JSON.stringify(kw)}`;
const preScrollCard = (frag) => `await sleep(1500);
  const s=document.querySelector('.stage-area');
  const b=[...s.querySelectorAll('.ant-card-head b.mono')].find(x=>x.textContent.includes(${JSON.stringify(frag)}));
  const c=b?b.closest('.ant-card'):null;
  if(c) s.scrollTop+=c.getBoundingClientRect().top-s.getBoundingClientRect().top-10;
  return ${JSON.stringify(frag)}`;
/** 点开一条主信号异常的三级归因抽屉（优先选升级条目，链路最完整）——限定在「异常事件」那张表里找行 */
const preOpenAttribution = (pick) => `await sleep(1600);
  const s=document.querySelector('.stage-area');
  const sec=[...s.querySelectorAll('.section')].find(x=>x.querySelector('h4')?.textContent.includes('异常事件'));
  const rows=[...sec.querySelectorAll('.ant-table-tbody tr')].filter(r=>r.textContent.trim());
  const hit=rows.find(r=>r.textContent.includes(${JSON.stringify(pick)})) ?? rows[0];
  hit.click();await sleep(1000);return hit.textContent.slice(0,40)`;

/** antd 给两字按钮中间插了空格（"创 建""通 过"），比对文案前先去掉空白 */
const preReport = (rid, act) => `await sleep(1600);
  const txt=(x)=>x.textContent.replace(/\\s+/g,'');
  const tr=[...document.querySelectorAll('.ant-table-tbody tr')].find(r=>r.textContent.includes(${JSON.stringify(rid)}));
  if(tr) tr.click(); await sleep(1100);
  const pick=(label)=>[...document.querySelectorAll('button')].find(x=>txt(x)===label);
  ${act === 'submit' ? `const b=[...document.querySelectorAll('button')].find(x=>txt(x).includes('提交复核')); if(b&&!b.disabled){b.click();await sleep(1000);}` : ''}
  ${act === 'approve' ? `const a=pick('通过'); if(!a) return 'ERR:未见通过按钮'; if(a.disabled) return 'ERR:通过按钮禁用（席位无审批权或未登录成复核人）';
     a.click(); await sleep(1200);
     const p=[...document.querySelectorAll('button')].find(x=>txt(x).includes('发布')); if(!p) return 'ERR:未见发布按钮'; if(p.disabled) return 'ERR:发布按钮禁用（状态未到 approved）';
     p.click(); await sleep(1200);` : ''}
  const err=[...document.querySelectorAll('.ant-message-notice')].map(e=>e.textContent).join('');
  return [${JSON.stringify(rid)},'席位='+(localStorage.getItem('yansin.actor')??'-').replace(/"/g,''),
    '提示'+(err?('「'+err+'」'):'无'),
    '按钮='+['提交复核','通过','驳回','发布'].map((l)=>{const b=[...document.querySelectorAll('button')].find((x)=>txt(x).includes(l));return l+(b?(b.disabled?'=禁用':'=可点'):'=无');}).join(',')].join(' | ')`;

const preArchived = `await sleep(1300);
  const tab=[...document.querySelectorAll('.ant-segmented-item')].find((x)=>x.textContent.includes('已归档'));
  const tabRadio=tab?.querySelector('input'); if(tabRadio) tabRadio.click(); else tab.click();
  await sleep(1400);
  const tr=[...document.querySelectorAll('.ant-table-tbody tr')].filter((r)=>r.textContent.trim());
  return '已归档 '+tr.length+' 行 · '+tr.map((r)=>{const b=[...r.querySelectorAll('button')].find((x)=>x.textContent.includes('离线分析'));return b?(b.disabled?'禁用':'可点'):'无按钮';}).join(',')`;

/* ── 工具 ─────────────────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(EV_DIR, { recursive: true });
/** 按用例暂存：ev() 写当前用例那一桶，跑完一个用例落一份 md */
const CASE_LOG = new Map();
let currentCase = null;
const ev = (line) => {
  if (!CASE_LOG.has(currentCase)) CASE_LOG.set(currentCase, []);
  CASE_LOG.get(currentCase).push(line);
  console.log(line);
};

/** pre 传「未包裹的函数体」；role 非空时先走一遍登录页占席，再执行本步动作。
 *  file:// 那两屏没有登录态可谈（导出件是静态 HTML），role 传 null。 */
const shot = ({ out, url, role = '分析师', pre, wait = 0, settle = 1500, h = 900, w = 1440 }) =>
  new Promise((resolve) => {
    const args = [SHOT, '--url=' + url, '--out=' + join(OUT_DIR, out), `--w=${w}`, `--h=${h}`, `--settle=${settle}`, `--wait=${wait}`];
    const body = pre ?? (role ? '' : null);
    const injected = body === null ? null : guard(`${role ? LOGIN(role) : ''}${body}`);
    if (injected) {
      /* 各片段拼进同一个函数体，重名 const 会让整段注入静默失败（只留下 EVAL: Uncaught），先本地过一遍语法 */
      try { new Function(injected); } catch (e) { ev(`  ⚠️ 注入片段语法错误 ${out} — ${e.message}`); }
      args.push('--pre=' + injected);
    }
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    p.on('exit', (code) => {
      mkdirSync(join(OUT_DIR, '_shotlog'), { recursive: true });
      writeFileSync(join(OUT_DIR, '_shotlog', out + '.log'), `code=${code}\n${log}`);
      /* 注入片段一并落盘：EVAL 报 Uncaught 时可以直接 node --check 这个文件定位语法冲突 */
      if (injected) writeFileSync(join(OUT_DIR, '_shotlog', out + '.pre.js'), injected);
      const m = log.match(/^PRE: (.*)$/m);
      const raw = m ? m[1] : null;
      let val = raw;
      try { val = JSON.parse(raw); } catch { /* 原样返回 */ }
      if (code !== 0) ev(`⚠️ 截图失败 ${out}\n${log.slice(0, 400)}`);
      else if (!existsSync(join(OUT_DIR, out))) ev(`⚠️ 未落盘 ${out}`);
      else if (typeof val === 'string' && val.startsWith('ERR:')) ev(`⚠️ 注入报错 ${out} — ${val}`);
      resolve({ id: typeof val === 'string' ? val : raw, log });
    });
  });

const api = {
  post: async (p, body) => {
    const r = await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    return { code: r.status, data: await r.json().catch(() => null) };
  },
  get: async (p) => (await fetch(B + p)).json(),
};
const waitDone = async (id, ms = 60_000) => {
  const t0 = Date.now();
  for (;;) {
    const s = ((await api.get('/sessions')).find((x) => x.id === id) ?? {});
    if (s.offline) return s;
    if (Date.now() - t0 > ms) throw new Error(`${id} 批分析超时未完成`);
    await sleep(700);
  }
};

/* ── 单步执行 ─────────────────────────────────────────────────────────────── */
async function runCase(key) {
  const c = CASES[key];
  currentCase = key;
  const steps = stepFilter.length ? c.steps.filter((s) => stepFilter.includes(s)) : c.steps;
  ev(`\n## ${key} · ${c.label}`);

  if (!c.noReset && steps.some((s) => s !== 'archived')) await api.post('/demo/reset', {});

  let id = null;
  let result = null;
  /** 结果页各屏都要求批分析已完成；没拍「分析进行中」这一屏时（--steps 局部跑），起批改由 API 触发 */
  const ensureResult = async () => {
    if (result) return result;
    if (!id) return null;
    const s = ((await api.get('/sessions')).find((x) => x.id === id) ?? {});
    if (!s.offline && !s.offline_job) {
      await api.post(`/sessions/${id}/analyze-offline`, {});
      ev('  （本步之前没拍「分析进行中」，起批由 API 触发，链路与点按钮同一条）');
    }
    result = (await waitDone(id)).offline;
    return result;
  };
  /** 结果页各屏都挂在 /offline/<会话号> 下，任务台两屏挂在 /t/workstation */
  const RESULT_STEPS = ['result_top', 'slices', 'ext_slice', 'modality', 'anomalies', 'attribution', 'impacts', 'transcript', 'suppressed'];
  const take = async (step, extra = {}) => {
    const url = extra.url ?? (RESULT_STEPS.includes(step) ? `${APP}/t/workstation/offline/${id}` : `${APP}/t/workstation`);
    const out = `${key}_${String(steps.indexOf(step) + 1).padStart(2, '0')}_${step}.png`;
    const r = await shot({ out, url, h: H[step] ?? 900, ...extra });
    ev(`  📷 ${out}`);
    return r;
  };

  for (const step of steps) {
    switch (step) {
      case 'login_gate': {
        await take(step, { role: null, pre: null });
        break;
      }
      case 'register': {
        const r = await take(step, { pre: preRegister(c), settle: 400 });
        ev(`  登记：${r.id}`);
        break;
      }
      case 'created': {
        const r = await take(step, { pre: preCreate(c), settle: 400 });
        id = (r.id ?? '').replace(/^"|"$/g, '');
        if (!/^SES-/.test(id)) ev(`  ⚠️ 没拿到会话号，返回：${r.id}`);
        else ev(`  会话号 ${id}`);
        break;
      }
      case 'progress': {
        if (!id) break;
        await take(step, { pre: preAnalyze(id), wait: 900, settle: 600 });
        const job = ((await api.get('/sessions')).find((x) => x.id === id) ?? {}).offline_job;
        ev(`  进度：${job ? `${job.progress}% · 当前段「${job.stage}」· 总段数 ${job.steps.length}` : '已跑完'}`);
        result = (await waitDone(id)).offline;
        ev(`  完成：素材 ${result.assets.length} 份 / 切片 ${result.slices.length} 片 / 上报 ${result.anomalies.length} 条（扩展 ${result.anomalies.filter((a) => a.cap_note).length} 条）/ 裁撤 ${result.suppressed.length} 条 / 可用模态 ${result.modality_available.length}/6 / 报告 ${result.report_id}`);
        break;
      }
      case 'n1_gate': {
        await take(step, { pre: preNoConsent(c), settle: 500 });
        const r = await api.post('/sessions', { subject_code: c.fill.subject, scene: c.fill.scene, form: 'B', source: 'imported', consent_doc: '   ', assets: [] });
        ev(`  服务端：HTTP ${r.code} · error=${r.data?.error} · ${r.data?.message}`);
        const ok = await api.post('/sessions', { subject_code: c.fill.subject, scene: c.fill.scene, form: 'B', source: 'imported', consent_doc: 'SQ-2026-N1', assets: [{ id: 'AS-01', name: TK.V1.name, size_bytes: 3145728, duration_seconds: 156, kind: 'video' }] });
        ev(`  对照组（补上文书号）：HTTP ${ok.code} · ${ok.data?.id ?? ok.data?.message}`);
        break;
      }
      case 'n2_gate': {
        await take(step, { pre: preNoAsset(c), settle: 500 });
        const made = await api.post('/sessions', { subject_code: c.fill.subject, scene: c.fill.scene, form: 'B', source: 'imported', consent_doc: c.fill.consent, assets: [] });
        const sid = made.data?.id;
        const r = await api.post(`/sessions/${sid}/analyze-offline`, {});
        ev(`  空素材会话 ${sid}：起批 HTTP ${r.code} · ${r.data?.message}`);
        break;
      }
      case 'n3_conflict': {
        const first = await api.post(`/sessions/${id}/analyze-offline`, {});
        const again = await api.post(`/sessions/${id}/analyze-offline`, {});
        ev(`  第一次起批 HTTP ${first.code} · 进行中重复起批 HTTP ${again.code}（error=${again.data?.error}）· ${again.data?.message}`);
        await take(step, { settle: 700 });
        const done = await waitDone(id);
        ev(`  完成后切片 ${done.offline.slices.length} 片 · 段数 ${done.offline_job ? '仍在跑' : '已收敛'}（重复起批没有产生第二份结果）`);
        break;
      }
      case 'n9_matrix': {
        const res = await ensureResult();
        if (!res) break;
        const ext = res.slices.filter((x) => x.role === 'extension');
        const capEvents = res.anomalies.filter((a) => a.cap_note);
        ev(`  ① 结果页：扩展素材 ${ext.length} 份都带「结论上限」说明=${ext.every((x) => !!x.cap_note)} · 封顶事件 ${capEvents.length} 条（候选规则层为空=${capEvents.every((a) => a.attribution.candidate_rules.length === 0)}、最高 ALERT=${capEvents.every((a) => a.severity !== 'ESCALATED')}）`);
        const csv = await api.post(`/sessions/${id}/analyze-offline/csv`, {});
        const lines = String(csv.data.csv).split('\n');
        const extLines = lines.filter((l) => l.includes('trend_only'));
        ev(`  ② CSV：${csv.data.rows} 行，其中 outcome=trend_only ${extLines.length} 行 · 表头含 asset 列=${lines[0].includes('asset')}`);
        const rep = ((await api.get('/reports')) ?? []).find((x) => x.id === res.report_id);
        const repHit = rep.sections.filter((x) => x.text.includes('趋势') || x.text.includes('封顶')).map((x) => x.key);
        ev(`  ③ 报告：提到扩展信号封顶口径的章节=${repHit.join('·') || '无'}`);
        const html = await api.post(`/reports/${res.report_id}/export`, { mode: 'file' });
        ev(`  ④ 导出件：含「趋势型条目」=${html.data.html.includes('趋势型条目')} · 含「不出心理归因/不含心理归因」=${/不含心理归因|不出心理归因/.test(html.data.html)} · 水印「${html.data.watermark}」`);
        await take(step, { url: `${APP}/t/workstation/reports`, pre: preReport(res.report_id, 'select'), settle: 900 });
        break;
      }
      case 'archived': {
        await take(step, { pre: preArchived });
        break;
      }
      case 'result_top': {
        await ensureResult();
        if (!id) break;
        await take(step, { settle: 1800 });
        break;
      }
      case 'ext_slice': {
        await ensureResult();
        if (!id) break;
        const ext = result.slices.find((x) => x.role === 'extension');
        await take(step, { pre: preScrollCard(ext ? ext.asset_name.slice(0, 6) : 'E') });
        break;
      }
      case 'slices': {
        await ensureResult();
        if (!id) break;
        await take(step, { pre: preScrollCard(result.slices[0].asset_name.slice(0, 6)) });
        break;
      }
      case 'modality': {
        await ensureResult();
        if (!id) break;
        await take(step, { pre: preScrollH4('六类信号的可用性') });
        break;
      }
      case 'anomalies': {
        await ensureResult();
        if (!id) break;
        await take(step, { pre: preScrollH4('异常事件') });
        break;
      }
      case 'attribution': {
        await ensureResult();
        if (!id) break;
        const pick = result.anomalies.find((a) => a.severity === 'ESCALATED')?.id ?? result.anomalies[0]?.id ?? '';
        await take(step, { pre: preOpenAttribution(pick) });
        ev(`  归因抽屉事件 ${pick}`);
        break;
      }
      case 'impacts': {
        await ensureResult();
        if (!id) break;
        await take(step, { pre: preScrollH4('话题切分与语义影响值') });
        break;
      }
      case 'transcript': {
        await ensureResult();
        if (!id) break;
        await take(step, { pre: preScrollH4('转写原文与分角色置信度') });
        break;
      }
      case 'suppressed': {
        await ensureResult();
        if (!id) break;
        await take(step, { pre: preScrollH4('裁撤条目') });
        break;
      }
      case 'report_draft': {
        await ensureResult();
        if (!result) break;
        const rid = result.report_id;
        await take(step, { url: `${APP}/t/workstation/reports`, pre: preReport(rid, 'select'), settle: 900 });
        break;
      }
      case 'export_draft': {
        if (!result) break;
        const e = await api.post(`/reports/${result.report_id}/export`, { mode: 'file' });
        writeFileSync(join(OUT_DIR, `${key}_导出_草稿未发布.html`), e.data.html);
        ev(`  草稿导出：水印「${e.data.watermark}」· 审计 seq=${e.data.audit_seq} · encrypted=${e.data.encrypted}`);
        await take(step, { url: `file://${join(OUT_DIR, `${key}_导出_草稿未发布.html`)}`, role: null, settle: 900 });
        break;
      }
      case 'submit': {
        if (!result) break;
        await take(step, { url: `${APP}/t/workstation/reports`, pre: preReport(result.report_id, 'submit'), settle: 900 });
        const r0 = ((await api.get('/reports')) ?? []).find((x) => x.id === result.report_id);
        ev(`  提交后状态 ${r0?.status} · 复核人 ${r0?.reviewer}`);
        break;
      }
      case 'approve_publish': {
        if (!result) break;
        const ap = await take(step, { url: `${APP}/t/workstation/reports`, pre: preReport(result.report_id, 'approve'), role: '复核人', settle: 900 });
        ev(`  审批现场回显 ${ap.id}`);
        const r = ((await api.get('/reports')) ?? []).find((x) => x.id === result.report_id);
        ev(`  审批后状态 ${r?.status} · 复核人 ${r?.reviewer} · 发布时间 ${r?.published_at}`);
        break;
      }
      case 'export_published': {
        if (!result) break;
        const e = await api.post(`/reports/${result.report_id}/export`, { mode: 'file' });
        writeFileSync(join(OUT_DIR, `${key}_导出_已发布.html`), e.data.html);
        const csv = await api.post(`/sessions/${id}/analyze-offline/csv`, {});
        const capRows = String(csv.data.csv).split('\n').filter((l) => l.includes('trend_only')).length;
        ev(`  发布件导出：水印「${e.data.watermark ?? '无'}」· 含附表A=${e.data.html.includes('附表 A')} · 含「离线导入 · 非实时」=${e.data.html.includes('离线导入 · 非实时')}`);
        ev(`  CSV 台账 ${csv.data.rows} 行 · 其中标 trend_only（不出归因）${capRows} 行 · 含 asset 列=${String(csv.data.csv).includes('asset')}`);
        const h3 = join(OUT_DIR, `${key}_导出_已发布.html`);
        await take(step, {
          url: `file://${h3}`, role: null, settle: 900,
          pre: `await sleep(600);const n=[...document.querySelectorAll('h3')].find((x)=>x.textContent.includes('附表 A'));if(n)document.scrollingElement.scrollTop=n.offsetTop-8;return '附表 A'`,
        });
        break;
      }
    }
  }
}

const started = Date.now();
for (const key of Object.keys(CASES)) {
  if (only && !only.split(',').includes(key)) continue;
  CASE_LOG.clear();
  await runCase(key);
  /* 每个用例单独落一份，再汇总：这样 --only=C3 单跑不会把别的用例取证冲掉 */
  writeFileSync(join(EV_DIR, `${key}.md`), (CASE_LOG.get(key) ?? []).join('\n'));
}
const keys = readdirSync(EV_DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
writeFileSync(
  join(OUT_DIR, '取证记录.md'),
  `# 取证记录（实拍时自动生成）\n\n汇总时间 ${new Date().toLocaleString('zh-CN')} · 本轮耗时 ${Math.round((Date.now() - started) / 1000)}s · 覆盖用例 ${keys.join(' / ')}\n\n> 由 prototype-lite/scripts/testkit-shots.mjs 在 dev server 上跑真实链路时逐条打印，数字为服务端当场返回的实测值。单个用例的原始记录见同名 取证记录/<用例>.md。\n\n${keys.map((k) => `## ${k}\n\n\`\`\`\n${readFileSync(join(EV_DIR, `${k}.md`), 'utf8')}\n\`\`\`\n`).join('\n')}`,
);
console.log('\n全部用例结束，取证记录已写入 验证手册截图/取证记录.md');
