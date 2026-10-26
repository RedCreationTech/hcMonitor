import { Alert, Button, Card, Table, Tag, Tooltip } from 'antd';
import type { ModalityKey, OfflineSlice } from '../../shared/types';
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
export function SliceCard({ slice, onEvent }: { slice: OfflineSlice; onEvent: (id: string) => void }) {
  const ext = slice.role === 'extension';
  return (
    <Card
      id={'slice-' + slice.asset_id}
      size="small"
      style={{ marginBottom: 10, borderColor: ext ? '#adc6ff' : undefined }}
      title={
        <span style={{ fontSize: 12.5 }}>
          <b className="mono">{slice.asset_name}</b>
          <Tag color={ext ? 'geekblue' : 'blue'} style={{ marginLeft: 8 }}>{ASSET_KIND_LABEL[slice.kind]}</Tag>
          <Tag color={ext ? 'warning' : 'processing'}>{ext ? '扩展信号 · 只到生理趋势层' : '主信号 · 按质量与归属门控'}</Tag>
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
                    : '本素材可解析该通道；判断范围以质量记录为准'
                  : '该通道未获得可用结果（信号缺失或质量不足），不产出结论或 0 值'
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
          <span className="sub mono">本素材没有产生可上报事件，请结合质量与能力说明核对</span>
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
