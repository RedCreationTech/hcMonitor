import { useState } from 'react';
import type { Attribution, FusionTick, ImpactEvent, ModalityKey } from '../shared/types';
import { MODALITY_LABEL } from '../../mock/script';

const SERIES: Array<{ key: 'emotion' | 'tension' | 'arousal'; label: string; color: string }> = [
  { key: 'emotion', label: '情绪强度', color: '#fa8c16' },
  { key: 'tension', label: '紧张度', color: '#ff4d4f' },
  { key: 'arousal', label: '唤醒度', color: '#1664ff' },
];

const DIM_KEYS = ['情绪冲击', '认知冲突', '利益相关', '持续影响'] as const;
const DIM_SHORT: Record<(typeof DIM_KEYS)[number], string> = { 情绪冲击: '情绪', 认知冲突: '认知', 利益相关: '利益', 持续影响: '持续' };
const DIM_COLORS = ['#fa8c16', '#ff4d4f', '#1664ff', '#722ed1'];

/** 仅分析壳使用：现场壳不得出现任何曲线 */
export function RiskCurve({ points, markers = [], firstTs = 0 }: { points: FusionTick[]; markers?: number[]; firstTs?: number }) {
  const slice = points.slice(-160);
  const W = 600;
  const H = 150;
  const x = (i: number) => (slice.length < 2 ? 0 : (i / (slice.length - 1)) * W);
  // 动态值域：曲线实际落在 20~60 区间，固定 0~100 会把上半张图空出来
  const peak = Math.max(40, ...slice.flatMap((p) => SERIES.map((s) => p[s.key])));
  const top = Math.min(100, Math.ceil(peak / 20) * 20);
  const y = (v: number) => H - (v / top) * (H - 8) - 4;
  const last = slice[slice.length - 1]?.ts ?? firstTs;
  const domain = Math.max(1, last - firstTs);
  const mx = (ts: number) => ((ts - firstTs) / domain) * W;
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <svg className="curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ flex: 1 }}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={y(top * f)} y2={y(top * f)} stroke="#eef0f4" strokeWidth={1} />
        ))}
        {markers.filter((m) => m >= firstTs && m <= last).map((m, i) => (
          <g key={`m${i}`}>
            <line x1={mx(m)} x2={mx(m)} y1={0} y2={H} stroke="#874d00" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
            <polygon points={`${mx(m) - 4},0 ${mx(m) + 4},0 ${mx(m)},6`} fill="#fa8c16" />
          </g>
        ))}
        {SERIES.map((s) => (
          <polyline
            key={s.key}
            fill="none"
            stroke={s.color}
            strokeWidth={1.6}
            points={slice.map((p, i) => `${x(i)},${y(p[s.key])}`).join(' ')}
          />
        ))}
      </svg>
      <div className="row" style={{ gap: 14, fontSize: 11.5 }}>
        {SERIES.map((s) => (
          <span key={s.key} className="row" style={{ gap: 5 }}>
            <i style={{ width: 10, height: 2, background: s.color, display: 'inline-block' }} />
            <span className="sub">{s.label}</span>
          </span>
        ))}
        <span className="sub grow" style={{ textAlign: 'right' }}>纵轴 0–{top} · 融合权重按可用模态动态归一</span>
      </div>
    </div>
  );
}

/** 三级可解释归因：观察层 → 中间层（候选规则 + 文献）→ 结论层（置信度 + 反事实 + 免责） */
export function AttributionView({ a, type }: { a: Attribution; type: string }) {
  const hits = a.candidate_rules.filter((r) => r.hit).length;
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const rail = [
    { id: 'L1', label: 'L1 观察', value: `${a.observation.length} 条`, color: '#1664ff' },
    { id: 'L2', label: 'L2 规则', value: `${hits}/${a.candidate_rules.length} 命中`, color: '#722ed1' },
    { id: 'L3', label: 'L3 结论', value: a.conclusion.confidence.toFixed(2), color: '#cf1322' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 链条进度指示：先看清"结论是由几层推出来的"，再逐层展开 */}
      <div className="row" style={{ gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        {rail.map((r, i) => (
          <span key={r.id} className="row" style={{ gap: 4 }}>
            {i > 0 && <span className="sub" style={{ fontSize: 13 }}>→</span>}
            <button
              onClick={() => jump(`at-${r.id}`)}
              style={{
                cursor: 'pointer', border: `1px solid ${r.color}`, color: r.color, background: '#fff',
                borderRadius: 12, padding: '2px 9px', fontSize: 11.5, lineHeight: 1.6,
              }}
            >
              {r.label} <b className="mono">{r.value}</b>
            </button>
          </span>
        ))}
        <span className="sub" style={{ fontSize: 11, marginLeft: 4 }}>自上而下逐层可核，点击定位</span>
      </div>

      <div id="at-L1">
        <span className="lv obs">L1 观察层</span> <b style={{ marginLeft: 6 }}>{type}</b>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {a.observation.map((o, i) => (
            <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '7px 9px', background: '#fafbfd' }}>
              <div className="row" style={{ marginBottom: 3 }}>
                <span className="pill">{MODALITY_LABEL[o.modality as ModalityKey] ?? o.modality}</span>
                <span className="mono sub" style={{ fontSize: 11 }}>
                  {o.ts_from.toFixed(1)}s – {o.ts_to.toFixed(1)}s
                </span>
              </div>
              <div style={{ fontSize: 12.5 }}>{o.text}</div>
            </div>
          ))}
        </div>
      </div>

      <div id="at-L2">
        <span className="lv rule">L2 中间层</span> <span className="sub" style={{ marginLeft: 6 }}>候选规则命中</span>
        <table style={{ width: '100%', marginTop: 8, borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: 'var(--sub)', textAlign: 'left' }}>
              <th style={{ padding: '4px 6px', fontWeight: 500 }}>规则</th>
              <th style={{ padding: '4px 6px', fontWeight: 500 }}>心理状态假设</th>
              <th style={{ padding: '4px 6px', fontWeight: 500, width: 56 }}>权重</th>
              <th style={{ padding: '4px 6px', fontWeight: 500, width: 44 }}>命中</th>
            </tr>
          </thead>
          <tbody>
            {a.candidate_rules.map((r) => (
              <tr key={r.rule_id} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ padding: '6px' }}>
                  <div className="mono" style={{ fontSize: 11.5 }}>{r.rule_id}</div>
                  <div className="sub mono" style={{ fontSize: 10.5 }}>{r.pattern}</div>
                  <div className="sub" style={{ fontSize: 10.5 }}>文献：{r.literature_ref}</div>
                </td>
                <td style={{ padding: '6px' }}>{r.psych_state}</td>
                <td style={{ padding: '6px' }}>{r.weight.toFixed(2)}</td>
                <td style={{ padding: '6px' }}>{r.hit ? '✅' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div id="at-L3">
        <span className="lv concl">L3 结论层</span>
        <div style={{ marginTop: 8, border: '1px solid #d3adf7', background: '#f9f0ff', borderRadius: 8, padding: 10 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>{a.conclusion.psych_state}</div>
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <div style={{ flex: 1, height: 8, borderRadius: 4, background: '#e6dcf5', overflow: 'hidden' }}>
              <i style={{ display: 'block', height: '100%', width: `${a.conclusion.confidence * 100}%`, background: '#722ed1' }} />
            </div>
            <b className="mono" style={{ fontSize: 12 }}>{a.conclusion.confidence.toFixed(2)}</b>
          </div>
          <div className="sub" style={{ fontSize: 12, marginTop: 8 }}>
            <b>反事实：</b>
            {a.conclusion.counterfactual}
          </div>
          <div className="sub" style={{ fontSize: 11.5, marginTop: 4 }}>⚠ {a.conclusion.disclaimer}</div>
        </div>
      </div>
    </div>
  );
}

/** S-06 跨模态因果链：把同一升级窗口内的观察按时间排开 */
export function CausalTimeline({ a }: { a: Attribution }) {
  const [from, to] = (() => {
    const all = a.observation.flatMap((o) => [o.ts_from, o.ts_to]);
    return [Math.min(...all), Math.max(...all)];
  })();
  const span = Math.max(1, to - from);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="sub" style={{ fontSize: 11.5 }}>
        聚合窗口 {from.toFixed(1)}s – {to.toFixed(1)}s（{span.toFixed(1)}s ≤ 10s 判定条件）
      </div>
      {a.observation.map((o, i) => {
        const left = ((o.ts_from - from) / span) * 100;
        const width = Math.max(6, ((o.ts_to - o.ts_from) / span) * 100);
        return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '70px 1fr', gap: 8, alignItems: 'center' }}>
            <span className="pill" style={{ textAlign: 'center' }}>{MODALITY_LABEL[o.modality as ModalityKey] ?? o.modality}</span>
            <div style={{ position: 'relative', height: 22, background: '#f5f7fa', borderRadius: 4 }}>
              <div
                style={{
                  position: 'absolute', left: `${left}%`, width: `${width}%`, top: 7, height: 8,
                  borderRadius: 4, background: 'linear-gradient(90deg,#1677ff,#9254de)',
                }}
                title={o.text}
              />
            </div>
          </div>
        );
      })}
      <div className="hint" style={{ color: 'var(--sub)' }}>
        同窗命中模态数 ≥3 触发 R-FUS-02 聚合升级；任一模态窗口错开 &gt;10s 则回落为单条 WARN。
      </div>
    </div>
  );
}

/** 底部话题影响带：语义影响值可视化（仅分析壳） */
export function TopicBand({ impacts, clock }: { impacts: ImpactEvent[]; clock: number }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="row" style={{ alignItems: 'stretch', gap: 6, height: '100%' }}>
      {impacts.length === 0 && <span className="sub">等待首个语义边界…</span>}
      {impacts.map((t) => {
        const active = clock >= t.boundary[0] && clock < t.boundary[1];
        const sum = DIM_KEYS.reduce((acc, k) => acc + t.dims[k], 0);
        return (
          <button
            key={t.topic_id}
            onClick={() => setOpen(open === t.topic_id ? null : t.topic_id)}
            style={{
              flex: (t.boundary[1] - t.boundary[0]) / 4, minWidth: 0, textAlign: 'left', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', justifyContent: 'flex-start',
              border: `1px solid ${active ? '#1664ff' : 'var(--line)'}`, background: active ? '#f0f6ff' : '#fafbfd',
              borderRadius: 6, padding: '8px 7px',
            }}
          >
            <div className="sub" style={{ fontSize: 10.5 }}>{t.topic_id} · 影响 {t.impact_score.toFixed(2)}</div>
            <div style={{ fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.label}</div>
            <div style={{ height: 4, borderRadius: 2, background: '#e9edf3', marginTop: 4 }}>
              <i style={{ display: 'block', height: '100%', width: `${t.impact_score * 100}%`, background: '#1664ff', borderRadius: 2 }} />
            </div>
            {/* impact = w1·情绪 + w2·认知 + w3·利益 + w4·持续：四段占比条，点开看依据 */}
            <div style={{ display: 'flex', gap: 2, marginTop: 7, height: 6 }}>
              {DIM_KEYS.map((k, i) => (
                <i key={k} title={`${k} ${t.dims[k].toFixed(2)}`} style={{ display: 'block', height: '100%', width: `${(t.dims[k] / Math.max(0.01, sum)) * 100}%`, background: DIM_COLORS[i], borderRadius: 2 }} />
              ))}
            </div>
            <div className="sub" style={{ fontSize: 10, marginTop: 5, lineHeight: 1.8 }}>
              {DIM_KEYS.map((k, i) => (
                <span key={k} style={{ marginRight: 7 }}>
                  <i style={{ display: 'inline-block', width: 5, height: 5, borderRadius: 1, background: DIM_COLORS[i], marginRight: 3 }} />
                  {DIM_SHORT[k]} {t.dims[k].toFixed(2)}
                </span>
              ))}
            </div>
            <div className="sub" style={{ fontSize: 10, marginTop: 2 }}>{active ? '正在进行' : `边界 ${t.boundary[0]}–${t.boundary[1]}s · 点击看依据`}</div>
          </button>
        );
      })}
      {open && (
        <div style={{ position: 'absolute', right: 12, bottom: 62, width: 320, background: '#fff', border: '1px solid var(--line)', borderRadius: 8, padding: 10, boxShadow: '0 8px 24px rgba(0,0,0,.08)', fontSize: 12 }}>
          {impacts.filter((t) => t.topic_id === open).map((t) => (
            <div key={t.topic_id}>
              <b>{t.label}</b>
              <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 10px' }}>
                {(Object.keys(t.dims) as Array<keyof typeof t.dims>).map((k) => (
                  <div className="row" key={k} style={{ justifyContent: 'space-between' }}>
                    <span className="sub">{k}</span>
                    <span className="mono">{t.dims[k].toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <div className="sub" style={{ marginTop: 6, lineHeight: 1.7 }}>{t.rationale_text}</div>
              {t.boundary_evidence && (
                <div className="sub" style={{ marginTop: 8, lineHeight: 1.7, borderTop: '1px dashed var(--line)', paddingTop: 6 }}>
                  <b style={{ color: 'var(--fg)' }}>边界判定：</b>
                  {t.boundary_evidence}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
