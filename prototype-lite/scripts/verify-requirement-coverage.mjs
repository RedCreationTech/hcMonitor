/* 招标条目覆盖自检：对照 7008111111 §28.02/28.05/28.07 与 R7/R8 红线，逐条断言原型行为。
 * 运行：npm run dev 后执行 node scripts/verify-requirement-coverage.mjs（约 70s，12x 加速回放） */
import WebSocket from 'ws';

const B = 'http://127.0.0.1:5185/v1';
const post = async (p, body) => {
  const r = await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { code: r.status, data: await r.json().catch(() => null) };
};
const get = async (p) => {
  const r = await fetch(B + p);
  return { code: r.status, data: await r.json().catch(() => null) };
};
const SID = 'SES-2026-1018-A03';

function listen(channels, seconds) {
  return new Promise((resolve) => {
    const out = {};
    channels.forEach((c) => (out[c] = { anomalies: [], impacts: [], turns: [] }));
    const socks = channels.map((c) => {
      const ws = new WebSocket(`ws://127.0.0.1:5185/v1/analysis/stream?channel=${c}`);
      ws.on('message', (buf) => {
        const m = JSON.parse(buf.toString());
        if (m.event === 'anomaly') out[c].anomalies.push(m);
        if (m.event === 'impact') out[c].impacts.push(m);
        if (m.event === 'dialogue') out[c].turns.push(m);
      });
      return ws;
    });
    setTimeout(() => {
      socks.forEach((s) => s.close());
      resolve(out);
    }, seconds * 1000);
  });
}
const open = async (form = 'A') => {
  await post('/demo/reset', {});
  await post('/demo/form', { form });
  await post(`/sessions/${SID}/open`, {});
  await post('/demo/speed', { speed: 12 });
};

const restoreSeed = async () => {
  for (const [id, st] of [['IN-SEM','ok'],['IN-FAC','degraded'],['IN-POS','ok'],['IN-HND','ok'],['IN-RPP','ok'],['IN-DIA','ok']])
    await post(`/integrations/${id}/status`, { status: st, actor: 'Admin' });
};

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

// A. 全模态 + R7
console.log('=== A. 全模态（150s @12x）+ R7 通道对照 ===');
await open();
const a = await listen(['workstation', 'field'], 15);
a.workstation.anomalies.forEach((x) =>
  console.log(`   ${x.id} ${x.modality.padEnd(9)} ${x.severity.padEnd(9)} conf=${x.confidence} obs=${x.attribution.observation.length} ${x.type}`),
);
const leaked = a.field.anomalies.filter((x) => 'confidence' in x && x.confidence !== 0);
const leakAttr = a.field.anomalies.filter((x) => x.attribution?.observation?.length);
check('现场通道 7 条异常全部到达', a.field.anomalies.length === 7, `实收 ${a.field.anomalies.length}`);
check('R7：现场通道不泄漏归因链', leakAttr.length === 0 && leaked.length === 0);
check('R7：现场通道不下发逐句原文', a.field.turns.length === 0);
check('R7：现场影响值只留单条数值', a.field.impacts.every((i) => !i.dims && !i.rationale_text && !i.boundary_evidence));
check('28.07 生理指标异常已触发', a.workstation.anomalies.some((x) => x.modality === 'physio'));
check('28.07 六类异常全覆盖', ['voice', 'semantic', 'face', 'pose', 'hand', 'physio'].every((m) => a.workstation.anomalies.some((x) => x.modality === m)),
  a.workstation.anomalies.map((x) => x.modality).join(','));
check('28.02 四个语义话题全部下发', a.workstation.impacts.length === 4);
check('28.02 话题带边界判定依据', a.workstation.impacts.every((i) => !!i.boundary_evidence));
check('28.02 分角色置信度已下发', a.workstation.turns.every((t) => typeof t.diar_confidence === 'number'));

// B. 仅语音单模态
console.log('\n=== B. 28.05 单模态输入：关停语义/表情/姿态/手部/生理 ===');
await open();
for (const id of ['IN-SEM', 'IN-FAC', 'IN-POS', 'IN-HND', 'IN-RPP']) await post(`/integrations/${id}/status`, { status: 'off', actor: 'Admin' });
const b = await listen(['workstation'], 15);
check('仅语音：只剩 voice 异常', b.workstation.anomalies.every((x) => x.modality === 'voice') && b.workstation.anomalies.length === 1,
  b.workstation.anomalies.map((x) => `${x.id}/${x.modality}`).join(' '));
check('仅语音：语义关停后不出话题与影响值', b.workstation.impacts.length === 0);
check('仅语音：ASR 转写仍出字（属语音通道）', b.workstation.turns.length > 0);
check('观察层跨模态缺失被显性标注', b.workstation.anomalies[0].attribution.observation.some((o) => o.text.includes('通道关停')));

// C. 分角色降级
console.log('\n=== C. 28.02-a 说话人分离三态 ===');
await restoreSeed();
await open();
await post('/integrations/IN-DIA/status', { status: 'off', actor: 'Admin' });
const c1 = await listen(['workstation'], 4);
check('off → diar_confidence 为 null', c1.workstation.turns.every((t) => t.diar_confidence === null));
await open();
await post('/integrations/IN-DIA/status', { status: 'degraded', actor: 'Admin' });
const c2 = await listen(['workstation'], 4);
check('degraded → 置信度按比例压低', c2.workstation.turns.every((t) => t.diar_confidence !== null && t.diar_confidence < 0.8));
await open();
await post('/integrations/IN-DIA/status', { status: 'ok', actor: 'Admin' });
const c3 = await listen(['workstation'], 4);
check('ok → 置信度恢复真值', c3.workstation.turns.some((t) => t.diar_confidence > 0.9));

// D. 规则热更新
console.log('\n=== D. S8 规则库热更新对实测的即时影响 ===');
await restoreSeed();
await open();
await post('/rules/R-PSY-19/toggle', { enabled: false, actor: 'Admin' });
const d = await listen(['workstation'], 15);
check('停用 R-PSY-19 → 该条命中移出候选层', !d.workstation.anomalies.some((x) => x.attribution.candidate_rules.some((r) => r.rule_id === 'R-PSY-19' && r.hit)));
const ev4 = d.workstation.anomalies.find((x) => x.id === 'EV-004');
check('生理异常因仍有 R-PSY-03 命中而降权保留', ev4 && ev4.confidence < 0.56, `conf=${ev4?.confidence}`);
await open();
await post('/rules/R-PSY-19/toggle', { enabled: false, actor: 'Admin' });
await post('/rules/R-PSY-03/toggle', { enabled: false, actor: 'Admin' });
const d2 = await listen(['workstation'], 15);
check('两条命中全停用 → 该异常整体不上报', !d2.workstation.anomalies.some((x) => x.id === 'EV-004'));
await post('/rules/R-PSY-19/toggle', { enabled: true, actor: 'Admin' });
await post('/rules/R-PSY-03/toggle', { enabled: true, actor: 'Admin' });

// E. 数据台账与导出留痕（R6）
console.log('\n=== E. R6 数据台账：行对齐 / 文献可追溯 / 导出入链 ===');
await open();
const e1 = await listen(['workstation'], 15);
const led = (await get('/admin/ledger')).data;
check('台账行数与服务端已上报异常数一致', led.rows.length === e1.workstation.anomalies.length && led.rows.length === 7,
  `台账 ${led.rows.length} / 通道 ${e1.workstation.anomalies.length}`);
check('每条事件都带观察层证据（含物理量与单位）', led.rows.every((r) => r.observations.length > 0));
check('每条事件都能连到文献字段', led.rows.every((r) => r.literature.length > 0 && r.literature.every((l) => !!l.ref)));
check('每条检测事件在审计链上有落点', led.rows.every((r) => r.audit !== null),
  `缺失 ${led.rows.filter((r) => !r.audit).length} 条`);
check('未登记进规则库的候选规则被台账显性标出', led.rows.some((r) => r.literature.some((l) => !l.in_library)),
  `未登记 ${[...new Set(led.rows.flatMap((r) => r.literature.filter((l) => !l.in_library).map((l) => l.rule_id)))].join(',')}`);
check('占位文献规则计数为 1（R-PSY-22）', led.summary.rules.placeholder === 1, `实为 ${led.summary.rules.placeholder}`);
const ex = await post('/admin/ledger/export', { scope: 'events', actor: '分析师 W-02' });
check('导出成功且首字节为 BOM（Excel 中文不乱码）', ex.code === 200 && ex.data.csv.charCodeAt(0) === 0xfeff,
  `seq=${ex.data?.audit_seq}`);
const led2 = (await get('/admin/ledger')).data;
check('导出计数 +1 且哈希链复算仍通过', led2.summary.exports === led.summary.exports + 1 && led2.summary.audit.chain_ok,
  `exports ${led.summary.exports}→${led2.summary.exports}`);
const denied = await post('/admin/ledger/export', { scope: 'events', actor: '采集员 C-04' });
check('采集员角色导出被 403 拒绝', denied.code === 403, denied.data?.message ?? '');

// F. 多信号源上传：每份素材都参与分析、扩展信号封顶、报告逐份列示
console.log('\n=== F. 多信号源（视频+音频+近红外+毫米波）离线批分析 ===');
await post('/demo/reset', {});
const F_ASSETS = [
  { name: 'CAM03_multi_45min.mp4', size_bytes: 1873000000, duration_seconds: 152, kind: 'video' },
  { name: 'MIC01_48k.wav', size_bytes: 43600000, duration_seconds: 152, kind: 'audio' },
  { name: 'nir_hbo_152s.csv', size_bytes: 8200, duration_seconds: 152, kind: 'nir' },
  { name: 'mmwave_resp_152s.csv', size_bytes: 6100, duration_seconds: 152, kind: 'mmwave' },
];
const fNew = await post('/sessions', {
  subject_code: '对象 M-200', scene: '多信号源离线复盘 · 谈室 03', form: 'A',
  consent_doc: 'SQ-2026-200（含录像二次使用授权）', source: 'imported', assets: F_ASSETS,
});
const FID = fNew.data?.id;
check('四路素材（音视频为主、近红外/毫米波为扩展）登记为一个离线会话', fNew.code === 200 && fNew.data.assets.length === 4);
const fRun = await post(`/sessions/${FID}/analyze-offline`, {});
check('起批即返回分阶段进度与切片数（过程在屏上可见）', fRun.code === 200 && fRun.data.stages >= 12 && fRun.data.slices === 4,
  `stages=${fRun.data?.stages}/slices=${fRun.data?.slices}`);
const fDup = await post(`/sessions/${FID}/analyze-offline`, {});
check('批分析进行中重复起批被 409 拦下（不并发生成第二份报告）', fDup.code === 409 && fDup.data.error === 'ANALYZING', fDup.data?.message ?? '');
const waitOffline = async (id) => {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 700));
    const s = (await get('/sessions')).data.find((x) => x.id === id);
    if (s?.offline) return s;
  }
  return null;
};
const fS = await waitOffline(FID);
const R = fS?.offline;
check('四份素材各产出一片切片（上传后所有文件都参与分析）', !!R && R.slices.length === 4 &&
  F_ASSETS.every((a) => R.slices.some((sl) => sl.asset_name === a.name)));
check('每片切片按素材类型标可用/不可用模态，缺的那路不产出 0 值', !!R && R.slices.every((sl) => sl.modality_available.length + sl.modality_unavailable.length === 6));
check('每片切片带解析步骤（解析过程按素材分段）', !!R && R.slices.every((sl) => sl.steps.length >= 4));
const slAudio = R && R.slices.find((x) => x.kind === 'audio');
check('音频素材独立承载事件（不是只有视频在出结果）', !!slAudio && slAudio.event_ids.some((i) => i.startsWith('EV-')));
const extSlices = R ? R.slices.filter((sl) => sl.role === 'extension') : [];
const extIds = new Set(extSlices.map((sl) => sl.event_ids).flat());
check('扩展信号各出一条趋势型条目，且带封顶说明与趋势曲线', extSlices.length === 2 && extSlices.every((sl) => sl.cap_note && sl.trend?.metrics.length === 3));
const extEvents = R ? R.anomalies.filter((a) => extIds.has(a.id)) : [];
const mainEvents = R ? R.anomalies.filter((a) => !extIds.has(a.id)) : [];
check('扩展信号事件的候选规则层恒为空（自定义口径 C 级，不做心理归因）', extEvents.length === 2 && extEvents.every((a) => a.attribution.candidate_rules.length === 0));
check('扩展信号事件最高只到 ALERT，不触发升级', extEvents.every((a) => a.severity !== 'ESCALATED'));
check('主信号四模态同窗仍可升级（封顶只作用于扩展信号）', mainEvents.some((a) => a.severity === 'ESCALATED'));
check('每条主信号事件标出承载素材（多文件可追溯是哪份给的证据）', mainEvents.every((a) => a.source_assets?.length >= 1));
check('结果层区分「归因条目 / 趋势条目」并回填会话灯色与模态集', !!fS && fS.status === 'review' && fS.peak_lamp === 'red' && R.modality_available.length === 6);

const fRep = (await get('/reports')).data.find((r) => r.session_id === FID);
check('离线报告章节含「二、素材切片与各自贡献」', !!fRep && fRep.sections.some((x) => x.title.startsWith('二、素材切片')));
check('报告逐份列示四个文件名（未提供的信号不以"检测正常"出现）',
  !!fRep && F_ASSETS.every((a) => fRep.sections.some((x) => x.text.includes(a.name))));
const fCsv = await post(`/sessions/${FID}/analyze-offline/csv`, {});
check('导出 CSV 含 asset 列，扩展信号行标 trend_only（不出归因）',
  fCsv.code === 200 && fCsv.data.csv.split('\n')[0].includes(',asset,') && fCsv.data.csv.includes('trend_only（不出归因）'));
const fExp = await post(`/reports/${fRep?.id}/export`, { mode: 'file' });
check('下载/打印的 HTML 含「附表 A · 素材切片一览」与「离线导入 · 非实时」口径',
  fExp.code === 200 && ['附表 A', '非实时', 'mmwave_resp_152s.csv'].every((k) => fExp.data.html.includes(k)));

// F2. 只有扩展信号时：脚本判定链整体裁撤，不许冒充成"检测正常"
console.log('\n=== F2. 仅扩展信号素材（无音视频输入） ===');
const gNew = await post('/sessions', {
  subject_code: '对象 M-201', scene: '仅近红外复盘 · 外勤单兵', form: 'D',
  consent_doc: 'SQ-2026-201', source: 'imported', assets: [F_ASSETS[2]],
});
await post(`/sessions/${gNew.data.id}/analyze-offline`, {});
const gS = await waitOffline(gNew.data.id);
check('无音视频输入时语义判定链逐条裁撤并给出现场可执行原因', !!gS && gS.offline.suppressed.length >= 10 &&
  gS.offline.suppressed[0].reason.includes('只登记了扩展信号素材'), `裁撤 ${gS?.offline.suppressed.length} 条`);
check('可用模态由素材决定：仅扩展信号时不进脚本链（modality_available 为空）', !!gS && gS.offline.modality_available.length === 0);
check('扩展信号仍独立出一条趋势条目并封顶', !!gS && gS.offline.anomalies.length === 1 && gS.offline.anomalies[0].cap_note && gS.offline.anomalies[0].severity !== 'ESCALATED');
const noAsset = await post('/sessions', { subject_code: '对象 M-202', scene: '空素材会话', form: 'A', consent_doc: 'SQ-2026-202', source: 'imported' });
const noRun = await post(`/sessions/${noAsset.data.id}/analyze-offline`, {});
check('未登记任何素材时起批被 422 拦下（分析没有输入就不出结果）', noRun.code === 422, noRun.data?.message ?? '');

// 恢复出厂
await open();
console.log(`\n结果：${fail === 0 ? '全部通过' : fail + ' 项未通过'}`);
process.exit(fail === 0 ? 0 : 1);
