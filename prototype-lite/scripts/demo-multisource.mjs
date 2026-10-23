/* 多信号源演示数据准备：用 实测素材 里的真实文件名登记四路素材并起批。
 * 用法：npm run dev 后执行 node scripts/demo-multisource.mjs —— 打印会话号，浏览器直接打开结果页。
 *      加 --no-wait 只起批不等待，用于实拍「分析进行中」的逐素材进度画面。 */
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const B = 'http://127.0.0.1:5185/v1';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const size = (p) => statSync(join(root, 'public/demo', p)).size;

const FILES = [
  { name: '询问谈话_录像样例_156s.mp4', kind: 'video', duration_seconds: 156 },
  { name: '谈话录音_音频样例_156s.m4a', kind: 'audio', duration_seconds: 156 },
  { name: 'nir_hbo_152s.csv', kind: 'nir', duration_seconds: 152 },
  { name: 'mmwave_resp_152s.csv', kind: 'mmwave', duration_seconds: 152 },
];

const post = async (p, body) => {
  const r = await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${p} → ${r.status} ${d?.message ?? ''}`);
  return d;
};
const get = async (p) => (await fetch(B + p)).json();

const s = await post('/sessions', {
  subject_code: '对象 M-118',
  scene: '多信号源离线复盘 · 谈话室 03',
  form: 'A',
  consent_doc: 'SQ-2026-118（含录像二次使用授权）',
  source: 'imported',
  assets: FILES.map((f) => ({ ...f, size_bytes: size(f.name) })),
});
const run = await post(`/sessions/${s.id}/analyze-offline`, {});
console.log(`已起批 ${s.id}：${run.assets.length} 份素材 / ${run.slices} 片切片 / ${run.stages} 段进度`);

if (process.argv.includes('--no-wait')) {
  console.log(`结果页 http://127.0.0.1:5185/t/workstation/offline/${s.id}`);
  process.exit(0);
}

let done = null;
for (let i = 0; i < 60 && !done; i++) {
  await new Promise((r) => setTimeout(r, 700));
  done = ((await get('/sessions')).find((x) => x.id === s.id) ?? {}).offline ?? null;
}
if (!done) throw new Error('批分析超时未完成');
console.log(`完成：上报 ${done.anomalies.length} 条（扩展信号 ${done.anomalies.filter((a) => a.cap_note).length} 条只到趋势层）/ 裁撤 ${done.suppressed.length} 条 / 峰值灯 ${done.anomalies.some((a) => a.severity === 'ESCALATED') ? 'red' : 'orange'}`);
console.log(`报告 ${done.report_id} · 结果页 http://127.0.0.1:5185/t/workstation/offline/${s.id}`);
