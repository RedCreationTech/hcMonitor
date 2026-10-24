# analysis-service · 真实分析服务

「言心」精简版的真实算法引擎，替换 mock 回放。**契约不变**：实现与 `prototype-lite` 前端完全相同的 `/v1/*` REST 与 WS 事件格式（见 `app/contracts.py`，镜像 `prototype-lite/src/shared/types.ts`）。

## 运行

```bash
/usr/local/bin/python3.11 -m venv .venv     # py3.14 无 torch wheel，必须用 3.11
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 5190  # 前端 vite 代理 /v1 → 5190
```

模型首次运行时从 ModelScope 自动下载到 `models/`（约 10GB，不入库）。

## 模块接口（pipeline/ 各模块必须遵守）

每个模块是纯函数风格：`run(*inputs, out_dir: Path) -> dict`，中间产物全部落盘
`data/artifacts/<session_id>/<modality>/`（取证可出示），返回契约形状的字典。

| 模块 | 输入 | 返回（契约形状） |
|---|---|---|
| `preprocess` | 素材文件 | 16kHz WAV / 25fps 帧目录 / 探测元数据 |
| `speech` | WAV | `{turns: DialogueTurn[]}`（真实 ASR+分角色+置信度） |
| `acoustic` | WAV + turns | `{anomalies: AnomalyEvent[]}`（语音特征异常，voice 模态）+ 特征表 CSV |
| `semantic` | turns | `{impacts: ImpactEvent[], anomalies: AnomalyEvent[]}`（话题/影响值/矛盾） |
| `vision` | 帧目录 | `{anomalies: [...]}`（face/pose/hand）+ AU/姿态/手部时序 CSV |
| `rppg` | 帧目录 | `{anomalies: [...]}`（physio，HRV 趋势方向）+ 波形 CSV |
| `ext_mmwave` | CSV | `{trend: PhysioTrend, anomalies: [...]}`（cap_note 封顶） |
| `ext_nir` | CSV | 同 mmwave |
| `fusion` | 全部事件 | 升级判定（E1 时间窗聚合 → E2 规则升级 ESCALATED） |
| `attribution` | 事件 + rules/rules.yaml | 每条事件补 L1 观察 / L2 候选规则 / L3 结论（LLM 仅叙述组装） |

## 许可红线

全栈 Apache-2.0/MIT/BSD。**禁用**：openSMILE（商用禁令）、OpenFace 2.0（CMU 版税）、
Ultralytics YOLO（AGPL）。选型依据见 `../docs/优化需求方案设计-7008111111.md`。
