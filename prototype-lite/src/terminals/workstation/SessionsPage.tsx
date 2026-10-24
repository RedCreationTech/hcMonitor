import { useState } from 'react';
import { App, Alert, Button, Card, Form, Input, Modal, Segmented, Select, Statistic, Table, Tag, Tooltip, Upload } from 'antd';
import { useNavigate } from 'react-router-dom';
import { uploadFile, useApi, useStream } from '../../api/useStream';
import type { AssetKind, AssetRef, DeploymentForm, LampLevel, SessionStatus } from '../../shared/types';
import { ASSET_KIND_LABEL, FORM_LABEL } from '../../../mock/script';
import { LiveCapture } from './LiveCapture';

/** 扩展信号按采样序列文件登记：读一行算一行，不解码、不上传内容 */
const probeSeries = async (file: File) => {
  if (file.size > 4e6) return { duration_seconds: 0, rows: 0 };
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^[\s]*[a-z]/i.test(l.split(',')[0] ?? ''));
  const first = lines.map((l) => Number.parseFloat(l.split(/[,;\t]/)[0] ?? ''))
    .filter((n) => Number.isFinite(n));
  const max = first.length ? Math.max(...first) : 0;
  // 首列当成时间戳只在量级合理时采信：10s–2h 之外更可能是某种物理量，宁可不认也不要认错时基
  const duration = max >= 10 && max <= 7200 && Math.min(...first) <= max * 0.05 ? Math.round(max) : 0;
  return { duration_seconds: duration, rows: lines.length };
};

/** 本地读素材时长：不上传、不解码全片，只取 metadata */
const probeDuration = (file: File) =>
  new Promise<number>((resolve) => {
    const el = document.createElement(file.type.startsWith('audio') ? 'audio' : 'video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? Math.round(el.duration) : 0);
    el.onerror = () => resolve(0);
    el.src = URL.createObjectURL(file);
  });

const STATUS: Record<SessionStatus, { text: string; color: string }> = {
  draft: { text: '待开始', color: 'default' },
  live: { text: '采集中', color: 'processing' },
  review: { text: '待复核', color: 'warning' },
  closed: { text: '已归档', color: 'success' },
};

const LAMP: Record<LampLevel, string> = { green: '正常', orange: '关注', red: '高风险' };

/** 素材大小按量级显示：演示用的短素材写死「0.00 GB」会看着像读错了 */
const fmtBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;

/** S-02 任务台：所有会话的统一入口，从这里进监看、进报告 */
export function SessionsPage() {
  const { message } = App.useApp();
  const post = useApi();
  const nav = useNavigate();
  const { state } = useStream('workstation');
  const [status, setStatus] = useState<'all' | SessionStatus>('all');
  const [kw, setKw] = useState('');
  const [open, setOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const source = 'imported' as const;
  const [assets, setAssets] = useState<AssetRef[]>([]);
  /** 文件本体暂存：元数据探测逻辑不变，真实模式创建会话后逐个上传；mock 模式无上传端点，仅登记元数据 */
  const [pending, setPending] = useState<Array<{ ref: AssetRef; file: File }>>([]);
  const [form] = Form.useForm();

  const sessions = (state?.sessions ?? []).filter((s) => {
    if (status !== 'all' && s.status !== status) return false;
    if (!kw.trim()) return true;
    const q = kw.trim().toLowerCase();
    const assets = s.assets ?? (s.asset ? [s.asset] : []);
    return [s.id, s.subject_code, s.scene, s.collector, s.analyst, s.consent_doc, ...(assets.map((a) => a.name))]
      .filter(Boolean)
      .some((f) => f!.toLowerCase().includes(q));
  });

  /** 同一路信号可以有多个文件（多台摄像机 / 前后两段采样），按 文件名+类型 去重 */
  const addAsset = (a: AssetRef, file: File) => {
    setAssets((prev) => (prev.some((x) => x.name === a.name && x.kind === a.kind) ? prev : [...prev, a]));
    setPending((prev) => (prev.some((x) => x.ref.name === a.name && x.ref.kind === a.kind) ? prev : [...prev, { ref: a, file }]));
  };
  const dropAsset = (id: string) => {
    setAssets((prev) => prev.filter((x) => x.id !== id));
    setPending((prev) => prev.filter((x) => x.ref.id !== id));
  };

  const create = async () => {
    const v = await form.validateFields();
    if (!assets.length) return message.warning('至少登记一份素材文件（音视频或扩展信号任一即可）');
    try {
      const s = await post<{ id: string }>('/sessions', { ...v, source, assets });
      // 逐个上传文件本体：real 模式由 Python 服务接收字节并实测元数据；mock 模式无此端点，走 catch 仅登记元数据
      let uploaded = 0;
      for (const p of pending) {
        const fd = new FormData();
        fd.append('file', p.file);
        fd.append('kind', p.ref.kind);
        fd.append('asset_id', p.ref.id);
        fd.append('client_duration', String(p.ref.duration_seconds || 0));
        try {
          await uploadFile(`/sessions/${s.id}/assets`, fd);
          uploaded += 1;
        } catch {
          message.warning('素材上传未成功（服务端未支持上传），仅登记元数据');
        }
      }
      message.success(
        uploaded === pending.length && pending.length > 0
          ? `已创建 ${s.id}（离线导入 · ${assets.length} 份素材），素材已上传，可起批分析`
          : `已创建 ${s.id}（离线导入 · ${assets.length} 份素材）：点该行「离线分析」起批，全部素材逐份切片后汇成一份报告`,
      );
      setOpen(false);
      setAssets([]);
      setPending([]);
      form.resetFields();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  /** 离线批分析：与实时监看分道的第二条链路，产物只落在这条会话上，不进现场工单 */
  const analyze = async (id: string) => {
    try {
      await post(`/sessions/${id}/analyze-offline`, {});
      message.success(`${id} 已起批：进度在本行显示，完成后自动起草报告（口径：离线导入 · 非实时）`);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h3>任务台 · 会话列表</h3>
        <Segmented
          value={status}
          onChange={(v) => setStatus(v as 'all' | SessionStatus)}
          options={[
            { label: '全部', value: 'all' },
            { label: '采集中', value: 'live' },
            { label: '待复核', value: 'review' },
            { label: '待开始', value: 'draft' },
            { label: '已归档', value: 'closed' },
          ]}
        />
        <Input.Search
          size="small"
          allowClear
          placeholder="搜索会话 / 对象 / 场景 / 素材名"
          style={{ width: 240 }}
          value={kw}
          onChange={(e) => setKw(e.target.value)}
        />
        <span className="grow" />
        <Button type="default" onClick={() => setCaptureOpen(true)}>活体采集</Button>
        <Button type="primary" onClick={() => setOpen(true)}>新建会话</Button>
      </div>

      <div className="stat-row">
        <Card size="small"><Statistic title="采集中" value={state?.sessions.filter((s) => s.status === 'live').length ?? 0} /></Card>
        <Card size="small"><Statistic title="离线分析中" value={state?.sessions.filter((s) => !!s.offline_job).length ?? 0} valueStyle={{ color: '#1664ff' }} /></Card>
        <Card size="small"><Statistic title="分析完成" value={state?.sessions.filter((s) => !!s.offline).length ?? 0} /></Card>
        <Card size="small"><Statistic title="待审批报告" value={state?.reports.filter((r) => r.status === 'pending_review').length ?? 0} /></Card>
        <Card size="small"><Statistic title="在线席位" value={state?.members.filter((m) => m.online).length ?? 0} suffix={`/ ${state?.members.length ?? 0}`} /></Card>
      </div>

      <Table
        size="small"
        rowKey="id"
        pagination={{ defaultPageSize: 8, showSizeChanger: true, pageSizeOptions: [8, 16, 32], showTotal: (t) => `共 ${t} 条` }}
        dataSource={sessions}
        scroll={{ x: 1620 }}
        columns={[
          { title: '会话', dataIndex: 'id', width: 158, render: (v: string, r) => (
            <span>
              <b className="mono" style={{ fontSize: 12 }}>{v}</b>
              <div className="sub" style={{ fontSize: 11 }}>{r.started_at}</div>
            </span>
          ) },
          { title: '对象 / 场景', dataIndex: 'subject_code', render: (v: string, r) => (<span>{v}<div className="sub" style={{ fontSize: 11 }}>{r.scene}</div></span>) },
          { title: '形态', dataIndex: 'form', width: 168, render: (v: DeploymentForm) => <Tag>{FORM_LABEL[v]}</Tag> },
          { title: '来源 / 素材', dataIndex: 'source', width: 200, render: (v: 'live' | 'imported', r) => {
            if (v !== 'imported') return <span className="sub" style={{ fontSize: 11.5 }}>实时采集</span>;
            const list = r.assets ?? (r.asset ? [{ id: 'AS-01', ...r.asset }] : []);
            return (
              <span>
                <Tag color="purple">离线导入 · {list.length} 份</Tag>
                <div className="sub mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                  {list.length ? list.map((a) => a.name).join(' / ') : '素材未登记'}
                </div>
                {list.some((a) => a.kind === 'nir' || a.kind === 'mmwave') && (
                  <Tooltip title={list.filter((a) => a.kind === 'nir' || a.kind === 'mmwave').map((a) => ASSET_KIND_LABEL[a.kind]).join(' + ')}>
                    <Tag color="geekblue" style={{ fontSize: 10.5 }}>含扩展信号</Tag>
                  </Tooltip>
                )}
              </span>
            );
          } },
          { title: '状态', dataIndex: 'status', width: 90, render: (v: SessionStatus) => <Tag color={STATUS[v].color}>{STATUS[v].text}</Tag> },
          { title: '采集 / 分析', width: 150, render: (_, r) => <span style={{ fontSize: 12 }}>{r.collector}<div className="sub" style={{ fontSize: 11 }}>{r.analyst ?? '未指派'}</div></span> },
          { title: '时长', dataIndex: 'duration_seconds', width: 76, render: (v: number) => (v ? `${Math.round(v / 60)}min` : '—') },
          { title: '峰值灯', dataIndex: 'peak_lamp', width: 76, render: (v: LampLevel) => <span style={{ color: v === 'red' ? '#cf1322' : v === 'orange' ? '#d46b08' : '#389e0d' }}>{LAMP[v]}</span> },
          { title: '事件 / 标记', width: 90, render: (_, r) => <span className="mono" style={{ fontSize: 12 }}>{r.anomaly_count} / {r.marker_count}</span> },
          { title: '模态', dataIndex: 'modality_set', width: 130, render: (v: string[]) => <span className="sub mono" style={{ fontSize: 11 }}>{v.join('·')}</span> },
          { title: '授权', dataIndex: 'consent_doc', width: 130, render: (v: string) => <span style={{ fontSize: 11.5 }}>{v}</span> },
          {
            title: '操作', width: 250, fixed: 'right',
            render: (_, r) => (
              <span className="row" style={{ gap: 4 }}>
                {r.source === 'imported' &&
                  (r.offline_job ? (
                    <Button
                      size="small"
                      type="link"
                      title="批分析进行中：点击查看实时进度"
                      onClick={() => nav(`/t/workstation/offline/${r.id}`)}
                    >
                      <Tag color="processing" className="mono" style={{ fontSize: 11 }}>
                        {r.offline_job.progress}% · {r.offline_job.stage.slice(0, 12)}
                      </Tag>
                    </Button>
                  ) : r.offline ? (
                    <Button size="small" type="link" onClick={() => nav(`/t/workstation/offline/${r.id}`)}>查看结果</Button>
                  ) : (
                    <Button
                      size="small"
                      type="link"
                      disabled={r.status === 'closed'}
                      title={r.status === 'closed' ? '会话已归档只读：离线批分析须在归档前完成（服务端同样返回 409）' : undefined}
                      onClick={() => analyze(r.id)}
                    >离线分析</Button>
                  ))}
                <Button size="small" type="link" title="按会话锁定报告：批分析未完成时报告尚未生成" onClick={() => nav(`/t/workstation/reports?session=${r.id}`)}>报告</Button>
              </span>
            ),
          },
        ]}
      />

      <Modal title="新建会话" open={open} onOk={create} onCancel={() => setOpen(false)} okText="创建">
        <Form form={form} layout="vertical" initialValues={{ form: 'B' }}>
          <Form.Item name="subject_code" label="对象编号" rules={[{ required: true, message: '请填写对象编号' }]}>
            <Input placeholder="M-121" />
          </Form.Item>
          <Form.Item name="scene" label="场景 / 地点" rules={[{ required: true, message: '请填写场景' }]}>
            <Input placeholder="经侦询问 · 谈话室 03" />
          </Form.Item>
          <Form.Item name="form" label="部署形态">
            <Select
              options={(['A', 'B', 'C', 'D'] as DeploymentForm[]).map((f) => ({ label: FORM_LABEL[f], value: f }))}
            />
          </Form.Item>
          {/* R1 卡口已在服务端落地（缺文书号直接 403），UI 侧同步设为必填，避免填到一半才发现 */}
          <Form.Item name="consent_doc" label="授权文书编号" rules={[{ required: true, message: '缺少告知文书号不可创建会话（R1）' }]} extra="口头告知场景填写「口头告知 · 录音留证」">
            <Input placeholder="SQ-2026-121" />
          </Form.Item>
          <Form.Item label="数据来源">
            <Tag color="purple">离线导入素材 · 精简版仅提供此来源</Tag>
          </Form.Item>
          <Form.Item
            label={`素材文件（已登记 ${assets.length} 份 · 音视频为主，扩展信号多选非必填）`}
            extra="只在本机读元数据（时长 / 行数 / 时基）用于登记，不发生上传；但登记后每一份都会进入批分析并出现在报告里。"
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <AssetUpload
                kind="video"
                accept="video/*"
                title="主信号 · 视频"
                hint="点击或拖入谈话录像（mp4 / mov / mkv）：一路素材可提供语音、语义、表情、姿态、手部、生理(rPPG) 六路"
                onPick={addAsset}
              />
              <AssetUpload
                kind="audio"
                accept="audio/*"
                title="主信号 · 音频"
                hint="点击或拖入录音（mp3 / wav / m4a）：无画面帧，表情 / 姿态 / 手部 / 生理四路按不可用处理"
                onPick={addAsset}
              />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <AssetUpload
                  kind="nir"
                  accept=".csv,.tsv,.txt,.json"
                  title="扩展信号 · 近红外（可选）"
                  hint="拖入采样序列导出件（CSV / JSON）"
                  onPick={addAsset}
                />
                <AssetUpload
                  kind="mmwave"
                  accept=".csv,.tsv,.txt,.json"
                  title="扩展信号 · 毫米波（可选）"
                  hint="拖入采样序列导出件（CSV / JSON）"
                  onPick={addAsset}
                />
              </div>
              {assets.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, border: '1px solid var(--line)', borderRadius: 6, padding: 8 }}>
                  {assets.map((a) => (
                    <div key={a.id} className="row" style={{ gap: 6, fontSize: 12 }}>
                      <Tag color={a.kind === 'video' || a.kind === 'audio' ? 'blue' : 'geekblue'} style={{ margin: 0 }}>
                        {ASSET_KIND_LABEL[a.kind]}
                      </Tag>
                      <b className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>{a.name}</b>
                      <span className="sub mono" style={{ fontSize: 11 }}>
                        {fmtBytes(a.size_bytes)} · {a.duration_seconds ? `${a.duration_seconds}s` : '时基未读出'}
                      </span>
                      <span className="grow" />
                      <Button size="small" type="link" danger onClick={() => dropAsset(a.id)}>移除</Button>
                    </div>
                  ))}
                  <div className="sub" style={{ fontSize: 11.5 }}>
                    主信号 {assets.filter((a) => a.kind === 'video' || a.kind === 'audio').length} 份 / 扩展信号 {assets.filter((a) => a.kind === 'nir' || a.kind === 'mmwave').length} 份。
                    {assets.some((a) => a.kind === 'nir' || a.kind === 'mmwave')
                      ? ' 本次含扩展信号：它们全部参与分析，但结论只到生理趋势层，不进升级、不出心理归因。'
                      : ' 未登记扩展信号：本次仅音视频主信号链。'}
                  </div>
                </div>
              )}
            </div>
          </Form.Item>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="导入会话走离线批分析通路，多路素材逐份切片后汇成一份报告"
            description={
              <>
                创建后在任务台该行点「离线分析」起批：每份素材各跑自己的解析链，产物按素材分片列出，最后在会话层融合；报告口径强制标注「离线导入 · 非实时」。
                近红外 / 毫米波当前按文件级导入，不是硬件在线接入——招标 28.01 的「不限于……单一或多种信号的输入」在这一版落到「多路文件可登记、可分析、可出报告」，硬件驱动与时间同步属后续接入项。
                本原型的判定为演示脚本回放，未接真实 ASR / 视觉 / rPPG / 传感器推理。
              </>
            }
          />
        </Form>
      </Modal>

      <LiveCapture open={captureOpen} onClose={() => setCaptureOpen(false)} />
    </div>
  );
}

/** 一路信号源的登记框。每种类型能提供的模态不同，所以框必须带类型说话（而不是一个通用"上传文件"） */
function AssetUpload({
  kind,
  accept,
  title,
  hint,
  onPick,
}: {
  kind: AssetKind;
  accept: string;
  title: string;
  hint: string;
  onPick: (a: AssetRef, file: File) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Upload.Dragger
      accept={accept}
      multiple
      showUploadList={false}
      disabled={busy}
      beforeUpload={async (file) => {
        setBusy(true);
        const duration_seconds =
          kind === 'video' || kind === 'audio'
            ? await probeDuration(file)
            : (await probeSeries(file)).duration_seconds;
        setBusy(false);
        // 元数据探测逻辑不变；文件本体一并交给页面暂存，创建会话后由真实服务接收字节
        onPick({ id: `${kind}:${file.name}`, name: file.name, size_bytes: file.size, duration_seconds, kind }, file);
        return false;
      }}
    >
      <div style={{ padding: '6px 0', fontSize: 12.5 }}>
        <b>{title}</b>
        <div className="sub" style={{ fontSize: 11.5 }}>{busy ? '本机读取元数据中…' : hint}</div>
      </div>
    </Upload.Dragger>
  );
}
