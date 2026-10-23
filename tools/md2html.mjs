/* 文档双读者用的最小 md→html 转换：只覆盖 01/02/04/05/06/07 实际用到的语法
 * （# ## ###、---、表格、无序列表、**粗体**、`代码`、[链接](x)、![题注](图)、普通段落）。
 * 用法：node tools/md2html.mjs 06_多信号源上传与硬件接入说明.md */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const src = process.argv[2];
if (!src) {
  console.error('用法：node tools/md2html.mjs <文件.md>');
  process.exit(2);
}
const css = `:root { --line:#dfe3ea; --ink:#1c2330; --muted:#63708a; --bg:#fff; --accent:#0b57d0; }
* { box-sizing:border-box }
body { margin:0; padding:40px 24px 80px; background:#f5f6f8; color:var(--ink);
  font:15px/1.7 -apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }
main { max-width:1360px; margin:0 auto; background:var(--bg); padding:44px 48px 64px;
  border:1px solid var(--line); border-radius:10px; box-shadow:0 2px 14px rgba(20,30,50,.06); }
h1 { font-size:27px; margin:0 0 18px; padding-bottom:14px; border-bottom:3px solid var(--ink); }
h2 { font-size:20px; margin:38px 0 12px; padding-left:10px; border-left:4px solid var(--accent); }
h3 { font-size:17px; margin:26px 0 10px; color:#2b3548 }
p { margin:10px 0 }
code { font:13px/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace; background:#f0f2f6;
  padding:1px 5px; border-radius:4px; color:#134272; word-break:break-all }
ul { margin:10px 0; padding-left:22px }
ol { margin:10px 0; padding-left:24px }
pre { margin:14px 0 22px; padding:14px 16px; background:#f7f9fc; border:1px solid var(--line);
  border-left:4px solid #b9c6de; border-radius:8px; overflow-x:auto }
pre code { background:none; padding:0; color:#2b3548; font-size:12.5px; line-height:1.6;
  white-space:pre; word-break:normal }
li { margin:4px 0 }
hr { border:0; border-top:1px solid var(--line); margin:30px 0 }
.tablewrap { overflow-x:auto; margin:14px 0 22px; border:1px solid var(--line); border-radius:8px }
table { border-collapse:collapse; width:100%; font-size:13.5px }
th,td { border-bottom:1px solid var(--line); border-right:1px solid #eceff4;
  padding:9px 11px; text-align:left; vertical-align:top }
th { background:#eef2f8; font-weight:600; white-space:nowrap; position:sticky; top:0; z-index:2 }
tr:last-child td { border-bottom:0 }
tbody tr:nth-child(even) { background:#fbfcfe }
a { color:var(--accent) }
figure { margin:16px 0 26px; padding:10px; border:1px solid var(--line); border-radius:8px; background:#fbfcfe }
figure img { display:block; width:100%; max-width:1280px; margin:0 auto; border:1px solid #cfd6e2; border-radius:5px; background:#fff }
figcaption { margin-top:8px; font-size:12.5px; color:var(--muted); text-align:center }
img { max-width:100% }
@media print { body { background:#fff; padding:0 } main { border:0; box-shadow:none; padding:0 } }`;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_, c) => `<b>${c}</b>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);

const lines = readFileSync(src, 'utf8').split('\n');
const out = [];
let i = 0;
while (i < lines.length) {
  const l = lines[i];
  if (!l.trim()) { i++; continue; }
  if (/^```/.test(l)) {
    i++;
    const code = [];
    while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
    i++;
    out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    continue;
  }
  if (/^---+$/.test(l.trim())) { out.push('<hr>'); i++; continue; }
  /* 独占一行的图片 = 带题注的图：验证手册要逐步贴图，题注就是那一步的验收点 */
  const img = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(l);
  if (img) {
    out.push(
      `<figure><img src="${esc(img[2])}" alt="${esc(img[1])}" loading=lazy>` +
      (img[1] ? `<figcaption>${inline(img[1])}</figcaption>` : '') +
      '</figure>',
    );
    i++;
    continue;
  }
  const h = /^(#{1,3})\s+(.*)$/.exec(l);
  if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
  if (l.startsWith('|')) {
    const rows = [];
    while (i < lines.length && lines[i].startsWith('|')) { rows.push(lines[i]); i++; }
    const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    out.push(
      '<div class="tablewrap"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') +
      '</tr></thead><tbody>' +
      body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
      '</tbody></table></div>',
    );
    continue;
  }
  if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
    const items = [];
    while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
      const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
      items.push({ depth: Math.floor(m[1].length / 2), ordered: /\d/.test(m[2]), text: m[3] });
      i++;
    }
    let idx = 0;
    const render = (depth) => {
      let html = '';
      let open = null;
      while (idx < items.length && items[idx].depth === depth) {
        const it = items[idx];
        idx++;
        const tag = it.ordered ? 'ol' : 'ul';
        if (open !== tag) {
          if (open) html += `</${open}>`;
          html += `<${tag}>`;
          open = tag;
        }
        let inner = inline(it.text);
        if (idx < items.length && items[idx].depth > depth) inner += render(items[idx].depth);
        html += `<li>${inner}</li>`;
      }
      if (open) html += `</${open}>`;
      return html;
    };
    out.push(render(0));
    continue;
  }
  const para = [];
  while (i < lines.length && lines[i].trim() && !/^(#|\||---|!|[-*]\s|\d+\.\s)/.test(lines[i])) { para.push(lines[i]); i++; }
  out.push(`<p>${inline(para.join(' '))}</p>`);
}

const title = (lines.find((l) => l.startsWith('# ')) ?? '# ' + basename(src)).slice(2);
writeFileSync(
  src.replace(/\.md$/, '.html'),
  `<!doctype html><html lang=zh-CN><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>${esc(title)}</title><style>\n${css}\n</style></head><body><main>\n${out.join('\n')}\n</main></body></html>\n`,
);
console.log('WROTE', src.replace(/\.md$/, '.html'));
