# analysis-service · M1真实分析服务

基于现有精简版算法链演进的局域网证据闭环。默认全离线运行，无业务演示种子，无在线模型下载。

## 运行

在本目录执行：

```bash
.venv/bin/python manage.py serve
```

入口 http://127.0.0.1:5190，直接提供编译后的React页面、REST、WebSocket和受控媒体。运行配置在私有 `data/runtime-config.json`，本机已使用独立PostgreSQL16.15；启动会检查本项目数据库，未运行则启动。原data/store.json未覆盖。

全新机器使用离线包的 `install.command` / `start.command`。开发环境在线准备依赖时参考 `requirements.txt`；实际交付以 `requirements-macos-x86_64.lock`、wheel指纹、`model-manifest.json` 和离线包清单为准。

## 运维与测试

```bash
.venv/bin/python manage.py preflight
.venv/bin/python manage.py verify
.venv/bin/python -m pytest tests -q
# 单独指定专用PostgreSQL测试库，不要指向业务库。
TEST_POSTGRES_URL='postgresql:///测试库?host=/你的专用socket&port=55432' .venv/bin/python -m pytest tests -q
```

真实算法验证：`scripts/smoke_real.py`（演示音频两次run→校正→真实本地叙述→分层复核→发布→三种导出，禁止网络连接）；`scripts/smoke_multisource.py`（短视频和文件传感器）。它们使用独立QA目录，不作为真人效果评估。重复运行需新的QA_DATA_ROOT。

## 模块与不变量

- `security.py/main.py`：本地可信身份、项目/任务/逐用途策略、完整上传、Range与版本Grant。客户端actor不作为身份。
- `store.py`：PostgreSQL JSONB聚合事务及行锁；SQLite只作独立测试/恢复演练后备。业务与审计同事务。
- `worker.py/engine.py`：持久作业、隔离执行、恢复/取消/超时、每素材独立时轴、不可变run和来源指纹。
- `pipeline/`：保留真实语音/声学/语义/视觉/文件趋势管线；未知不强绑，基线不足拒判，质量缺口不当心理异常。
- `narrative.py`：实际Qwen2.5-0.5B GGUF CPU推理；可信句子白名单、结构与引证校验；数值/等级/专家决定由代码与人工控制。
- `reporting.py`：冻结快照统一渲染PDF/HTML/CSV，中文字体内嵌。批准后锁定，新版本重审；生成与领取分别核验。
- `cli.py/scripts/`：隔离迁移、备份/恢复及限制记录、固定离线运行时与依赖包。

已封存素材不覆盖；工件按 `data/m1/artifacts/<session>/<run>/` 保存。原文与旧run不改写，校正触发新run；独立复核追加保存，报告快照绑定复核和内容版本。

## 来源与能力边界

叙述模型来自Qwen官方仓库，固定revision和SHA256见清单；PDF字体来自Google Fonts Noto Sans SC，许可证见fonts/OFL.txt。第三方模型/二进制/依赖各遵守自身许可证，不能概括为“全栈Apache/MIT/BSD”；本机ffmpeg许可信息在离线运行时记录。

当前工程测试、现场设备、全新物理OS/真实局域网验收和真人算法评估分别记录，见 [自测报告](../docs/M1自测报告.md) 与 [人工复测执行说明](../docs/M1人工复测执行说明.md)。完整研究治理、跨次比较和在线硬件按后续阶段实现。
