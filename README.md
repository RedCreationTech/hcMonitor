# 精简版 · 文件索引

「言心」MindDialogue 精简版：**只保留分析工作台**，功能收敛为「多信号源素材上传分析 → 逐素材分析过程 → 汇总分析结果 → 分析报告」离线闭环。
依据：《基于对话内容的行为异常检测和心理变化分析技术》（中关村新域新质创新挑战赛，需求编号 7008111111）。
本文件夹为独立新项目，**原路径下的完整版项目文件一律未改动**：文档、代码、演示素材、截图与截图工装全部单存于 `精简版/` 内自洽，完整版目录零写入、运行时零依赖；文中出现的完整版文件名只作出处引用。

| 文件 | 内容 | 读者 |
|---|---|---|
| `中关村新域新质创新挑战赛需求汇编.pdf` | 原始招标（复制件，正文页 80—81 为本条目） | 全员 |
| `独立软件开发需求清单-人员分配版本.docx` | 原始需求清单（复制件，§28 为本条目） | 全员 |
| `00_评审须知.md` / `.html` | **发给外部评审时的封面**：阅读顺序与用时、三条命令跑起来、评审应重点看的五件事、包内结构、包内不含什么 | 外部评审 |
| `01_精简版调研报告.md` / `.html` | 招标原文逐字核验、类似产品调研、技术学术依据、离线精度优势 | 客户确认 + 方案 |
| `02_精简版产品形态与功能划分.md` / `.html` | 产品形态边界、M1—M4 功能划分（含契约/锚点/验收）、28.01—28.08 覆盖矩阵、Q1—Q15 指标拆解、实施路线 | 客户确认 + 开发执行 |
| `03_精简版界面可视稿.html` | 十三屏实拍可视稿（前 5 屏音视频主链路，后 8 屏多信号源链路；截图在 `可视稿/`） | 客户确认 |
| `04_技术出处目录.md` / `.html` | 每项指标/规则/阈值的四级出处（A 已核实 / B 待核定位 / C 自定义口径 / D 演示占位）+ 调研深度如实结论 | 全员 |
| `05_行业速成手册.md` / `.html` | 30 分钟入门：电梯陈述、17 术语大白话、数字三问、评审 10 问、话术红线 | 方案/投标同事 |
| `06_多信号源上传与硬件接入说明.md` / `.html` | 四类素材 × 六类异常的对应、扩展信号封顶的逐条失效原因与现场判据、后续硬件候选（A/B/C/D 四组）、界面动线与断言 | 客户确认 + 开发执行 |
| `07_精简版验证操作手册.md` / `.html` | **照着走一遍的验证手册**：13 个用例（C1—C5 主链路 + N1—N9 负向边界）逐步骤操作 / 32 张实拍截图 / 通过判据打勾框 / 28.01—28.08 与 Q1—Q15 覆盖核对表 / 28.08 现场演练动线 / 如实披露清单；截图与取证记录在 `验证手册截图/` | 客户实测 + 投标同事 |
| `08_讲标一页纸.md` / `.html` | **对内对齐**：结论先行、给什么/放弃什么及依据、手上有哪些能当场打开的硬证据、三个风险与对策、需要领导拍的三个板（不含商务） | 内部决策 |
| `prototype-lite/` | 可运行精简版原型：`npm install && npm run dev` → http://127.0.0.1:5185（口令 1234）；`npm run verify` 49 条断言 | 开发 |
| `tools/md2html.mjs` | 文档 md→html 生成器：`node tools/md2html.mjs <文件>.md` 覆盖同名 HTML | 方案 |
| `tools/shot.mjs` | 截图工装（无头 Chrome + 席位注入），精简版自带副本，命令见下节「可视稿重拍」 | 方案 |

> 现由 `tools/md2html.mjs` 生成的 HTML：02、05、06、07、08（改 md 后须重跑，否则两份不一致）。
> 01、03、04 的 HTML 是手写富样式版（03 为可视稿相册），**不要**用脚本覆盖。

## 当前状态（2026-10-22）

- 原型构建通过、49 条需求断言全通过（新增 F/F2 段 21 条多信号源断言）、十三屏画面实拍自运行实例。
- 多信号源已实现：四类素材（视频 / 音频 / 近红外 / 毫米波）分框登记，音视频为主、扩展信号多选非必填；**登记后每一份都进入批分析**，逐份切片、逐份列示，最后在会话层融合成一份报告，支持导出 HTML（含附表 A 素材切片一览）与 CSV、打印。
- 扩展信号（近红外 / 毫米波）结论封顶：只到生理趋势层，不进 ESCALATED、不出心理归因，`confidence` 重定义为趋势显著性；该口径在代码、界面、报告、CSV 四处一致。
- 关键判断：离线工作台可完整/基本覆盖 28.01—28.07；放弃项（实时监看、跨终端协同、硬件形态）均为完整版自行加码，非招标要求；28.08 实测改为"现场上传素材离线出报告"。
- 演示数据：`node prototype-lite/scripts/demo-multisource.mjs` 用 `public/demo/` 下四路真实素材起一次批分析；重拍画面见下节。
- **验证素材包**：`prototype-lite/public/testkit/` 13 份（2 路音视频 + 2 路音频 + 5 份采样序列 + 4 份边界件），规格与用途见该目录 `README.md`。
- **验证手册**：`07_精简版验证操作手册.md`（13 个用例逐步骤 + 32 张实拍截图 + 打勾判据 + 28.01—28.08 / Q1—Q15 核对表）；截图与逐条取证记录在 `验证手册截图/`，重跑见下节「验证手册截图重拍」。
- 待办：规则库占位文献替换（真实文献清单见调研报告 §3.1）；P1 最小真实推理接入（openSMILE + ASR + pyannote）；扩展信号的列名/单位映射配置（现为"读首列推时基"）。

## 可视稿重拍

前提：`prototype-lite` 的 dev server 跑在 5185；截图工装用本文件夹自带的 `精简版/tools/shot.mjs`（无头 Chrome + `--actor` 注入席位），精简版不依赖仓库根的共享工装。
以下命令均在 `精简版/prototype-lite/` 下执行，产物写回 `../可视稿/`。

```bash
S=../tools/shot.mjs

# 06 任务台 · 多源素材登记（列表里该行带「含扩展信号」标签）
node $S --url=http://127.0.0.1:5185/t/workstation --out="../可视稿/06_任务台_多源素材登记.png" \
  --actor=W-02 --w=1440 --h=773 --settle=1500

# 07 新建会话 · 四路素材上传（把 public/demo 四份文件真的拖进弹窗）
node $S --url=http://127.0.0.1:5185/t/workstation --out="../可视稿/07_新建会话_四路素材上传.png" \
  --actor=W-02 --w=1440 --h=1413 --settle=1500 --pre="$(cat scripts/inject-upload-shot.js)"

# 08 分析过程 · 逐素材进度（--no-wait 只起批，边跑边拍；批分析全程约 8.4s）
U=$(node scripts/demo-multisource.mjs --no-wait | tail -1 | sed 's#^结果页 ##')
node $S --url="$U" --out="../可视稿/08_分析过程_逐素材切片进度.png" \
  --actor=W-02 --w=1440 --h=826 --settle=1200 --wait=1200

# 起批并等完成，拿到会话号与报告号后拍 09—11（结果页滚动的是内层 .stage-area，不是 window）
node scripts/demo-multisource.mjs
R=http://127.0.0.1:5185/t/workstation/offline/<会话号>
node $S --url="$R" --out="../可视稿/09_分析结果_汇总与模态可用性.png" --actor=W-02 --w=1440 --h=913 --settle=1500
node $S --url="$R" --out="../可视稿/10_分析结果_素材切片与趋势.png" --actor=W-02 --w=1440 --h=1113 --settle=1500 \
  --pre="(()=>{const e=document.querySelector('.stage-area');const b=[...e.querySelectorAll('.ant-card-head b.mono')].find(x=>x.textContent.includes('nir_hbo'));const c=b.closest('.ant-card');e.scrollTop=c.getBoundingClientRect().top-e.getBoundingClientRect().top+e.scrollTop-8})()"
node $S --url="$R" --out="../可视稿/11_分析结果_六类信号与异常表.png" --actor=W-02 --w=1440 --h=1013 --settle=1500 \
  --pre="document.querySelector('.stage-area').scrollTop=2300"

# 12 报告与审批（分析师席位下，草稿件带「无审批权限」提示）
node $S --url=http://127.0.0.1:5185/t/workstation/reports --out="../可视稿/12_分析报告_草稿与审批流.png" \
  --actor=W-02 --w=1440 --h=1013 --settle=1600

# 13 导出件 · 附表 A：先取导出 HTML（未发布件自带水印），再拍本地文件
curl -s -X POST http://127.0.0.1:5185/v1/reports/<报告号>/export \
  -H 'content-type: application/json' -d '{"mode":"file"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>require('fs').writeFileSync('../可视稿/导出样例_离线报告_多信号源.html',JSON.parse(s).html))"
node $S --url="file://$PWD/../可视稿/导出样例_离线报告_多信号源.html" \
  --out="../可视稿/13_报告导出_附表A素材切片.png" --w=1200 --h=1213 --settle=800 \
  --pre="(()=>{const h=[...document.querySelectorAll('h3')].find(n=>n.textContent.includes('附表 A'));document.scrollingElement.scrollTop=h.offsetTop-8})()"
```

> 会话号 / 报告号每次起批都会变，拍完记得核对 `03_精简版界面可视稿.html` 里写死的数值（事件号、置信度、时长）是否仍与画面一致。
> `npm run verify` 收尾会恢复出厂状态，**不要在 verify 运行期间或之后直接重拍**——先重新起批。

## 验证手册截图重拍

`07_精简版验证操作手册.md` 里的 32 张截图与全部"实测值"由一个工装脚本跑真实链路产出（不是摆拍）：
它在无头 Chrome 里真的把 `public/testkit/` 的素材拖进登记框、走页面自身的 `probeDuration` / `probeSeries`、点起批、等完成、开归因抽屉、走审批发布，并把服务端当场返回的数字逐条打印成取证记录。

```bash
cd prototype-lite
npm run dev &                                  # 5185
node scripts/testkit-shots.mjs                 # 全量 13 个用例（C1—C5 / N1—N9），约 8 分钟
node scripts/testkit-shots.mjs --only=C1,N9    # 只重跑指定用例
```

产物写回 `../验证手册截图/`：PNG + `取证记录.md`（汇总）+ `取证记录/<用例>.md`（分用例原始记录）+ `_shotlog/`（每次注入的脚本片段与告警）。
改完 md 后重跑 `node ../tools/md2html.mjs 07_精简版验证操作手册.md` 同步 HTML。

> 该工装只存在于精简版目录内，完整版 `标书/prototype/` 与仓库根共享工装均未改动。
> 用例之间引擎会恢复出厂状态，会话号 `SES-<日期>-N<序号>` 因此可能重复出现，不是同一会话（详见手册第八章第 9 条）。


## 打评审包

发给外部评审时排除依赖与构建产物（约 230 MB → 70 MB），封面用 `00_评审须知.md`：

```bash
cd /Users/admin/Downloads/标书/精简版
node tools/md2html.mjs 00_评审须知.md          # 改 md 后重跑
cd ..
zip -r -X "言心精简版_评审包_$(date +%Y%m%d).zip" 精简版 \
  -x "精简版/prototype-lite/node_modules/*" \
  -x "精简版/prototype-lite/dist/*" \
  -x "精简版/prototype-lite/tsconfig.tsbuildinfo" \
  -x "*.DS_Store"
```

> 收件人拿到后 `cd 精简版/prototype-lite && npm install && npm run dev` 即可复原，包内不需要 `node_modules`。
> 若要**纯对外版**（不含内部对齐页 `08_讲标一页纸.*`），在上面命令追加 `-x "精简版/08_讲标一页纸.*"`。
