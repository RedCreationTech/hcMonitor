import { useEffect, useState } from 'react';
import { App, Alert, Button, Card, Empty, Input, Progress, Segmented, Table, Tag } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi, useStream } from '../../api/useStream';
import type { Report, ReportStatus } from '../../shared/types';
import { roleLabel, useActor } from '../../shells/session';
import { FORM_LABEL } from '../../../mock/script';

const ST: Record<ReportStatus, { text: string; color: string }> = {
  drafting: { text: '起草中', color: 'default' },
  pending_review: { text: '待复核', color: 'warning' },
  rejected: { text: '已驳回', color: 'error' },
  approved: { text: '已通过', color: 'blue' },
  published: { text: '已发布', color: 'success' },
};

const STEP_INDEX: Record<ReportStatus, number> = { drafting: 0, pending_review: 1, rejected: 1, approved: 2, published: 3 };
const STEP_LABELS = ['起草', '提交复核', '审批', '发布'];
/** 阶段条右侧的大状态标签：起草中必须是醒目的蓝色（processing），不能复用列表里的灰 default */
const STEP_TAG: Record<ReportStatus, { text: string; color: string }> = {
  drafting: { text: '起草中', color: 'processing' },
  pending_review: { text: '待复核', color: 'warning' },
  rejected: { text: '已驳回', color: 'error' },
  approved: { text: '已通过', color: 'success' },
  published: { text: '已发布', color: 'success' },
};

/** S-08 报告撰写 · 复核 · 发布：起草→提交→审批→发布，每一步都有服务端校验 */
export function ReportsPage() {
  const { message } = App.useApp();
  const post = useApi();
  const nav = useNavigate();
  const [params] = useSearchParams();
  /** 会话锁定：从任务台「报告」/结果页带 ?session= 进入时，只显示该会话的报告；
   *  报告尚未生成时给占位与实时进度，绝不错显其它会话的报告（信息不全的根因修复） */
  const sessionParam = params.get('session');
  const { actor } = useActor();
  const { state } = useStream('workstation');
  const [id, setId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Report | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [status, setStatus] = useState<'all' | ReportStatus>('all');
  const [kw, setKw] = useState('');

  const reportsAll = state?.reports ?? [];
  const reports = reportsAll.filter((r) => {
    if (status !== 'all' && r.status !== status) return false;
    if (!kw.trim()) return true;
    const q = kw.trim().toLowerCase();
    return [r.id, r.title, r.session_id, r.subject_code, r.reviewer, r.asset?.name]
      .filter(Boolean)
      .some((f) => f!.toLowerCase().includes(q));
  });
  // 锁定模式下选择不受筛选影响：直接在全量里找该会话的报告
  const locked = sessionParam ? reportsAll.find((r) => r.session_id === sessionParam) ?? null : null;
  const current = locked ?? (reports.find((r) => r.id === id) ?? null);

  useEffect(() => {
    if (sessionParam) {
      // 锁定模式：报告出现即自动选中；未生成时保持空选中（占位卡会显示实时进度）
      setId(locked ? locked.id : null);
      return;
    }
    if (!id && reportsAll.length) setId(reportsAll[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportsAll.length, sessionParam]);

  useEffect(() => {
    if (current) setDraft(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, current?.status, current?.sections]);

  useEffect(() => setExportResult(null), [id]);

  const canReview = actor?.role === 'reviewer' || actor?.role === 'admin';
  const readonly = current?.status === 'published' || current?.status === 'pending_review';

  const act = async (label: string, path: string, body?: unknown) => {
    try {
      await post(path, body ?? {});
      message.success(`${label}成功`);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const saveSection = async (key: string, text: string) => {
    if (!current) return;
    try {
      await post(`/reports/${current.id}/section`, { key, text });
      message.success(`已保存「${key}」并记入修订流水`);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  /** 导出与打印走同一条服务端出口：拿到的是同一份带水印的 A4 件，且都要落审计（R6）。
   *  print=新窗口打开后唤起浏览器打印；file=本地另存。两条都回显 audit_seq / hash。 */
  const exportReport = async (mode: 'file' | 'print') => {
    if (!current) return;
    try {
      const r = await post<ExportResult>(`/reports/${current.id}/export`, { mode });
      setExportResult(r);
      const url = URL.createObjectURL(new Blob([r.html], { type: 'text/html;charset=utf-8' }));
      if (mode === 'file') {
        const a = document.createElement('a');
        a.href = url;
        a.download = r.filename;
        a.click();
        message.success(`已导出 ${r.filename}${r.watermark ? '（含草稿水印）' : ''}`);
      } else {
        const w = window.open(url, '_blank');
        if (!w) {
          URL.revokeObjectURL(url);
          return message.error('浏览器拦截了新窗口，请改用「导出 HTML 件」后自行打开打印');
        }
        w.addEventListener('load', () => {
          try {
            w.focus();
            w.print();
          } catch {
            /* 打印被取消不影响导出件本身 */
          }
        });
        message.success(`已生成打印件 ${r.filename}${r.watermark ? '（含草稿水印）' : ''}`);
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h3>报告与审批</h3>
        {sessionParam && (
          <Tag
            color="blue"
            closable
            onClose={() => nav('/t/workstation/reports')}
            title="按会话锁定中：点击 x 解除锁定查看全部报告"
          >会话锁定 {sessionParam}</Tag>
        )}
        <Segmented
          value={status}
          onChange={(v) => setStatus(v as 'all' | ReportStatus)}
          options={[
            { label: '全部', value: 'all' },
            { label: '起草中', value: 'drafting' },
            { label: '待复核', value: 'pending_review' },
            { label: '已驳回', value: 'rejected' },
            { label: '已通过', value: 'approved' },
            { label: '已发布', value: 'published' },
          ]}
        />
        <Input.Search
          size="small"
          allowClear
          placeholder="搜索报告 / 标题 / 会话 / 对象"
          style={{ width: 220 }}
          value={kw}
          onChange={(e) => setKw(e.target.value)}
        />
        <span className="grow" />
        <span className="sub" style={{ fontSize: 12 }}>
          当前席位 {actor ? `${actor.name}（${roleLabel(actor.role)}）` : '—'}{canReview ? ' · 具备审批权限' : ' · 无审批权限（职责分离）'}
        </span>
      </div>

      <Table
        size="small"
        rowKey="id"
        pagination={{ defaultPageSize: 5, showSizeChanger: true, pageSizeOptions: [5, 10, 20], showTotal: (t) => `共 ${t} 条` }}
        dataSource={reports}
        scroll={{ x: 900 }}
        style={{ marginBottom: 14 }}
        onRow={(r) => ({ onClick: () => setId(r.id), style: { cursor: 'pointer', background: r.id === id ? '#f0f6ff' : undefined } })}
        columns={[
          { title: '报告', dataIndex: 'id', width: 110, render: (v: string) => <b className="mono" style={{ fontSize: 12 }}>{v}</b> },
          { title: '来源', dataIndex: 'origin', width: 104, render: (v: 'live' | 'imported' | undefined, r) => (
            v === 'imported'
              ? <span><Tag color="purple">离线导入</Tag><div className="sub mono" style={{ fontSize: 10.5, wordBreak: 'break-all' }}>{r.asset?.name ?? ''}</div></span>
              : <span className="sub" style={{ fontSize: 11.5 }}>实时采集</span>
          ) },
          { title: '标题', dataIndex: 'title', render: (v: string) => <span style={{ fontSize: 12 }}>{v}</span> },
          { title: '会话', dataIndex: 'session_id', width: 152, render: (v: string) => <span className="mono" style={{ fontSize: 11.5 }}>{v}</span> },
          { title: '对象', dataIndex: 'subject_code', width: 100 },
          { title: '状态', dataIndex: 'status', width: 92, render: (v: ReportStatus) => <Tag color={ST[v].color}>{ST[v].text}</Tag> },
          { title: '复核人', dataIndex: 'reviewer', width: 100, render: (v: string | null) => v ?? '—' },
          { title: '发布', dataIndex: 'published_at', width: 120, render: (v: string | null) => v ?? '—' },
        ]}
      />

      {sessionParam && !current ? (
        /* 会话锁定但报告尚未生成：给实时进度占位，绝不错显其它会话的报告 */
        (() => {
          const s = state?.sessions.find((x) => x.id === sessionParam);
          return (
            <Card size="small" style={{ marginTop: 14 }} title={`会话 ${sessionParam} 的报告尚未生成`}>
              {s?.offline_job ? (
                <>
                  <div className="sub" style={{ marginBottom: 8, fontSize: 12 }}>
                    离线批分析进行中，完成后将自动起草报告（进度经 WS 实时推送）：
                  </div>
                  <Progress percent={s.offline_job.progress} status="active" size="small" />
                  <div className="sub mono" style={{ marginTop: 6, fontSize: 12 }}>
                    当前阶段：{s.offline_job.stage}
                  </div>
                </>
              ) : s && !s.offline ? (
                <div className="sub" style={{ fontSize: 12 }}>
                  该会话尚未发起离线批分析：报告由批分析产物自动起草，起批后回到本页即可看到。
                </div>
              ) : (
                <div className="sub" style={{ fontSize: 12 }}>报告正在生成中，请稍候…</div>
              )}
              <Button size="small" style={{ marginTop: 12 }} onClick={() => nav(`/t/workstation/offline/${sessionParam}`)}>
                前往分析进度页
              </Button>
            </Card>
          );
        })()
      ) : !current ? (
        <Empty description="未选择报告" style={{ marginTop: 24 }} />
      ) : (
        <div className="report-detail">
          <div>
            <div className="rp-steps">
              <div className="rp-track">
                {STEP_LABELS.map((t, i) => {
                  const idx = STEP_INDEX[current.status];
                  const state = current.status === 'rejected' && i === 1 ? 'rejected' : i < idx ? 'done' : i === idx ? 'cur' : 'todo';
                  return (
                    <span key={t} className={`rp-step ${state}`}>
                      <span className="rp-step-dot">{state === 'done' ? '✓' : i + 1}</span>
                      <span className="rp-step-t">{t}</span>
                      {i < STEP_LABELS.length - 1 && <i className={`rp-step-line${i < idx ? ' on' : ''}`} />}
                    </span>
                  );
                })}
              </div>
              <Tag className="rp-status" color={STEP_TAG[current.status].color}>{STEP_TAG[current.status].text}</Tag>
            </div>
            <div className="row" style={{ gap: 6, margin: '12px 0', flexWrap: 'wrap' }}>
              <Button size="small" type="primary" disabled={current.status === 'published' || current.status === 'pending_review'}
                onClick={() => act('提交复核', `/reports/${current.id}/submit`, { reviewer: '复核人 R-01' })}>提交复核</Button>
              <Button size="small" disabled={!canReview || current.status !== 'pending_review'} onClick={() => act('审批', `/reports/${current.id}/approve`)}>通过</Button>
              <Button size="small" danger disabled={!canReview || current.status !== 'pending_review'}
                onClick={() => act('驳回', `/reports/${current.id}/reject`, { note: rejectNote })}>驳回</Button>
              <Input size="small" style={{ width: 260 }} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} placeholder="驳回理由（必填）" />
              <Button size="small" disabled={current.status !== 'approved'} onClick={() => act('发布', `/reports/${current.id}/publish`)}>发布</Button>
              <span className="grow" />
              <Button size="small" onClick={() => void exportReport('file')}>导出 HTML 件</Button>
              <Button size="small" onClick={() => void exportReport('print')}>打印 / 存 PDF</Button>
            </div>
            {current.precision_note && <Alert type="warning" showIcon style={{ marginBottom: 10 }} message="精度受限" description={current.precision_note} />}
            {readonly && <Alert type="info" showIcon style={{ marginBottom: 10 }} message={current.status === 'published' ? '已发布报告为只读归档件' : '复核中报告锁定，驳回后方可再编辑'} />}
            {exportResult && (
              <Alert
                type={exportResult.watermark ? 'warning' : 'success'}
                showIcon
                style={{ marginBottom: 10 }}
                message={`本次${exportResult.watermark ? '导出的是未审批件' : '导出的是已发布件'}：${exportResult.filename}`}
                description={
                  <span className="mono" style={{ fontSize: 11.5 }}>
                    审计入链 seq={exportResult.audit_seq} · hash={exportResult.hash} ·
                    水印「{exportResult.watermark ?? '无'}」· 加密导出 SM4 未实现（encrypted=false）
                  </span>
                }
              />
            )}

            {(draft?.sections ?? current.sections).map((s) => (
              <div className="section" key={s.key}>
                <h4>{s.title}</h4>
                <Input.TextArea
                  autoSize={{ minRows: 2, maxRows: 8 }}
                  defaultValue={s.text}
                  disabled={readonly}
                  onChange={(e) => setDraft((d) => (d ? { ...d, sections: d.sections.map((x) => (x.key === s.key ? { ...x, text: e.target.value } : x)) } : d))}
                  onBlur={() => {
                    if (!readonly && draft) {
                      const next = draft.sections.find((x) => x.key === s.key)?.text;
                      const prev = current.sections.find((x) => x.key === s.key)?.text;
                      if (next && next !== prev) void saveSection(s.key, next);
                    }
                  }}
                />
              </div>
            ))}
          </div>

          <aside className="panel-card">
            <h4>修订与审批流水</h4>
            <div className="flow-list">
              {current.revisions.map((r, i) => (
                <div key={`${r.ts}-${i}`} className="flow-item">
                  <Tag className="flow-act" color={ACTION_COLOR[r.action]}>{ACTION_LABEL[r.action] ?? r.action}</Tag>
                  <div style={{ minWidth: 0 }}>
                    <b>{r.actor}</b>
                    <span className="sub" style={{ fontSize: 11 }}> · {r.ts}</span>
                    {r.note && <div className="sub" style={{ fontSize: 11.5, marginTop: 2 }}>{r.note}</div>}
                  </div>
                </div>
              ))}
            </div>
            <div className="sub" style={{ fontSize: 12, marginTop: 8 }}>
              采集形态 {FORM_LABEL[state?.sessions.find((s) => s.id === current.session_id)?.form ?? 'A']} ·
              免责章节固定存在（R2），删除后提交会被服务端 422 拦下。
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = { create: '创建', edit: '编辑', submit: '提交复核', approve: '通过', reject: '驳回', publish: '发布', export: '导出', print: '打印' };
const ACTION_COLOR: Record<string, string> = {
  create: 'blue',
  edit: 'default',
  submit: 'warning',
  approve: 'success',
  reject: 'error',
  publish: 'purple',
  export: 'cyan',
  print: 'cyan',
};

type ExportResult = {
  ok: true;
  html: string;
  filename: string;
  watermark: string | null;
  audit_seq: number;
  hash: string;
  encrypted: boolean;
};
