/* 生成精简版验证测试包的采样序列文件（近红外 / 毫米波正例 + 三个边界件）。
 * 可重跑、结果逐字节一致：随机量用固定种子线性同余生成，不依赖 Math.random。
 * 用法：node scripts/gen-testkit-series.mjs   （产物写 public/testkit/）
 * 注意：本文件只决定"素材长什么样"；原型结果页上的生理趋势数值来自演示脚本，不来自这里。 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'testkit');

/** 固定种子 LCG：同一 seed 永远生成同一份序列，重跑不会让手册里写的行数与文件对不上 */
const rng = (seed) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
};

/** 唤醒度爬升：前 25% 当静息段，中段线性上行，尾段维持——清单里"基线→峰值→末段"的说法与之同形 */
const climb = (t, len) => Math.min(1, Math.max(0, (t - len * 0.25) / (len * 0.55)));

/** 时间列小数位随步长走：1Hz 写整数秒，10Hz/25Hz 写小数秒，别让 toFixed 把时基抹平 */
const timeCol = (t, step) => (step >= 1 ? String(Math.round(t)) : t.toFixed(step >= 0.1 ? 1 : 2));

const nir = (t, len, n) => [
  (0.082 + 0.148 * climb(t, len) + 0.011 * Math.sin(t / 6.2) + (0.004 - 0.008 * n())).toFixed(3),
  (-0.051 - 0.089 * climb(t, len) + 0.007 * Math.sin(t / 5.1) + (0.003 - 0.006 * n())).toFixed(3),
  (5.8 + 9.4 * Math.abs(Math.sin(t / 23)) + 2.1 * n()).toFixed(1),
];

const mmw = (t, len, n) => [
  (14.2 + 4.1 * climb(t, len) + 0.7 * Math.sin(t / 4.7) + 0.3 * n()).toFixed(1),
  (68.4 + 19.6 * climb(t, len) + 2.2 * Math.sin(t / 3.3) + 1.1 * n()).toFixed(1),
  (1.4 + 4.6 * climb(t, len) + 1.2 * Math.abs(Math.sin(t / 17)) + 0.6 * n()).toFixed(1),
];

const build = ({ file, sep, header, rows, step, length, seed, values, order }) => {
  const n = rng(seed);
  const lines = [header.join(sep)];
  for (let i = 0; i < rows; i++) {
    const t = +(i * step).toFixed(4);
    const v = values(t, length, n);
    // order='time_first' 首列是时基；'value_first' 故意把物理量放首列（边界件 X2）
    lines.push((order === 'time_first' ? [timeCol(t, step), ...v] : [...v, timeCol(t, step)]).join(sep));
  }
  writeFileSync(join(out, file), lines.join('\n') + '\n');
  const last = lines[lines.length - 1].split(sep);
  console.log(`${file}\t样本 ${rows} 行\t步长 ${step}s\t首列末值 ${order === 'time_first' ? last[0] : last[1]}`);
};

/* ── 扩展信号正例：四种采样率 × 两种分隔符，覆盖"读首列推时基"能读通的常见导出件 ── */
const nirSpec = { sep: ',', values: nir, order: 'time_first', length: 156 };
const mmwSpec = { sep: ',', values: mmw, order: 'time_first', length: 156 };

build({ ...nirSpec, file: 'E1_近红外_hbo_156s_1Hz.csv', rows: 157, step: 1, seed: 11, header: ['t_s', 'hbo_mmol_mm_L', 'hbr_mmol_mm_L', 'head_motion_pct'] });
build({ ...mmwSpec, file: 'E2_毫米波_resp_156s_1Hz.csv', rows: 157, step: 1, seed: 23, header: ['t_s', 'resp_bpm', 'hr_bpm', 'body_motion_mm'] });
build({ ...nirSpec, file: 'E3_近红外_hbo_156s_10Hz.csv', rows: 1561, step: 0.1, seed: 37, header: ['t_s', 'hbo_mmol_mm_L', 'hbr_mmol_mm_L', 'head_motion_pct'] });
build({ ...mmwSpec, file: 'E4_毫米波_resp_156s_25Hz.csv', rows: 3901, step: 0.04, seed: 53, header: ['t_s', 'resp_bpm', 'hr_bpm', 'body_motion_mm'] });
build({ ...nirSpec, sep: '\t', file: 'E5_近红外_hbo_156s_2Hz.tsv', rows: 79, step: 2, seed: 71, header: ['t_s', 'hbo_mmol_mm_L', 'hbr_mmol_mm_L', 'head_motion_pct'] });

/* ── 边界件：故意让这条路走不通，验证界面显性标注"时基未读出"，而不是硬编一个时长 ── */
build({ ...nirSpec, file: 'X2_边界_首列为物理量_无时间轴.csv', rows: 157, step: 1, seed: 97, order: 'value_first', header: ['hbo_mmol_mm_L', 'hbr_mmol_mm_L', 'head_motion_pct', 't_s'] });

{
  // 超过 probeSeries 的 4MB 上限：应整体不解析（时长与行数都读不出来）
  const n = rng(131);
  const lines = ['t_s,hbo_mmol_mm_L,spare_a,spare_b,spare_c'];
  for (let i = 0; i < 180000; i++) {
    lines.push(`${i},${(0.08 + 0.15 * climb(i, 180000) + 0.01 * n()).toFixed(3)},0.0011,0.0012,0.0013`);
  }
  writeFileSync(join(out, 'X3_边界_超4MB采样序列.csv'), lines.join('\n') + '\n');
  console.log(`X3_边界_超4MB采样序列.csv\t样本 180000 行\t大小约 ${(lines.join('\n').length / 1e6).toFixed(1)}MB`);
}

{
  const n = rng(151);
  const arr = Array.from({ length: 157 }, (_, i) => {
    const [hbo, hbr, hm] = nir(i, 156, n);
    return { t_s: i, hbo_mmol_mm_L: Number(hbo), hbr_mmol_mm_L: Number(hbr), head_motion_pct: Number(hm) };
  });
  writeFileSync(join(out, 'X4_边界_JSON采样序列.json'), JSON.stringify(arr, null, 1) + '\n');
  console.log(`X4_边界_JSON采样序列.json\t采样对象 ${arr.length} 个`);
}
