import { useEffect, useState } from 'react';
import { App, Alert, Button, Form, Input, Modal, Progress, Select, Space, Table, Tag, Upload } from 'antd';
import { useNavigate } from 'react-router-dom';
import { uploadResumable, useApi, useStream } from '../../api/useStream';
import { useActor } from '../../shells/session';
import type { AssetKind, AssetRef } from '../../shared/types';
import { LiveCapture } from './LiveCapture';
import { ConsentFields, participants } from './ConsentFields';

export function SessionsPage() {
  const { message } = App.useApp(); const api = useApi(); const nav = useNavigate(); const { state, connected } = useStream('workstation'); const { actor } = useActor();
  const [open, setOpen] = useState(false); const [capture, setCapture] = useState(false); const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<Array<{ asset: AssetRef; file: File }>>([]); const [primary, setPrimary] = useState<string>();
  const [sid, setSid] = useState<string>(); const [progress, setProgress] = useState(0); const [error, setError] = useState(''); const [query, setQuery] = useState('');
  const [projects, setProjects] = useState<Array<{id: string; name: string}>>([]);
  useEffect(() => { void api<typeof projects>('/projects').then(setProjects).catch(() => {}); }, [api]);
  const [form] = Form.useForm(); const canCapture = actor?.role === 'analyst' || actor?.role === 'collector';
  const [kind, setKind] = useState<AssetKind>('audio');
  const create = async () => {
    try {
      const v = await form.validateFields(); if (!files.length || !primary) throw new Error('请添加音视频并选择主素材');
      setBusy(true); setError('');
      let id = sid;
      if (!id) { const created = await api<{ id: string }>('/sessions', { ...v, participants: participants(v), source: 'imported', assets: files.map(x => x.asset), primary_asset_id: primary }); id = created.id; setSid(id); }
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const sealed = state?.sessions.find(s => s.id === id)?.assets?.find(a => a.id === f.asset.id)?.upload_status === 'complete';
        if (!sealed) await uploadResumable(id, f.asset.id, f.file, p => setProgress(Math.round((i + p / 100) / files.length * 100)));
      }
      message.success('所有素材已完整封存'); setOpen(false); setFiles([]); setSid(undefined); setPrimary(undefined); form.resetFields();
      nav(`/t/workstation/offline/${id}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const add = (file: File) => {
    const id = 'AS-' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const asset = { id, name: file.name, kind, size_bytes: file.size, duration_seconds: 0 };
    setFiles(prev => [...prev, { asset, file }]); if (!primary && (kind === 'audio' || kind === 'video')) setPrimary(id); return false;
  };
  return <div className="page"><div className="page-head"><h3>任务台 · 素材与访谈</h3><Tag color={connected ? 'green' : 'orange'}>{connected ? '已连接' : '连接恢复中'}</Tag><span className="grow" />
    {canCapture && <><Button onClick={() => setCapture(true)}>本机录制</Button><Button type="primary" onClick={() => { setOpen(true); setError(''); }}>新建导入</Button></>}</div>
    <Alert showIcon type="info" message="先登记逐人用途、完整上传并封存，再开始分析；录制结束后自动排队。不同素材按独立时轴计算。" />
    <Input.Search style={{ maxWidth: 360, margin: '16px 0' }} placeholder="按任务、对象或场景搜索" value={query} onChange={e => setQuery(e.target.value)} />
    <Table rowKey="id" size="small" dataSource={(state?.sessions ?? []).filter(s => `${s.id} ${s.subject_code} ${s.scene}`.includes(query))} columns={[
      { title: '任务', dataIndex: 'id' }, { title: '对象 / 场景', render: (_, s) => <>{s.subject_code}<div className="sub">{s.scene}</div></> },
      { title: '素材', render: (_, s) => <>{s.assets?.map(a => <div key={a.id}>{a.name} <Tag color={a.upload_status === 'complete' ? 'green' : 'orange'}>{a.upload_status === 'complete' ? '已封存' : '待上传'}</Tag>{a.upload_status !== 'complete' && canCapture && <Upload showUploadList={false} beforeUpload={file => { if (file.size !== a.size_bytes) { message.error('文件大小与登记不一致'); return false; } void uploadResumable(s.id, a.id, file).then(() => message.success('原件已续传并封存')).catch(e => message.error((e as Error).message)); return false; }}><Button size="small">续传该素材</Button></Upload>}</div>)}</> },
      { title: '状态', render: (_, s) => s.offline_job ? <Progress percent={s.offline_job.progress} size="small" /> : <Tag color={s.stale ? 'orange' : s.offline ? 'green' : 'default'}>{s.stale ? '修订待重算' : s.offline ? '已生成结果' : '待分析'}</Tag> },
      { title: '操作', render: (_, s) => actor?.role !== 'collector' ? <Button onClick={() => nav(`/t/workstation/offline/${s.id}`)}>证据工作区</Button> : <span>采集交付给 {s.analyst}</span> },
    ]} />
    <Modal title={sid ? '继续上传：' + sid : '新建访谈与导入'} open={open} onCancel={() => !busy && setOpen(false)} maskClosable={false} onOk={create} confirmLoading={busy} okText={sid ? '重试并续传' : '保存并上传'} width={720}>
      {error && <Alert type="error" message={error} description="已接收的分块保留，原件未完整封存前不能分析。保留当前窗口可重试续传。" />}
      <Form form={form} layout="vertical" disabled={busy || !!sid} initialValues={{ interviewer_id: 'P-INTERVIEWER', subject_id: 'P-SUBJECT' }}>
        <Form.Item name="project_id" label="项目" initialValue="PRJ-LOCAL"><Select options={projects.map(p => ({ value: p.id, label: p.name }))} /></Form.Item>
        <Space><Form.Item label="对象编号" name="subject_code" rules={[{ required: true }]}><Input /></Form.Item><Form.Item label="场景" name="scene" rules={[{ required: true }]}><Input /></Form.Item></Space>
        <Form.Item label="告知文书编号" name="consent_doc" rules={[{ required: true }]}><Input /></Form.Item><ConsentFields />
      </Form>
      {!sid && <Space><Select value={kind} onChange={setKind} options={['audio', 'video', 'nir', 'mmwave'].map(value => ({ value, label: ({ audio: '音频', video: '视频', nir: '近红外 CSV/TSV', mmwave: '毫米波 CSV/TSV' } as Record<string, string>)[value] }))} />
        <Upload beforeUpload={add} showUploadList={false} multiple><Button disabled={busy}>选择文件</Button></Upload></Space>}
      {files.map(f => <div key={f.asset.id} style={{ margin: '10px 0' }}>{f.file.name} · {(f.file.size / 1024 / 1024).toFixed(1)} MB {!sid && <Button size="small" onClick={() => { setFiles(files.filter(x => x !== f)); if (primary === f.asset.id) setPrimary(undefined); }}>移除</Button>}</div>)}
      <Select aria-label="主素材" style={{ width: '100%' }} value={primary} disabled={!!sid || busy} onChange={setPrimary} placeholder="显式选择主素材" options={files.filter(f => ['audio', 'video'].includes(f.asset.kind)).map(f => ({ value: f.asset.id, label: '主素材：' + f.file.name }))} />
      {busy && <Progress percent={progress} />}
    </Modal><LiveCapture open={capture} onClose={() => setCapture(false)} /></div>;
}
