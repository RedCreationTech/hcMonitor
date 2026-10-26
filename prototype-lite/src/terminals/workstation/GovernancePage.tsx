import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Input, Select, Space, Table, Modal, Form } from 'antd';
import { useApi, useStream } from '../../api/useStream';
import { ConsentFields, participants } from './ConsentFields';
import { useActor } from '../../shells/session';
type Task = { id: string; project_id: string; owner_id: string; analyst_id: string; reviewer_id: string; restricted: boolean; revision: number };
type Member = { id: string; name: string; role: string };
export function GovernancePage() {
  const api = useApi(); const { message } = App.useApp(); const { actor } = useActor(); const { state } = useStream('workstation');
  const [consentTask, setConsentTask] = useState<Task>(); const [consentForm] = Form.useForm();
  const [data, setData] = useState<{ sessions: Task[]; users: Member[]; storage: string }>(); const [note, setNote] = useState(''); const [verify, setVerify] = useState(''); const [old, setOld] = useState(''); const [password, setPassword] = useState('');
  const load = () => { if (actor?.role === 'admin') void api<typeof data>('/admin/overview').then(setData); };
  useEffect(load, [actor?.role]);
  const assignment = async (task: Task, key: string, value: string) => { try { await api(`/admin/sessions/${task.id}/assignment`, { revision: task.revision, [key]: value }); load(); } catch (e) { message.error((e as Error).message); } };
  return <div className="page"><h3>项目分派、用途限制与审计</h3>
    <Card title="本地账号口令" size="small"><Space wrap><Input.Password aria-label="原口令" placeholder="原口令" value={old} onChange={e => setOld(e.target.value)} /><Input.Password aria-label="新口令" placeholder="新口令至少12位" value={password} onChange={e => setPassword(e.target.value)} /><Button onClick={async () => { try { await api('/auth/password', { old, password }); window.dispatchEvent(new Event('auth-expired')); } catch (e) { message.error((e as Error).message); } }}>更换口令并重新登录</Button></Space></Card>
    {actor?.role === 'admin' && <Card title="任务分派与限制" size="small" style={{ marginTop: 12 }}><Alert type="info" message={`存储 ${data?.storage ?? '…'}；不自动删除历史原件。管理员通过分派管理任务，不自动获得转写与证据读取权。`} /><Input style={{ margin: '12px 0' }} placeholder="用途限制或解除理由（必填）" value={note} onChange={e => setNote(e.target.value)} /><Table rowKey="id" dataSource={data?.sessions} columns={[
      { title: '任务', render: (_, t) => <><div>{t.id}</div><Button size="small" onClick={() => { setConsentTask(t); consentForm.resetFields(); }}>修订用途登记</Button></> }, ...(['analyst_id', 'reviewer_id'] as const).map(key => ({ title: key === 'analyst_id' ? '分析师' : '复核人', render: (_: unknown, t: Task) => <Select value={t[key]} style={{ width: 160 }} options={data?.users.filter(u => u.role === (key === 'analyst_id' ? 'analyst' : 'reviewer')).map(u => ({ value: u.id, label: `${u.name} ${u.id}` }))} onChange={v => assignment(t, key, v)} /> })),
      { title: '限制', render: (_, t) => <Button danger={!t.restricted} disabled={!note.trim()} onClick={async () => { try { await api(`/admin/sessions/${t.id}/restrict`, { restricted: !t.restricted, note }); load(); } catch (e) { message.error((e as Error).message); } }}>{t.restricted ? '解除用途限制' : '立即限制所有处理与领取'}</Button> },
    ]} /></Card>}
    {['admin', 'auditor'].includes(actor?.role ?? '') && <Card title="审计链" size="small" style={{ marginTop: 12 }}><Button onClick={async () => { const r = await api<{ chain_ok: boolean; total: number }>('/audit/verify'); setVerify(`${r.chain_ok ? '链校验通过' : '链校验失败'} · ${r.total} 条`); }}>校验审计链</Button><span>{verify}</span><Table rowKey="seq" size="small" dataSource={state?.audit} columns={[{ title: '序号', dataIndex: 'seq' }, { title: '账号', dataIndex: 'actor' }, { title: '动作', dataIndex: 'action' }, { title: '资源', dataIndex: 'resource' }]} /></Card>}
    <Modal title="修订逐人用途与告知依据" open={!!consentTask} onCancel={() => setConsentTask(undefined)} onOk={async () => {
      if (!consentTask) return; try { const v = await consentForm.validateFields(); await api(`/admin/sessions/${consentTask.id}/consent`, { revision: consentTask.revision, participants: participants(v), consent_doc: v.consent_doc, note: v.note }); setConsentTask(undefined); load(); message.success('用途登记已留存版本；限制需单独核验后解除'); } catch (e) { message.error((e as Error).message); }
    }}><Alert type="warning" message="以实际告知文书和参与者授权为依据。历史隔离记录不会自动获得授权；缺失原件仍需重新导入。" /><Form form={consentForm} layout="vertical"><Form.Item name="consent_doc" label="告知文书编号" rules={[{ required: true }]}><Input /></Form.Item><ConsentFields /><Form.Item name="note" label="修订依据" rules={[{ required: true }]}><Input.TextArea /></Form.Item></Form></Modal>
  </div>;
}
