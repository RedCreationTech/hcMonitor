import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Empty, Input, Modal, Select, Space, Table, Tag, Checkbox } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi, useStream } from '../../api/useStream';
import { useActor } from '../../shells/session';
import type { Report } from '../../shared/types';

const labels = { drafting: '起草中', pending_review: '待独立批准', approved: '已批准', rejected: '已驳回', published: '已发布' };
export function ReportsPage() {
  const api = useApi(); const { message } = App.useApp(); const { state } = useStream('workstation'); const { actor } = useActor(); const nav = useNavigate(); const [params] = useSearchParams();
  const [id, setId] = useState(''); const [sections, setSections] = useState<Report['sections']>([]); const [dirty, setDirty] = useState(false); const [base, setBase] = useState<number>(); const [note, setNote] = useState('');
  const [grantOpen, setGrantOpen] = useState(false); const [recipients, setRecipients] = useState<string[]>(['READ-01']); const [purpose, setPurpose] = useState('内部复核归档'); const [actions, setActions] = useState<string[]>(['read']); const [expiry, setExpiry] = useState(() => { const date = new Date(Date.now() + 7 * 86400000); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); });
  const [readSections, setReadSections] = useState<Report['sections']>([]);
  const [grantId, setGrantId] = useState<string>(); const [result, setResult] = useState(''); const [busy, setBusy] = useState(false);
  const reports = (state?.reports ?? []).filter(r => !params.get('session') || r.session_id === params.get('session'));
  const current = reports.find(r => r.id === id) ?? reports[reports.length - 1];
  const editable = actor?.role === 'analyst' && current && ['drafting', 'rejected'].includes(current.status);
  useEffect(() => { if (current && !dirty) { setSections(current.sections); setBase(current.revision); } }, [current?.id, current?.revision, dirty]);
  useEffect(() => { setResult(''); setGrantId(undefined); }, [current?.id]);
  useEffect(() => { let active = true; setReadSections([]); if (actor?.role === 'reader' && current) void api<{ sections: Report['sections'] }>(`/reports/${current.id}/read`).then(r => { if (active) setReadSections(r.sections); }).catch(e => message.error((e as Error).message)); return () => { active = false; }; }, [current?.id, current?.content_hash, actor?.role, api]);
  const ownGrants = current?.grants?.filter(g => g.recipient === actor?.id && !g.revoked && g.expires_at > Date.now() / 1000) ?? [];
  const grant = ownGrants.find(g => g.id === grantId) ?? ownGrants[0];
  const act = async (action: string, body: unknown = {}) => {
    if (!current) return;
    try { setBusy(true); await api(`/reports/${current.id}/${action}`, body); message.success('操作已保存'); } catch (e) { message.error((e as Error).message); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!current) return;
    let revision = base;
    try {
      setBusy(true);
      for (const sec of sections) {
        if (sec.text !== current.sections.find(s => s.key === sec.key)?.text) {
          const r = await api<{ revision: number }>(`/reports/${current.id}/section`, { ...sec, revision }); revision = r.revision; setBase(revision);
        }
      }
      setDirty(false); message.success('报告修订已保存');
    } catch (e) { message.error((e as Error).message + '；本地编辑保留，请核对服务端最新版本后再合并'); }
    finally { setBusy(false); }
  };
  const exportFile = async (format: string, print = false) => {
    if (!current || !grant) return;
    try {
      setBusy(true); const r = await api<{ url: string; hash: string; filename: string }>(`/reports/${current.id}/export`, { format, mode: print ? 'print' : 'file', grant_id: grant.id, purpose: grant.purpose });
      const response = await fetch(r.url); if (!response.ok) { const e = await response.json(); throw new Error(e.message); }
      const blob = await response.blob(); const url = URL.createObjectURL(blob);
      if (print) { const w = window.open(url); if (!w) throw new Error('请允许打印窗口，生成记录仍可在审计中查询'); w.addEventListener('load', () => { w.focus(); w.print(); }); }
      else { const a = document.createElement('a'); a.href = url; a.download = r.filename; a.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 60000); setResult(`${r.filename} · SHA256 ${r.hash}`);
    } catch (e) { message.error((e as Error).message); } finally { setBusy(false); }
  };
  return <div className="page"><div className="page-head"><h3>{actor?.role === 'reader' ? '获授权报告阅读' : '版本报告 · 编制、批准与发布'}</h3><span className="grow" /><Button onClick={() => nav('/t/workstation')}>任务台</Button></div>
    <Table rowKey="id" size="small" dataSource={reports} onRow={r => ({ onClick: () => { if (!dirty || window.confirm('放弃未保存报告编辑？')) { setDirty(false); setId(r.id); } } })} columns={[
      { title: '报告版本', render: (_, r) => <Button type="link">{r.id} / v{r.version ?? 1}</Button> }, { title: '对象', dataIndex: 'subject_code' }, { title: '标题', dataIndex: 'title' },
      { title: '状态', render: (_, r) => <Tag color={r.status === 'published' ? 'green' : 'blue'}>{labels[r.status]}</Tag> },
    ]} />
    {!current ? <Empty description="当前范围没有可见报告；分析成功后自动起草，阅读者仅能看到获授权版本" /> : <>
      <Card title={current.title} size="small" extra={<Tag>{labels[current.status]}</Tag>}><p className="sub">版本 {current.version} · 来源 {current.source_run_id} · {current.content_hash ? `内容指纹 ${current.content_hash}` : '尚未冻结送审'}</p>
        {actor?.role !== 'reader' && <Space wrap style={{ marginBottom: 16 }}><Button onClick={() => nav(`/t/workstation/offline/${current.session_id}`)}>核对证据与逐条复核</Button>
          {editable && <><Button disabled={!dirty || busy} onClick={save}>保存报告修订</Button><Button disabled={dirty || busy} onClick={() => act('submit', { revision: base })}>提交独立批准</Button></>}
          {actor?.role === 'analyst' && ['approved', 'published'].includes(current.status) && <Button onClick={async () => { const r = await api<{ id: string }>(`/reports/${current.id}/new-version`, {}); setDirty(false); setId(r.id); }}>创建新版本</Button>}
          {actor?.role === 'reviewer' && current.status === 'pending_review' && <><Button type="primary" loading={busy} onClick={() => act('approve')}>批准此内容版本</Button><Input aria-label="驳回理由" placeholder="驳回理由" style={{ width: 240 }} value={note} onChange={e => setNote(e.target.value)} /><Button danger disabled={!note.trim() || busy} onClick={() => act('reject', { note })}>驳回</Button></>}
          {actor?.role === 'reviewer' && ['approved', 'published'].includes(current.status) && <Button type="primary" onClick={() => setGrantOpen(true)}>{current.status === 'approved' ? '发布并授予版本权限' : '新增版本授权'}</Button>}
        </Space>}
        {dirty && <Alert type="warning" message="本地编辑未保存；发生冲突会保留文字，提交前须核对最新修订。" />}
        {(editable ? sections : actor?.role === 'reader' ? readSections : current.sections).map(sec => <div key={sec.key} style={{ marginBottom: 18 }}><h4>{sec.title}</h4>{editable ? <Input.TextArea aria-label={sec.title} value={sec.text} autoSize={{ minRows: 2, maxRows: 10 }} onChange={e => { setSections(sections.map(s => s.key === sec.key ? { ...s, text: e.target.value } : s)); setDirty(true); }} /> : <p style={{ whiteSpace: 'pre-wrap' }}>{sec.text}</p>}</div>)}
      </Card>
      {actor?.role !== 'reader' && current.preview_sections && <details style={{margin: '12px 0'}}><summary>完整冻结稿（含证据、复核和方法附件）</summary>{current.preview_sections.map(sec => <section key={sec.key}><h4>{sec.title}</h4><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{sec.text}</p></section>)}</details>}
      {current.status === 'published' && <Card size="small" title="指定版本的阅读、下载与打印" style={{ marginTop: 12 }}>
        {ownGrants.length ? <><Select aria-label="选择用途授权" style={{ minWidth: 360, marginBottom: 12 }} value={grant?.id} onChange={setGrantId} options={ownGrants.map(g => ({ value: g.id, label: `${g.purpose} · 截止 ${new Date(g.expires_at * 1000).toLocaleString()}` }))} />
          <Space wrap><Button onClick={async () => { await api(`/reports/${current.id}/read`); message.success('阅读权限已核验并留痕'); }}>核验本次阅读</Button>{['pdf', 'html', 'csv'].map(fmt => <Button key={fmt} loading={busy} disabled={!grant?.actions.includes('download')} onClick={() => exportFile(fmt)}>下载 {fmt.toUpperCase()}</Button>)}<Button loading={busy} disabled={!grant?.actions.includes('print')} onClick={() => exportFile('pdf', true)}>生成打印件</Button></Space>
          {result && <Alert style={{ marginTop: 12 }} type="success" message="已按授权交付文件" description={<span style={{ overflowWrap: 'anywhere' }}>{result}</span>} />}</> : <Alert type="info" message="你没有此版本的接收人授权；可由指定复核人新增用途、动作和有效期。" />}
        {actor?.role === 'reviewer' && <Table style={{ marginTop: 12 }} rowKey="id" size="small" dataSource={current.grants} columns={[{ title: '接收人', dataIndex: 'recipient' }, { title: '用途', dataIndex: 'purpose' }, { title: '动作', render: (_, g) => g.actions.join(' / ') }, { title: '状态', render: (_, g) => g.revoked ? '已撤销' : new Date(g.expires_at * 1000).toLocaleString() }, { title: '操作', render: (_, g) => <Button danger disabled={g.revoked} onClick={() => act(`grants/${g.id}/revoke`)}>撤销</Button> }]} />}
      </Card>}
      {actor?.role !== 'reader' && <Card size="small" title="修订与审批流水" style={{ marginTop: 12 }}>{current.revisions.map((r, i) => <p key={i}>{r.ts} · {r.actor} · {r.action} {r.note}</p>)}</Card>}
    </>}
    <Modal title={current?.status === 'approved' ? '发布并授予此版本权限' : '新增授权'} open={grantOpen} onCancel={() => setGrantOpen(false)} confirmLoading={busy} onOk={async () => {
      if (!current) return; try { setBusy(true); await api(`/reports/${current.id}/${current.status === 'approved' ? 'publish' : 'grants'}`, { grants: recipients.map(recipient => ({ recipient, purpose, actions, expires_at: new Date(expiry).getTime() / 1000 })) }); setGrantOpen(false); message.success('版本权限已保存'); } catch (e) { message.error((e as Error).message); } finally { setBusy(false); }
    }}><p>接收人</p><Select mode="multiple" aria-label="接收人" style={{ width: '100%' }} value={recipients} onChange={setRecipients} options={state?.members.filter(m => ['reader', 'analyst', 'reviewer'].includes(m.role)).map(m => ({ value: m.id, label: `${m.name} ${m.id}` }))} /><p>用途</p><Input aria-label="授权用途" value={purpose} onChange={e => setPurpose(e.target.value)} /><p>允许动作</p><Checkbox.Group value={actions} onChange={values => setActions(values as string[])} options={[{ value: 'read', label: '阅读' }, { value: 'download', label: '下载' }, { value: 'print', label: '打印' }]} /><p>截止时间（本机时区）</p><input aria-label="授权截止时间" type="datetime-local" value={expiry} onChange={e => setExpiry(e.target.value)} /><p className="sub">同一有效授权内可重复领取；每次生成与领取仍核验并记录。扩大用途、人员、动作或版本需新增授权。</p></Modal>
  </div>;
}
