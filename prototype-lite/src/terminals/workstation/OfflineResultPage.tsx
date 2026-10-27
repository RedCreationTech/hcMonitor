import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Drawer, Empty, Input, InputNumber, Progress, Select, Space, Table, Tag } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { useApi, useStream } from '../../api/useStream';
import { useActor } from '../../shells/session';
import { AttributionView } from '../../components/attribution';
import { SliceCard } from './ResultSlices';
import type { AnomalyEvent, DialogueTurn, OfflineResult } from '../../shared/types';

type Topic = { asset_id: string; boundary: [number, number]; label: string };
type Review = { behavior: string; explanation: string; note: string };
type Job = { id: string; status: string; progress: number; stage: string; error?: string };
const decisions: Record<string,string> = { confirmed: '行为成立', rejected: '不支持', abstain: '弃权', supported: '支持解释' };
const roleLabel = { interviewer: '访谈员', subject: '受访者', unknown: '未知', overlap: '重叠' };
export function OfflineResultPage() {
  const { id } = useParams(); const api = useApi(); const { message } = App.useApp(); const { actor } = useActor(); const nav = useNavigate(); const { state } = useStream('workstation');
  const s = state?.sessions.find(s => s.id === id); const [history, setHistory] = useState<Array<{ id: string; status: string }>>([]); const [jobs, setJobs] = useState<Job[]>([]);
  const [old, setOld] = useState<OfflineResult>(); const result = old ?? s?.offline;
  const [turns, setTurns] = useState<DialogueTurn[]>([]); const [topics, setTopics] = useState<Topic[]>([]); const [base, setBase] = useState<number>(); const [dirty, setDirty] = useState(false);
  const [sensor, setSensor] = useState<{ id: string; name: string; time: number }>();
  const [asset, setAsset] = useState(''); const media = useRef<HTMLVideoElement>(null); const seekTo = useRef(0); const [cursor, setCursor] = useState(0);
  const [detail, setDetail] = useState<AnomalyEvent>(); const [review, setReview] = useState<Review>({ behavior: 'abstain', explanation: 'abstain', note: '' }); const [reviewing, setReviewing] = useState(false); const [reviews, setReviews] = useState<Record<string, Review>>({});
  const canEdit = actor?.role === 'analyst' && !old && !s?.offline_job; const canReview = actor?.role === 'reviewer' && !old && !s?.stale;
  const reload = () => { if (!s) return; void api<typeof history>(`/sessions/${s.id}/runs`).then(setHistory); void api<Job[]>(`/sessions/${s.id}/jobs`).then(setJobs); if (result?.run_id) void api<Record<string, Review>>(`/runs/${result.run_id}/reviews`).then(setReviews); };
  useEffect(reload, [s?.id, s?.offline_job?.id, s?.offline_job?.progress, s?.offline_job?.stage, s?.offline_job?.status, result?.run_id]);
  useEffect(() => {
    if (!s || !result || dirty) return;
    setTurns(old ? result.turns : s.corrections?.turns ?? result.turns); setTopics((old ? undefined : s.corrections?.topics) ?? result.impacts.map(i => ({ asset_id: (i as unknown as Topic).asset_id ?? s.primary_asset_id!, label: i.label, boundary: i.boundary })));
    setBase(s.revision); if (!asset) setAsset(s.primary_asset_id ?? s.assets?.[0]?.id ?? '');
  }, [result?.run_id, s?.revision, dirty]);
  useEffect(() => { const listener = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); }; window.addEventListener('beforeunload', listener); return () => window.removeEventListener('beforeunload', listener); }, [dirty]);
  if (!s) return <div className="page"><Empty description="任务不存在、用途已受限或尚未取得分派权限" /></div>;
  const execute = async (path: string, body: unknown = {}) => { try { await api(path, body); reload(); message.success('操作已保存'); } catch (e) { message.error((e as Error).message); } };
  const start = () => execute(`/sessions/${s.id}/analyze-offline`, { request_key: `${s.id}-${s.revision}-${Date.now()}` });
  const seek = (aid: string, time: number) => { const source = s.assets?.find(a => a.id === aid); if (source && !['audio','video'].includes(source.kind)) { media.current?.pause(); setSensor({id: aid, name: source.name, time}); setCursor(time); setTimeout(() => document.getElementById('slice-' + aid)?.scrollIntoView({block: 'center', behavior: 'smooth'}), 0); return; } setSensor(undefined); seekTo.current = time; setCursor(time); if (aid === asset && media.current) media.current.currentTime = time; else setAsset(aid); };
  const changeTurn = (index: number, patch: Partial<DialogueTurn>) => { setDirty(true); setTurns(prev => prev.map((t, i) => i === index ? { ...t, ...patch } : t)); };
  const save = async () => {
    try { const r = await api<{ revision: number }>(`/sessions/${s.id}/corrections`, { revision: base, turns, topics }); setBase(r.revision); setDirty(false); message.success('已保存修订；请创建新运行，旧结果保留'); }
    catch (e) { message.error((e as Error).message + '；本地编辑已保留'); }
  };
  const split = (index: number) => { const t = turns[index]; const mid = (t.ts + (t.end ?? t.ts)) / 2; if (mid <= t.ts) return; const point = Math.max(1, Math.floor(t.text.length / 2)); const a = { ...t, end: mid, text: t.text.slice(0, point) }; const b = { ...t, id: 'T-' + crypto.randomUUID().slice(0, 8), ts: mid, text: t.text.slice(point) || '待校正' }; setTurns([...turns.slice(0, index), a, b, ...turns.slice(index + 1)]); setDirty(true); };
  const merge = (index: number) => { const a = turns[index], b = turns[index + 1]; if (!b || a.asset_id !== b.asset_id || a.speaker !== b.speaker) return message.warning('只可合并同素材、同角色的相邻轮次'); setTurns([...turns.slice(0, index), { ...a, end: b.end, text: a.text + b.text }, ...turns.slice(index + 2)]); setDirty(true); };
  const selectedAsset = s.assets?.find(a => a.id === asset);
  return <div className="page"><div className="page-head"><Button onClick={() => { if (!dirty || window.confirm('尚有未保存修订，确定离开？')) nav('/t/workstation'); }}>返回任务</Button><h3>证据工作区</h3><span>{s.subject_code} · {s.scene}</span><span className="grow" />{actor?.role === 'analyst' && <Button type="primary" disabled={!!s.offline_job || dirty} onClick={start}>{s.stale ? '按修订重算' : '开始 / 重试分析'}</Button>}<Button onClick={() => nav(`/t/workstation/reports?session=${s.id}`)}>版本报告</Button></div>
    {s.stale && <Alert type="warning" message="以下算法结果来自旧修订，不能送审或发布；请完成重算和重新复核。" />}
    {old && <Alert type="info" message="正在查看不可变历史运行；校正与复核操作关闭。" action={<Button onClick={() => setOld(undefined)}>返回当前运行</Button>} />}
    {s.offline_job && <Card size="small"><p>{s.offline_job.status === 'queued' ? '排队中' : '正在分析'} · {s.offline_job.stage}</p><Progress percent={s.offline_job.progress} /><p className="sub">此处显示阶段进度，不代表剩余时间；本地模型加载或长步骤期间，百分比会暂时保持不变。</p><Button onClick={() => execute(`/jobs/${s.offline_job!.id}/cancel`)}>请求取消</Button></Card>}
    <Space style={{ margin: '12px 0' }}><Select style={{ width: 400 }} placeholder="历史运行" value={old?.run_id} allowClear onClear={() => setOld(undefined)} options={history.map(r => ({ value: r.id, label: `${r.id} · ${r.status}` }))} onChange={async rid => { if (rid) { const r = await api<{ result?: OfflineResult }>(`/runs/${rid}`); if (r.result) { setDirty(false); setOld(r.result); setTurns(r.result.turns); setTopics(r.result.impacts.map(t => ({ ...t, asset_id: (t as unknown as Topic).asset_id }))); } else message.info('此运行没有成功结果'); } }} /><Button onClick={reload}>刷新作业</Button></Space>
    {jobs.filter(j => j.error).slice(-3).map(j => <Alert key={j.id} type="error" message={`${j.status} · ${j.error}`} />)}
    {!result ? <Empty description="素材封存后开始分析；失败或中断不会生成成功报告" /> : <>
      <Card title="证据回看 · 文件内时间游标" size="small"><Select style={{ width: '100%' }} value={asset} onChange={a => seek(a, 0)} options={s.assets?.filter(a => ['audio', 'video'].includes(a.kind)).map(a => ({ value: a.id, label: a.name }))} />
        {sensor && <Alert type="info" message={`采样文件 ${sensor.name} · 文件内游标 ${sensor.time.toFixed(2)} 秒`} description="已定位对应趋势切片；采样文件不按音视频解码。" action={<Button onClick={() => { setSensor(undefined); setCursor(seekTo.current); }}>返回音视频</Button>} />}
        {selectedAsset && !sensor && <video ref={media} controls preload="metadata" aria-label="原始证据播放器" src={`/v1/sessions/${s.id}/assets/${asset}/media`} style={{ display: 'block', width: '100%', maxHeight: selectedAsset.kind === 'audio' ? 80 : 360, background: '#111', marginTop: 12 }} onLoadedMetadata={() => { if (media.current) media.current.currentTime = seekTo.current; }} onTimeUpdate={() => setCursor(media.current?.currentTime ?? 0)} onError={() => message.warning('原件不可访问，请核对授权与网络')} />}<span>当前游标 {cursor.toFixed(2)} 秒 · 各素材独立时轴</span>
      </Card>
      <Card title="逐句转写与匿名角色校正" size="small" style={{ marginTop: 12 }} extra={<Space>{dirty && <Tag color="orange">本地草稿未保存</Tag>}<Button disabled={!canEdit || !dirty} onClick={save}>保存修订</Button><Button disabled={!dirty} onClick={() => { setDirty(false); setTurns(s.offline?.turns ?? []); }}>放弃本地编辑</Button></Space>}>
        <p className="sub">匿名声纹不等于已确认身份。未知与重叠不计入个人基线或解释；分割默认取中点，保存前可调整时间和文字。保存后全链重算。</p>
        <Table rowKey={t => t.id ?? `${t.asset_id}-${t.ts}`} dataSource={turns} size="small" pagination={{ pageSize: 8 }} scroll={{ x: 1080 }} columns={[
          { title: '定位 / 声纹', render: (_, t) => <><Button size="small" onClick={() => seek(t.asset_id ?? s.primary_asset_id!, t.ts)}>{t.ts.toFixed(2)}s</Button><div>{t.speaker_id ?? '未分离'}</div></> },
          { title: '起止秒', render: (_, t) => <Space direction="vertical"><InputNumber aria-label="轮次开始秒" min={0} value={t.ts} disabled={!canEdit} onChange={v => changeTurn(turns.findIndex(x => x.id === t.id), { ts: v ?? 0 })} /><InputNumber aria-label="轮次结束秒" min={0} value={t.end} disabled={!canEdit} onChange={v => changeTurn(turns.findIndex(x => x.id === t.id), { end: v ?? 0 })} /></Space> },
          { title: '已确认角色', render: (_, t) => <Select style={{ width: 110 }} value={t.speaker} disabled={!canEdit} options={Object.entries(roleLabel).map(([value, label]) => ({ value, label }))} onChange={role => changeTurn(turns.findIndex(x => x.id === t.id), { speaker: role, participant_id: s.participants?.find(p => p.role === role)?.id ?? null })} /> },
          { title: '转写文字', width: 420, render: (_, t) => <Input.TextArea aria-label="转写文字" value={t.text} disabled={!canEdit} onChange={e => changeTurn(turns.findIndex(x => x.id === t.id), { text: e.target.value })} autoSize={{ minRows: 2, maxRows: 5 }} /> },
          { title: '操作', render: (_, t) => <Space><Button disabled={!canEdit} onClick={() => split(turns.findIndex(x => x.id === t.id))}>分割</Button><Button disabled={!canEdit} onClick={() => merge(turns.findIndex(x => x.id === t.id))}>合并下一句</Button></Space> },
        ]} />
      </Card>
      <Card title="话题边界与文件内相对影响" size="small" style={{ marginTop: 12 }}><Table rowKey={(_, i) => String(i)} dataSource={topics} size="small" pagination={{ pageSize: 6 }} columns={[
        { title: '标题', render: (_, t) => <Input value={t.label} disabled={!canEdit} onChange={e => { setTopics(topics.map((x) => x === t ? { ...x, label: e.target.value } : x)); setDirty(true); }} /> },
        { title: '边界秒', render: (_, t) => <Space>{t.boundary.map((v, k) => <InputNumber key={k} aria-label={k ? '话题结束秒' : '话题开始秒'} value={v} disabled={!canEdit} onChange={v => { setTopics(topics.map((x) => { if (x !== t) return x; const bound: [number, number] = [...x.boundary]; bound[k] = v ?? 0; return { ...x, boundary: bound }; })); setDirty(true); }} />)}</Space> },
        { title: '回看 / 公式', render: (_, t) => <><Button onClick={() => seek(t.asset_id, t.boundary[0])}>回看</Button><div className="sub">时长占比 × (1+情感翻转) × (1+矛盾对数)，按文件内最大值归一</div></> },
      ]} /><p className="sub">当前运行指数：{result.impacts.map(i => `${i.label}: ${i.impact_score}`).join('；')}。修订后才重算，不将关联排序解释为因果。</p></Card>
      <Card title="候选事件 · 行为与解释独立复核" size="small" style={{ marginTop: 12 }}><Table rowKey="id" dataSource={result.anomalies} size="small" columns={[
        { title: '时刻', render: (_, e) => <Button onClick={() => seek(e.source_assets?.[0]?.id ?? asset, e.ts)}>{e.ts}s</Button> }, { title: '观察', dataIndex: 'type' }, { title: '等级', dataIndex: 'severity', render: (v: string) => ({ INFO: '观察', WARN: '关注', ALERT: '明显变化', ESCALATED: '多模态变化' } as Record<string,string>)[v] },
        { title: '复核', render: (_, e) => reviews[e.id] ? `${decisions[reviews[e.id].behavior]} / ${decisions[reviews[e.id].explanation]}` : '待独立复核' },
        { title: '证据链', render: (_, e) => <Button onClick={() => { setDetail(e); setReview(reviews[e.id] ?? { behavior: 'abstain', explanation: 'abstain', note: '' }); }}>查看与复核</Button> },
      ]} /></Card>
      <Alert style={{ margin: '12px 0' }} type={result.narrative?.status === 'generated' ? 'success' : 'warning'} message={'本地叙述：' + result.narrative?.status} description={result.narrative?.text || result.narrative?.reason} />
      {result.slices.map(sl => <SliceCard key={sl.asset_id} slice={sl} onEvent={eid => setDetail(result.anomalies.find(e => e.id === eid))} />)}
      <details><summary>运行与来源清单</summary><pre style={{ overflow: 'auto' }}>{JSON.stringify(result.manifest, null, 2)}</pre></details>
    </>}
    <Drawer open={!!detail} onClose={() => setDetail(undefined)} width={640} title="观察、候选规则与专家决定">
      {detail && <><AttributionView a={detail.attribution} type={detail.type} />{detail.cap_note && <Alert type="warning" message={detail.cap_note} />}
        <p>行为判断</p><Select aria-label="行为判断" disabled={!canReview} style={{ width: '100%' }} value={review.behavior} onChange={behavior => setReview({ ...review, behavior })} options={[{ value: 'confirmed', label: '行为成立' }, { value: 'rejected', label: '行为不成立' }, { value: 'abstain', label: '行为弃权' }]} />
        <p>候选解释判断</p><Select aria-label="解释判断" disabled={!canReview} style={{ width: '100%' }} value={review.explanation} onChange={explanation => setReview({ ...review, explanation })} options={[{ value: 'supported', label: '支持候选解释' }, { value: 'rejected', label: '不支持候选解释' }, { value: 'abstain', label: '解释弃权' }]} />
        <p>复核理由与替代解释</p><Input.TextArea aria-label="复核理由" disabled={!canReview} value={review.note} onChange={e => setReview({ ...review, note: e.target.value })} rows={4} />
        <Button type="primary" style={{ marginTop: 12 }} loading={reviewing} disabled={!canReview || !review.note.trim()} onClick={async () => { setReviewing(true); try { await api(`/sessions/${s.id}/events/${detail.id}/review`, { ...review, run_id: result?.run_id }); reload(); message.success('独立复核已留痕'); setDetail(undefined); } catch (e) { message.error((e as Error).message); } finally { setReviewing(false); } }}>保存分层决定</Button></>}
    </Drawer>
  </div>;
}
