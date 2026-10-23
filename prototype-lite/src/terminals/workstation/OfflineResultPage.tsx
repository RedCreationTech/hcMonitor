import { useState } from 'react';
import { App, Alert, Button, Card, Drawer, Empty, Progress, Statistic, Table, Tag, Tooltip } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { useApi, useStream } from '../../api/useStream';
import { AttributionView, CausalTimeline } from '../../components/attribution';
import type { AnomalyEvent, AssetRef, ModalityKey, OfflineSlice } from '../../shared/types';
import { ASSET_KIND_LABEL, MODALITY_LABEL } from '../../../mock/script';

const ALL_MODALITIES: ModalityKey[] = ['voice', 'semantic', 'face', 'pose', 'hand', 'physio'];

const fmtBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;

/** 趋势迷你折线：只用来当场看出"上行 / 回落"，不带刻度轴——扩展信号的量纲本就不支持跨会话比较 */
function Spark({ series, decimals, unit }: { series: number[]; decimals: number; unit: string }) {
  const w = 168;
  const h = 34;
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  const span = hi - lo || 1;
  const pts = series
    .map((v, i) => `${((i / (series.length - 1)) * w).toFixed(1)},${(h - ((v - lo) / span) * (h - 4) - 2).toFixed(1)}`)
    .join(' ');
  return (
    <Tooltip title={`逐采样点：${series.map((v) => v.toFixed(decimals)).join(' · ')} ${unit}`}>
      <svg width={w} height={h} style={{ display: 'block' }}>
        <polyline points={pts} fill="none" stroke="#1664ff" strokeWidth={1.4} />
        <circle cx={w} cy={h - ((series[series.length - 1] - lo) / span) * (h - 4) - 2} r={2.2} fill="#cf1322" />
      </svg>
    </Tooltip>
  );
}

/** 单份素材的解析切片：该文件贡献了什么、没贡献什么、结论走到哪一层为止 */
function SliceCard({ slice, onEvent }: { slice: OfflineSlice; onEvent: (id: string) => void }) {
  const ext = slice.role === 'extension';
  return (
    <Card
      size="small"
      style={{ marginBottom: 10, borderColor: ext ? '#adc6ff' : undefined }}
      title={
        <span style={{ fontSize: 12.5 }}>
          <b className="mono">{slice.asset_name}</b>
          <Tag color={ext ? 'geekblue' : 'blue'} style={{ marginLeft: 8 }}>{ASSET_KIND_LABEL[slice.kind]}</Tag>
          <Tag color={ext ? 'warning' : 'processing'}>{ext ? '扩展信号 · 只到生理趋势层' : '主信号 · 进全链判定'}</Tag>
          <Tag color={slice.quality === 'ok' ? 'success' : 'warning'}>质量{slice.quality === 'ok' ? '达标' : '降级'}</Tag>
        </span>
      }
    >
      <div className="sub" style={{ fontSize: 11.5, marginBottom: 6 }}>
        {fmtBytes(slice.size_bytes)} · {slice.duration_seconds ? `时基 ${slice.duration_seconds}s` : '时基未从素材读出'} · {slice.quality_note}
      </div>

      <div style={{ marginBottom: 8 }}>
        <b style={{ fontSize: 12 }}>解析切片（{slice.steps.length} 段）</b>
        <ol style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, color: '#3d4a63' }}>
          {slice.steps.map((s, i) => (
            <li key={s} style={{ marginBottom: 2 }}>{`#${i + 1} ${s}`}</li>
          ))}
        </ol>
      </div>

      <div className="row" style={{ gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
        {ALL_MODALITIES.map((m) => {
          const on = slice.modality_available.includes(m);
          return (
            <Tooltip
              key={m}
              title={
                on
                  ? ext
                    ? '本素材提供该路信号，但按扩展信号口径只到趋势层'
                    : '本素材含该路信号帧，参与判定'
                  : '本素材不含该路信号：这一路不产出结论，也不产出 0 值'
              }
            >
              <Tag color={on ? (ext ? 'geekblue' : 'success') : 'default'} style={{ fontSize: 11 }}>
                {MODALITY_LABEL[m]} {on ? '✓' : '✕'}
              </Tag>
            </Tooltip>
          );
        })}
      </div>

      {slice.trend && (
        <>
          <b style={{ fontSize: 12 }}>生理趋势（{slice.trend.sensor_label} · {slice.trend.samples} 个采样窗 · 时基取{slice.trend.time_base}）</b>
          <Table
            size="small"
            style={{ margin: '6px 0 8px' }}
            pagination={false}
            rowKey="name"
            dataSource={slice.trend.metrics}
            columns={[
              { title: '指标', dataIndex: 'name', width: 150, render: (v: string) => <span style={{ fontSize: 12 }}>{v}</span> },
              {
                title: '基线 → 峰值',
                width: 150,
                render: (_, m) => (
                  <span className="mono" style={{ fontSize: 12 }}>
                    {m.baseline.toFixed(m.decimals)} → <b>{m.peak.toFixed(m.decimals)}</b> {m.unit}
                  </span>
                ),
              },
              { title: '峰值时刻', width: 84, render: (_, m) => <span className="mono" style={{ fontSize: 12 }}>{m.peak_ts}s</span> },
              { title: '末段值', width: 84, render: (_, m) => <span className="mono" style={{ fontSize: 12 }}>{m.end_value.toFixed(m.decimals)}</span> },
              { title: '轨迹', render: (_, m) => <Spark series={m.series} decimals={m.decimals} unit={m.unit} /> },
            ]}
          />
          <div style={{ fontSize: 11.5, color: '#3d4a63', marginBottom: 6 }}>
            这一路为什么只到趋势层（逐条独立陈述）：
            <ul style={{ margin: '2px 0 0 16px', paddingLeft: 8 }}>
              {slice.trend.limits.map((l) => (
                <li key={l} style={{ marginBottom: 2 }}>{l}</li>
              ))}
            </ul>
          </div>
        </>
      )}

      {slice.cap_note && (
        <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="结论上限" description={<span style={{ fontSize: 12 }}>{slice.cap_note}</span>} />
      )}

      <div className="row" style={{ gap: 6, flexWrap: 'wrap', fontSize: 12 }}>
        <span className="sub">支撑事件：</span>
        {slice.event_ids.length ? (
          slice.event_ids.map((e) => (
            <Button key={e} size="small" type="link" className="mono" style={{ fontSize: 11.5, padding: 0 }} onClick={() => onEvent(e)}>
              {e}
            </Button>
          ))
        ) : (
          <span className="sub mono">本素材未单独支撑条目（其信号已在主素材链上参与融合）</span>
        )}
      </div>
      {slice.suppressed.length > 0 && (
        <div className="sub" style={{ fontSize: 11.5, marginTop: 6 }}>
          本素材裁撤 {slice.suppressed.length} 条：{slice.suppressed.map((x) => `${x.id}——${x.reason}`).join('；')}
        </div>
      )}
    </Card>
  );
}

/** S-09 离线批分析结果：已有素材导入会话的研判页。
 *  数据来自 session.offline，与实时监看的 state.anomalies 是两份东西——
 *  本页不进入现场工单，报告口径强制带「离线导入 · 非实时」。 */
export function OfflineResultPage() {
  const { id } = useParams();
  const { message } = App.useApp();
  const post = useApi();
  const nav = useNavigate();
  const { state } = useStream('workstation');
  const [detail, setDetail] = useState<AnomalyEvent | null>(null);
  const [causal, setCausal] = useState<AnomalyEvent | null>(null);

  const session = state?.sessions.find((s) => s.id === id) ?? null;
  const r = session?.offline ?? null;
  const job = session?.offline_job ?? null;

  if (!session) return <div className="page"><Empty description={`会话 ${id} 不存在`} /></div>;
  if (session.source !== 'imported')
    return (
      <div className="page">
        <Alert type="warning" showIcon message="本会话是现场实时采集，请走实时监看" description="离线批分析只接已有素材：两条链路的口径不同，不能互相顶替。" />
      </div>
    );

  const assetList: AssetRef[] =
    session.assets ?? (session.asset ? [{ id: 'AS-01', name: session.asset.name, size_bytes: session.asset.size_bytes, duration_seconds: session.asset.duration_seconds, kind: session.asset.kind }] : []);
  const assets_note = `${assetList.length} 份素材（${assetList.map((a) => ASSET_KIND_LABEL[a.kind]).join('、')}）`;

  const download = (filename: string, text: string, mime: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportCsv = async () => {
    try {
      const res = await post<{ csv: string; filename: string; rows: number; audit_seq: number }>(
        `/sessions/${session.id}/analyze-offline/csv`,
        {},
      );
      download(res.filename, res.csv, 'text/csv;charset=utf-8');
      message.success(`已导出 ${res.rows} 行（含被裁撤条目），审计留痕 seq=${res.audit_seq}`);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h3>离线批分析结果 · {session.id}</h3>
        <Tag color="purple">离线导入 · 非实时</Tag>
        <span className="grow" />
        <Button size="small" onClick={exportCsv} disabled={!r}>导出 CSV（含裁撤条目）</Button>
        <Button size="small" type="primary" onClick={() => nav('/t/workstation/reports')} disabled={!r}>查看报告</Button>
      </div>

      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message={`素材 ${assetList.length} 份：${assetList.map((a) => `${a.name}（${ASSET_KIND_LABEL[a.kind]}）`).join('、') || '未登记'}`}
        description={
          r
            ? `登记素材全部进入批分析：主信号 ${r.slices.filter((x) => x.role === 'primary').length} 份走完整判定链，扩展信号 ${r.slices.filter((x) => x.role === 'extension').length} 份只到生理趋势层；脚本链可用模态 ${r.modality_available.length}/6（${r.modality_available.map((m) => MODALITY_LABEL[m]).join('·') || '无'}）；上报 ${r.anomalies.length} 条、裁撤 ${r.suppressed.length} 条；判定口径 ${r.pipeline}；完成于 ${r.finished_at}。本页结论不与实时监看结论混用。`
            : job
              ? `批分析进行中：${assets_note}`
              : '尚未发起离线批分析。发起后每份素材各跑一段解析链，逐片推进度显示在本页。'
        }
      />

      {job && (
        <Card size="small" style={{ marginBottom: 12 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <b style={{ fontSize: 12.5 }}>批分析进行中 · 按素材逐片推进</b>
            <span className="sub" style={{ fontSize: 12 }}>{job.stage}</span>
          </div>
          <Progress percent={job.progress} status="active" size="small" />
          <div style={{ marginTop: 8, maxHeight: 230, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {(job.steps ?? []).map((st, i) => {
              const done = st.progress <= job.progress && i < (job.steps ?? []).findIndex((x) => x.progress > job.progress);
              const current = i === (job.steps ?? []).findIndex((x) => x.progress > job.progress);
              return (
                <div key={`${st.asset ?? 'fusion'}-${i}`} className="row" style={{ gap: 6, fontSize: 11.5 }}>
                  <span className="mono" style={{ width: 56, flex: '0 0 56px', whiteSpace: 'nowrap', color: done ? '#389e0d' : current ? '#1664ff' : '#8d97a8' }}>
                    {done ? '✓' : current ? '▶' : '·'} {st.progress}%
                  </span>
                  <span style={{ color: done || current ? '#1c2330' : '#8d97a8' }}>{st.stage}</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {!r && !job && (
        <Empty description="本会话还没有分析产物">
          <Button
            type="primary"
            onClick={async () => {
              try {
                await post(`/sessions/${session.id}/analyze-offline`, {});
                message.success('批分析已起批，进度见本页');
              } catch (e) {
                message.error((e as Error).message);
              }
            }}
          >发起离线批分析</Button>
        </Empty>
      )}

      {r && (
        <>
          <div className="stat-row">
            <Card size="small"><Statistic title="登记素材" value={r.assets.length} suffix={`/ 全部参与`} /></Card>
            <Card size="small"><Statistic title="上报异常" value={r.anomalies.length} /></Card>
            <Card size="small"><Statistic title="其中扩展信号" value={r.anomalies.filter((a) => a.cap_note).length} valueStyle={{ color: '#1d39c4' }} /></Card>
            <Card size="small"><Statistic title="覆盖模态类数" value={new Set(r.anomalies.map((a) => a.modality)).size} suffix="/ 6" /></Card>
            <Card size="small"><Statistic title="裁撤条目" value={r.suppressed.length} valueStyle={{ color: '#d46b08' }} /></Card>
            <Card size="small"><Statistic title="话题边界" value={r.impacts.length} /></Card>
            <Card size="small"><Statistic title="峰值严重度" value={r.anomalies.some((a) => a.severity === 'ESCALATED') ? 'ESCALATED' : r.anomalies.some((a) => a.severity === 'ALERT') ? 'ALERT' : 'WARN'} /></Card>
          </div>

          <div className="section">
            <h4>素材切片（每份文件各跑各的解析链，产物逐份列示，最后在会话层融合）</h4>
            {r.slices.map((x) => (
              <SliceCard
                key={x.asset_id}
                slice={x}
                onEvent={(eid) => {
                  const hit = r.anomalies.find((a) => a.id === eid);
                  if (hit) setDetail(hit);
                  else message.info(`${eid} 是解析段编号或话题 id，不在异常表里——它对应的内容见下方话题表与本卡片的解析链`);
                }}
              />
            ))}
          </div>

          <div className="section">
            <h4>六类信号的可用性（由素材类型决定，不是由人勾选）</h4>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {ALL_MODALITIES.map((m) => {
                const on = r.modality_available.includes(m);
                const byExt = !on && r.slices.some((x) => x.role === 'extension' && x.modality_available.includes(m));
                return (
                  <Tooltip
                    key={m}
                    title={
                      on
                        ? '至少一份素材含该路信号帧，参与脚本判定链'
                        : byExt
                          ? '脚本判定链（音视频口径）在这一路没有输入；扩展信号提供的同名信号只到生理趋势层，不并入本链'
                          : '所有登记素材都不含该路信号：整条判定链不产出该项，也不产出 0 值'
                    }
                  >
                    <Tag color={on ? 'success' : byExt ? 'geekblue' : 'default'}>
                      {MODALITY_LABEL[m]} {on ? '✓' : byExt ? '仅趋势' : '✕'}
                    </Tag>
                  </Tooltip>
                );
              })}
            </div>
          </div>

          <div className="section">
            <h4>异常事件（点一行展开 L1 观察 → L2 候选规则 → L3 结论）</h4>
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={r.anomalies}
              scroll={{ x: 900 }}
              onRow={(row) => ({ onClick: () => setDetail(row), style: { cursor: 'pointer' } })}
              columns={[
                { title: '事件', dataIndex: 'id', width: 96, render: (v: string) => <b className="mono" style={{ fontSize: 12 }}>{v}</b> },
                {
                  title: '素材',
                  width: 150,
                  render: (_, x) => (
                    <Tooltip title={(x.source_assets ?? []).map((a) => `${a.name}·${ASSET_KIND_LABEL[a.kind]}`).join(' + ') || '未在素材表登记'}>
                      <span className="mono" style={{ fontSize: 11 }}>
                        {(x.source_assets ?? []).map((a) => a.name).join(' + ') || '—'}
                      </span>
                    </Tooltip>
                  ),
                },
                { title: 't(s)', dataIndex: 'ts', width: 62 },
                { title: '模态', dataIndex: 'modality', width: 96, render: (v: ModalityKey) => <Tag>{MODALITY_LABEL[v]}</Tag> },
                { title: '类型', dataIndex: 'type', width: 220 },
                {
                  title: '严重度', dataIndex: 'severity', width: 104,
                  render: (v: string) => <Tag color={v === 'ESCALATED' ? 'error' : v === 'ALERT' ? 'volcano' : 'orange'}>{v}</Tag>,
                },
                { title: '置信度', dataIndex: 'confidence', width: 78, render: (v: number) => <span className="mono">{v.toFixed(2)}</span> },
                {
                  title: '心理原因结论',
                  render: (_, x) =>
                    x.cap_note ? (
                      <Tooltip title={x.cap_note}>
                        <Tag color="geekblue" style={{ fontSize: 11 }}>只到趋势层 · 不出归因</Tag>
                      </Tooltip>
                    ) : (
                      <span style={{ fontSize: 12 }}>{x.attribution.conclusion.psych_state}</span>
                    ),
                },
              ]}
            />
          </div>

          <div className="section">
            <h4>话题切分与语义影响值</h4>
            <Table
              size="small"
              rowKey="topic_id"
              pagination={false}
              dataSource={r.impacts}
              scroll={{ x: 900 }}
              columns={[
                { title: '话题', dataIndex: 'topic_id', width: 72 },
                { title: '边界(s)', width: 110, render: (_, x) => <span className="mono">{x.boundary[0]}–{x.boundary[1]}</span> },
                { title: '标签', dataIndex: 'label', width: 220 },
                { title: '影响值', dataIndex: 'impact_score', width: 84, render: (v: number) => <b className="mono">{v.toFixed(2)}</b> },
                {
                  title: '四维分解', width: 230,
                  render: (_, x) => (
                    <Tooltip title="归一化 [0,1] 相对量，仅本会话内排序，不可跨会话比较">
                      <span className="mono" style={{ fontSize: 11.5 }}>
                        情绪 {x.dims['情绪冲击']} · 认知 {x.dims['认知冲突']} · 利益 {x.dims['利益相关']} · 持续 {x.dims['持续影响']}
                      </span>
                    </Tooltip>
                  ),
                },
                { title: '边界判定依据', dataIndex: 'boundary_evidence', render: (v: string) => <span style={{ fontSize: 11.5 }} className="sub">{v}</span> },
              ]}
            />
          </div>

          <div className="section">
            <h4>裁撤条目（为什么这几条没有出现在上面）</h4>
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={r.suppressed}
              columns={[
                { title: '条目', dataIndex: 'id', width: 96, render: (v: string) => <span className="mono" style={{ fontSize: 12 }}>{v}</span> },
                { title: '原因', dataIndex: 'reason' },
              ]}
            />
            <div className="sub" style={{ fontSize: 12, marginTop: 6 }}>
              裁撤条目同时写进审计 <span className="mono">anomaly.suppressed</span>，导出 CSV 里以 <span className="mono">outcome=suppressed</span> 同表保留——只导出命中的那几条，等于把"没有信号"洗成"没有异常"。
            </div>
          </div>

          <div className="section">
            <h4>转写原文与分角色置信度（共 {r.turns.length} 轮）</h4>
            <div style={{ maxHeight: 260, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {r.turns.map((t) => {
                const low = t.diar_confidence !== null && t.diar_confidence < 0.8;
                return (
                  <div
                    key={t.ts}
                    style={{
                      fontSize: 12.5, display: 'flex', gap: 8,
                      borderLeft: `3px solid ${t.speaker === 'subject' ? '#1664ff' : '#dfe3ea'}`,
                      borderStyle: low ? 'dashed' : 'solid', borderLeftWidth: 3, paddingLeft: 8,
                    }}
                  >
                    <span className="mono sub" style={{ width: 40 }}>{t.ts}s</span>
                    <Tooltip title={`pyannote 分离置信度 ${t.diar_confidence ?? '—'}${low ? '（低于 0.80，采纳前请回放核对；角色判定为推断而非事实）' : ''}`}>
                      <b style={{ width: 34 }}>{t.speaker === 'subject' ? '答' : '问'}</b>
                    </Tooltip>
                    <span style={{ flex: 1 }}>{t.text}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      <div style={{ marginTop: 14, paddingTop: 8, borderTop: '1px dashed #b9c6de', fontSize: 11.5, color: '#3d4a63' }}>
        本系统输出行为风险提示，不构成临床心理诊断；所有结论为模型推断，最终判断由现场人员与后方分析师共同作出。
        本页数据来自演示脚本回放，未接入真实模型权重。
      </div>

      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        width={600}
        title={detail ? `${detail.id} · ${detail.type}` : ''}
        extra={detail && <Tag color={detail.severity === 'ESCALATED' ? 'error' : detail.severity === 'ALERT' ? 'volcano' : 'orange'}>{detail.severity}</Tag>}
        styles={{ body: { background: '#fff' } }}
        footer={
          detail && (
            <div className="row">
              <Button type="primary" onClick={() => setCausal(detail)}>跨模态因果链</Button>
              <Button onClick={() => { setDetail(null); nav('/t/workstation/reports'); }}>前往报告</Button>
              <Button onClick={() => setDetail(null)}>关闭</Button>
            </div>
          )
        }
      >
        {detail && (
          <>
            {detail.cap_note && (
              <Alert type="info" showIcon style={{ marginBottom: 10 }} message="本条为扩展信号产物" description={<span style={{ fontSize: 12 }}>{detail.cap_note}</span>} />
            )}
            <div className="sub" style={{ fontSize: 11.5, marginBottom: 8 }}>
              证据素材：{(detail.source_assets ?? []).map((a) => `${a.name}（${ASSET_KIND_LABEL[a.kind]}）`).join(' + ') || '未在素材表登记'}
            </div>
            <AttributionView a={detail.attribution} type={detail.type} />
          </>
        )}
      </Drawer>

      <Drawer open={!!causal} onClose={() => setCausal(null)} width={560} title={causal ? `${causal.id} 跨模态因果链` : ''}>
        {causal && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <CausalTimeline a={causal.attribution} />
            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <AttributionView a={causal.attribution} type={causal.type} />
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
