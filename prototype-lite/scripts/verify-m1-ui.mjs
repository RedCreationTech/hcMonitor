import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin = process.env.M1_UI_ORIGIN || 'http://127.0.0.1:55290';
const output = process.env.M1_UI_OUTPUT || '../docs/qa-m1/runtime/browser';
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errors = [], steps = [];
const context = async user => {
  const c = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true }); const p = await c.newPage(); p.on('pageerror', e => errors.push(e.message)); await p.goto(origin);
  await p.getByPlaceholder('W-02 / R-01 / C-04 / A-01').fill(user); await p.getByPlaceholder('请输入本地账号口令').fill('Browser-QA-Password-2026!'); await p.getByRole('button', { name: '登录工作台', exact: true }).click(); await p.getByText('访谈证据工作台 · M1', { exact: true }).waitFor(); return { c, p };
};
try {
  const { p, c } = await context('W-02');
  const bytes = Buffer.alloc(44 + 96000); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(96000, 40);
  await p.getByRole('button', { name: '新建导入', exact: true }).click(); const modal = p.getByRole('dialog');
  await modal.getByLabel('对象编号', { exact: true }).fill('BROWSER-SYNTHETIC'); await modal.getByLabel('场景', { exact: true }).fill('浏览器合成验证'); await modal.getByLabel('告知文书编号', { exact: true }).fill('QA-ONLY');
  for (const text of ['两名参与者均已授权采集及本次分析', '两名参与者均已授权指定专家查看与复核', '两名参与者均已授权报告编制与分发']) await modal.getByText(text, { exact: true }).click();
  await p.route('**/v1/uploads/*/complete', route => route.abort());
  await modal.locator('input[type=file]').setInputFiles({ name: 'browser.wav', mimeType: 'audio/wav', buffer: bytes }); await modal.getByRole('button', { name: '保存并上传', exact: true }).click();
  await modal.getByText('已接收的分块保留，原件未完整封存前不能分析。保留当前窗口可重试续传。', {exact:true}).waitFor();
  await p.unroute('**/v1/uploads/*/complete'); await p.reload();
  const task = p.getByRole('row').filter({hasText:'BROWSER-SYNTHETIC'}).last();
  await task.locator('input[type=file]').setInputFiles({ name: 'browser.wav', mimeType: 'audio/wav', buffer: bytes });
  await task.getByText('已封存', {exact:true}).waitFor(); await task.getByRole('button',{name:'证据工作区',exact:true}).click();
  await p.waitForURL(/\/offline\/SES-/); await p.getByRole('heading', {name:'证据工作区',exact:true}).waitFor();
  steps.push('上传失败显式保留→刷新重选同一原件→断点续传封存');
  const sessionUrl = p.url(), sid = sessionUrl.split('/').at(-1); steps.push('逐人用途→分块上传→预检封存→正确任务工作区');
  await p.getByRole('button', { name: '开始 / 重试分析', exact: true }).click(); await p.getByText('逐句转写与匿名角色校正', { exact: true }).waitFor(); await p.getByLabel('转写文字', { exact: true }).fill('浏览器人工校正文字'); await p.getByRole('button', { name: '保存修订', exact: true }).click();
  await p.getByText('以下算法结果来自旧修订，不能送审或发布；请完成重算和重新复核。', { exact: true }).waitFor(); await p.getByRole('button', { name: '按修订重算', exact: true }).click(); await p.getByRole('button', { name: '开始 / 重试分析', exact: true }).waitFor(); steps.push('转写修订→旧结果过时→新运行'); await p.screenshot({ path: output + '/evidence.png', fullPage: true });
  const reviewer = await context('R-01'); await reviewer.p.goto(sessionUrl); await reviewer.p.getByRole('button', { name: '查看与复核', exact: true }).click(); await reviewer.p.getByLabel('复核理由', { exact: true }).fill('浏览器合成证据，仅验流程，行为与解释分别弃权'); await reviewer.p.getByRole('button', { name: '保存分层决定', exact: true }).click();
  await p.getByRole('button', { name: '版本报告', exact: true }).click(); await p.getByRole('button', { name: '提交独立批准', exact: true }).click(); await p.getByText('完整冻结稿（含证据、复核和方法附件）',{exact:true}).waitFor(); await reviewer.p.goto(origin + '/t/workstation/reports?session=' + sid); await reviewer.p.getByRole('button', { name: '批准此内容版本', exact: true }).click(); await reviewer.p.getByRole('button', { name: '发布并授予版本权限', exact: true }).click();
  const publish = reviewer.p.getByRole('dialog'); await publish.getByText('下载', { exact: true }).click(); await publish.getByText('打印', { exact: true }).click(); await publish.getByRole('button', { name: /确.*定/ }).click(); await reviewer.p.getByText('指定版本的阅读、下载与打印', { exact: true }).waitFor(); steps.push('独立分层复核→送审→异人批准→版本授权发布');
  const reader = await context('READ-01'); await reader.p.goto(origin + '/t/workstation/reports'); await reader.p.getByRole('button', { name: '核验本次阅读', exact: true }).click(); await reader.p.getByText('附录：来源与逐条复核',{exact:true}).waitFor(); assert.equal(await reader.p.getByText('修订与审批流水',{exact:true}).count(),0); const downloadPromise = reader.p.waitForEvent('download'); await reader.p.getByRole('button', { name: '下载 PDF', exact: true }).click(); const download = await downloadPromise; await download.saveAs(output + '/browser-report.pdf'); assert((await fs.stat(output + '/browser-report.pdf')).size > 1000); await reader.p.screenshot({ path: output + '/report.png', fullPage: true }); steps.push('阅读者仅见获授权版本→核验阅读→领取真实PDF');
  const admin = await context('A-01'); await admin.p.goto(origin + '/t/workstation/governance'); await admin.p.getByPlaceholder('用途限制或解除理由（必填）').fill('浏览器复测撤回用途'); await admin.p.getByRole('row').filter({ hasText: sid }).getByRole('button', { name: '立即限制所有处理与领取', exact: true }).click(); await reader.p.getByText('当前范围没有可见报告；分析成功后自动起草，阅读者仅能看到获授权版本', { exact: true }).waitFor(); assert.equal((await c.request.get(origin + `/v1/sessions/${sid}/assets/AS-FAKE/media`)).status(), 403); steps.push('管理员用途限制→已登录阅读者报告消失→旧资源接口拒绝');
  await p.route('**/v1/auth/logout',route=>route.abort()); await p.getByRole('button', { name: '退出占席', exact: true }).click(); await p.getByRole('button', { name: '登录工作台', exact: true }).waitFor(); await p.reload(); await p.getByRole('button', { name: '登录工作台', exact: true }).waitFor(); await p.unroute('**/v1/auth/logout');
  await p.getByPlaceholder('W-02 / R-01 / C-04 / A-01').fill('W-02'); await p.getByPlaceholder('请输入本地账号口令').fill('Browser-QA-Password-2026!'); await p.getByRole('button',{name:'登录工作台',exact:true}).click(); await p.getByRole('button',{name:'退出占席',exact:true}).click(); await p.getByRole('button',{name:'登录工作台',exact:true}).waitFor(); assert.equal((await c.request.get(origin + '/v1/state')).status(), 401); steps.push('断网退出清空界面→重载不恢复→联网撤销旧会话→正常登出401'); assert.deepEqual(errors, []);
  await fs.writeFile(output + '/result.json', JSON.stringify({ passed: true, engine: 'explicitly synthetic UI fixture; real inference separately tested', steps, consoleErrors: errors }, null, 2)); console.log(JSON.stringify({ passed: true, steps: steps.length, output }));
} catch (e) {
  const pages = browser.contexts().flatMap(c => c.pages()); for (let i = 0; i < pages.length; i++) { await pages[i].screenshot({ path: output + '/failure-' + i + '.png', fullPage: true }).catch(() => {}); await fs.writeFile(output + '/failure-' + i + '.txt', await pages[i].locator('body').innerText().catch(() => '')); }
  await fs.writeFile(output + '/failure.json', JSON.stringify({ error: e.stack, steps, errors }, null, 2)); throw e;
} finally { await browser.close(); }
