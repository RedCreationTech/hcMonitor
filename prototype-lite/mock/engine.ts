/* 回放引擎：持有会话状态、按 500ms 推进脚本、生成事件，并在出口按订阅通道裁剪载荷。
 * R7「判断权归 viewer」在这里落地——现场壳通道收到的帧本身不含 confidence / attribution。 */
import { createHash } from 'crypto';
import type {
  AdminFlags,
  AnomalyEvent,
  AnnotationItem,
  AnnotationStatus,
  AssetKind,
  AssetRef,
  CallRequestedEvent,
  Channel,
  DemoState,
  DeploymentForm,
  DialogueTurn,
  DispositionEvent,
  FieldMarkerEvent,
  FusionTick,
  ImpactEvent,
  Integration,
  Ledger,
  LedgerRow,
  LiteratureState,
  Member,
  MemberRole,
  ModalityKey,
  ModalityState,
  ModalityStatusEvent,
  OfflineResult,
  OfflineSlice,
  OfflineStageStep,
  Report,
  ReportEvent,
  Rule,
  ServerEvent,
  SessionSummary,
  Severity,
  Ticket,
} from '../src/shared/types';
import {
  ANOMALIES,
  ASSET_KIND_LABEL,
  EXT_SIGNALS,
  MODALITY_LABEL,
  SCRIPT_LENGTH,
  TURNS,
  TOPICS,
  baseCurve,
  extSeries,
} from './script';
import type { AnomalySpec, ExtKind, Turn } from './script';
import {
  DEFAULT_FLAGS,
  LIVE_SESSION,
  SEED_ANNOTATIONS,
  SEED_INTEGRATIONS,
  SEED_MEMBERS,
  SEED_REPORTS,
  SEED_RULES,
  SEED_SESSIONS,
} from './collections';

const TICK_MS = 500;

const seed = <T>(v: T[]): T[] => JSON.parse(JSON.stringify(v)) as T[];

/** R6 审计链：链头与摘要口径。真实部署换国密 SM3 只改这两行，链式结构不变。 */
const GENESIS = '0'.repeat(64);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const emptyHealth = (): Record<ModalityKey, ModalityState> => ({
  voice: 'ok',
  semantic: 'ok',
  face: 'ok',
  pose: 'ok',
  hand: 'ok',
  physio: 'ok',
});

/** 按集成实例而非 kind 映射：两条 Vision 服务分别供给表情与姿态/手部，需要能单独关停。
 *  IN-LLM 只在分析壳出解释文本，不参与检测，故不在此表内。 */
const INTEGRATION_MODALITY: Record<string, ModalityKey> = {
  'IN-ASR': 'voice', 'IN-PRO': 'voice', 'IN-DIA': 'voice',
  'IN-FAC': 'face', 'IN-POS': 'pose', 'IN-HND': 'hand',
  'IN-RPP': 'physio', 'IN-SEM': 'semantic',
};

const healthFrom = (list: Array<{ id: string; status: string }>): Record<ModalityKey, ModalityState> => {
  const health = emptyHealth();
  list.forEach((i) => {
    const m = INTEGRATION_MODALITY[i.id];
    if (!m) return;
    if (i.status === 'off') health[m] = 'off';
    else if (i.status === 'degraded' && health[m] === 'ok') health[m] = 'degraded';
  });
  return health;
};

/** 只按 literature_ref 字面判定两态。刻意不设"已核实"位——逐条核实进度在《研发素材 04》§3.1，
 *  那里才是事实源；在原型里造一个没人签过字的 verified 标记，等于把待办写成已完成。 */
const literatureState = (ref: string): LiteratureState =>
  ref.startsWith('待补') ? 'placeholder' : 'attached';

/** 台账与 CSV 共用同一套措辞，避免两处口径漂移 */
const litLabel = (s: LiteratureState) => (s === 'placeholder' ? '待补·待审' : '已挂接·未逐条复核');

export class Engine {
  state: DemoState;
  private firedAnomalies = new Set<number>();
  private firedTopics = new Set<string>();
  private firedTurns = new Set<number>();
  private listeners = new Set<(evt: ServerEvent) => void>();
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;

  constructor() {
    this.state = {
      session_id: LIVE_SESSION,
      running: false,
      clock: 0,
      speed: 1,
      form: 'A',
      field_view_enabled: true,
      consent: true,
      lamp: 'green',
      advice: '正常推进',
      modality_health: healthFrom(SEED_INTEGRATIONS),
      buffer_seconds: 0,
      weak_network: false,
      collector: { device: 'tablet-01', person: '谈话人本人', authed_until: null },
      viewer: { person: '分析师 W-02', channel: 'workstation' },
      markers: [],
      tickets: [],
      anomalies: [],
      impacts: [],
      turns: [],
      audit: [],
      sessions: seed(SEED_SESSIONS),
      reports: seed(SEED_REPORTS),
      annotations: seed(SEED_ANNOTATIONS),
      rules: seed(SEED_RULES),
      members: seed(SEED_MEMBERS),
      integrations: seed(SEED_INTEGRATIONS),
      admin: { ...DEFAULT_FLAGS, modality_whitelist_d: [...DEFAULT_FLAGS.modality_whitelist_d] },
      local_cache_bytes: 0,
    };
  }

  /** 会话生命周期：现场壳在本终端建会话 → 采集 → 结束 → 报告进入起草，全程不离开现场壳 */
  createSession(input: {
    subject_code: string; scene: string; form: DeploymentForm; consent_doc: string;
    source?: 'live' | 'imported';
    asset?: { name: string; size_bytes: number; duration_seconds: number; kind: AssetKind };
    /** 多信号源登记：至少一份素材才能起批；音视频为主信号，近红外 / 毫米波为可选扩展 */
    assets?: Array<{ name: string; size_bytes: number; duration_seconds: number; kind: AssetKind }>;
  }) {
    // R1 服务端硬卡口：此前只有 UI 层 disabled，逆向请求可绕过建会话——那就不叫卡口
    if (!input.consent_doc?.trim()) {
      // 被拒绝的写操作同样入链：审计只记成功就等于给"试探"留了盲区
      this.log(this.state.collector.person, 'session.create.rejected', 'CONSENT_REQUIRED');
      return { error: 403, code: 'CONSENT_REQUIRED', message: '缺少知情告知文书号，会话不可创建（R1）' };
    }
    if (input.form === 'D' && !this.state.admin.form_d_enabled)
      return { error: 403, message: 'Admin 未启用外勤形态，形态 D 会话不可创建' };
    const id = `SES-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-N${String(this.state.sessions.length + 1).padStart(2, '0')}`;
    // 素材按登记顺序编号 AS-01…，主信号在前：切片展示与报告列素材时都按这个顺序
    const assets: AssetRef[] = (input.assets?.length ? input.assets : input.asset ? [input.asset] : [])
      .filter((a) => a?.name)
      .sort((a, b) => (isExtKind(a.kind) ? 1 : 0) - (isExtKind(b.kind) ? 1 : 0))
      .map((a, i) => ({ id: `AS-${String(i + 1).padStart(2, '0')}`, ...a }));
    const s: SessionSummary = {
      id, subject_code: input.subject_code || '对象（待填）', scene: input.scene || '临时谈话', form: input.form,
      collector: this.state.collector.person, analyst: null, status: 'draft',
      started_at: now(), duration_seconds: 0, peak_lamp: 'green', anomaly_count: 0, marker_count: 0,
      consent_doc: input.consent_doc,
      modality_set: input.form === 'D' ? [...this.state.admin.modality_whitelist_d] : (Object.keys(emptyHealth()) as ModalityKey[]),
      source: input.source ?? 'live',
      ...(assets.length ? { asset: { ...assets[0] }, assets } : {}),
    };
    this.state.sessions = [s, ...this.state.sessions];
    this.log(this.state.collector.person, 'session.create', id);
    this.broadcastState();
    return { ok: true, session: s };
  }

  /** 接入某个会话：draft → live 并复位回放；其它会话为归档只读 */
  openSession(id: string) {
    const s = this.state.sessions.find((x) => x.id === id);
    if (!s) return { error: 404, message: '会话不存在' };
    if (s.status === 'closed') return { error: 409, message: '会话已归档，只读' };
    // 离线导入会话只登记素材，逐帧推理未接入；放它进监看等于用实时回放冒充离线分析结果
    if (s.source === 'imported') {
      this.log(this.state.viewer.person, 'session.open.rejected', `${id}/IMPORT_NOT_WIRED`);
      return { error: 409, code: 'IMPORT_NOT_WIRED', message: '离线导入会话的推理链路未接入，不可进入监看' };
    }
    if (s.form === 'D' && !this.state.admin.form_d_enabled)
      return { error: 403, message: 'Admin 未启用外勤采集形态，本工单不可执行（R8）' };
    this.stop();
    if (s.status !== 'live') {
      const current = this.state.sessions.find((x) => x.status === 'live');
      if (current) { current.status = 'review'; current.duration_seconds = Math.round(this.state.clock); current.anomaly_count = this.state.anomalies.length; current.marker_count = this.state.markers.length; }
      s.status = 'live';
      s.started_at = now();
      s.analyst = this.state.viewer.person;
    }
    this.state.session_id = id;
    this.reset();
    // 形态决定设备 / 采集员 / 现场回显与模态集合，不在这里另写一套规则
    this.setForm(s.form);
    s.collector = this.state.collector.person;
    this.start();
    this.log(this.state.collector.person, 'session.open', id);
    return { ok: true, session: s };
  }

  subscribe(fn: (evt: ServerEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start() {
    if (this.timer) return;
    this.state.running = true;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.emit({ event: 'state', ts: this.state.clock, payload: this.state });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state.running = false;
    this.broadcastState();
  }

  reset() {
    this.firedAnomalies.clear();
    this.firedTopics.clear();
    this.firedTurns.clear();
    this.state.clock = 0;
    this.state.markers = [];
    this.state.tickets = [];
    this.state.anomalies = [];
    this.state.impacts = [];
    this.state.turns = [];
    this.state.lamp = 'green';
    this.state.advice = '正常推进';
    this.state.modality_health = this.healthFromIntegrations();
    this.state.buffer_seconds = 0;
    this.state.local_cache_bytes = 0;
    this.log('系统', 'demo.reset', this.state.session_id);
    this.broadcastState();
  }

  /** 整场演示复位：会话与报告整表回到出厂值，再把锚点会话摆成「待开始」。
   *  逐条改状态是不够的——verify 会以 8× 打开另一条会话，复位后现场壳的任务列表就会
   *  同时挂着两条「采集中」，第二场演示的领任务画面直接穿帮。
   *  单会话接入（openSession）只调 reset()，不归位会话状态。 */
  resetDemo() {
    this.state.sessions = seed(SEED_SESSIONS);
    this.state.reports = seed(SEED_REPORTS);
    const anchor = this.state.sessions.find((s) => s.id === LIVE_SESSION);
    if (anchor) {
      anchor.status = 'draft';
      anchor.duration_seconds = 0;
      anchor.anomaly_count = 0;
      anchor.marker_count = 0;
    }
    this.state.session_id = LIVE_SESSION;
    this.state.speed = 1;
    this.reset();
    this.setForm(anchor ? anchor.form : 'B');
  }

  /** 模态健康必须由上行服务状态推导，不能在复位时清回全 ok——否则「关停语义通道」在下一场会话里静默失效 */
  private healthFromIntegrations() {
    return healthFrom(this.state.integrations);
  }

  setSpeed(speed: number) {
    this.state.speed = speed;
    this.broadcastState();
  }

  setForm(form: DeploymentForm) {
    if (form === 'D' && !this.state.admin.form_d_enabled)
      return { error: 403, message: 'Admin 未启用外勤采集形态（R8 第一道门）' };
    this.state.form = form;
    this.state.collector.device = form === 'D' ? 'phone-field-11' : form === 'C' ? 'room-03-box' : 'tablet-01';
    this.state.collector.person = form === 'A' ? '谈话人本人' : form === 'D' ? '外勤员 D-11' : '专职采集员 C-04';
    this.state.field_view_enabled = form === 'A' && this.state.admin.field_view_enabled;
    this.state.modality_health = this.healthFromIntegrations();
    if (form === 'D') {
      const off = (Object.keys(this.state.modality_health) as ModalityKey[]).filter(
        (k) => !this.state.admin.modality_whitelist_d.includes(k),
      );
      off.forEach((k) => (this.state.modality_health[k] = 'off'));
    }
    this.log('Admin', 'deployment.form_switch', form);
    this.broadcastState();
    return { ok: true };
  }

  toggleFieldView(on: boolean) {
    this.state.field_view_enabled = on;
    this.state.admin.field_view_enabled = on;
    this.log('Admin', on ? 'field.view.enable' : 'field.view.disable', this.state.session_id);
    this.broadcastState();
  }

  /** Admin 门控：任何一项变更立即广播，现场壳与手机壳在同一帧内响应（终端间联动） */
  setFlags(patch: Partial<AdminFlags>, actor: string) {
    this.state.admin = { ...this.state.admin, ...patch };
    if (patch.form_d_enabled === false && this.state.form === 'D') {
      this.stop();
      this.state.field_view_enabled = this.state.admin.field_view_enabled;
    }
    if (this.state.form === 'D') this.setForm('D');
    if (patch.modality_whitelist_d && this.state.form === 'D') {
      this.setForm('D');
    }
    this.log(actor, 'admin.flags.update', Object.keys(patch).join(','));
    this.broadcastState();
    return this.state.admin;
  }

  /** 演示用：模拟遮挡摄像头 / 关闭某模态（对应 S6） */
  setModality(modality: ModalityKey, s: ModalityState) {
    this.state.modality_health = { ...this.state.modality_health, [modality]: s };
    const degraded = (Object.entries(this.state.modality_health) as [ModalityKey, ModalityState][])
      .filter(([, v]) => v !== 'ok').length;
    const evt: ModalityStatusEvent = {
      event: 'modality_status',
      ts: this.state.clock,
      modality_health: this.state.modality_health,
      banner: degraded
        ? `当前 ${6 - degraded}/6 模态，融合置信度下降（安全注意力 mask 已生效）`
        : null,
    };
    this.emit(evt);
    this.log('系统', `modality.${modality}.${s}`, this.state.session_id);
  }

  /** 演示用：模拟外勤弱网，缓冲秒数上涨 */
  setWeakNetwork(on: boolean) {
    this.weakNetwork = on;
    this.state.weak_network = on;
    this.log('系统', on ? 'network.weak' : 'network.restore', this.state.session_id);
    this.broadcastState();
  }

  private weakNetwork = false;

  addMarker(device_id: string) {
    const ts = this.state.clock;
    this.state.markers = [...this.state.markers, ts];
    const evt: FieldMarkerEvent = {
      event: 'field.marker',
      ts,
      collector_id: this.state.collector.person,
      device_id,
      ack: true,
    };
    this.emit(evt);
    this.log(this.state.collector.person, 'field.marker', `${this.state.session_id}@${ts.toFixed(1)}`);
    return { ok: true, ts };
  }

  requestCall(reason_code: string) {
    const id = `TK-${String(++this.seq).padStart(3, '0')}`;
    const ticket: Ticket = {
      id,
      session_id: this.state.session_id,
      requested_by: this.state.collector.person,
      reason_code,
      status: 'PENDING',
      claimed_by: null,
      created_at: this.state.clock,
      claimed_at: null,
      resolved_at: null,
      escalated: 'none',
    };
    this.state.tickets = [...this.state.tickets, ticket];
    const evt: CallRequestedEvent = {
      event: 'field.call_requested',
      ts: this.state.clock,
      ticket_id: id,
      reason_code,
      session_id: this.state.session_id,
      at_ts: this.state.clock,
    };
    this.emit(evt);
    this.log(this.state.collector.person, 'field.call_requested', `${id}/${reason_code}`);
    this.broadcastState();
    return ticket;
  }

  claimTicket(id: string, claimer: string) {
    const t = this.state.tickets.find((x) => x.id === id);
    if (!t) return { error: 404 };
    if (t.status !== 'PENDING') return { error: 409, code: 'ALREADY_CLAIMED', claimed_by: t.claimed_by };
    t.status = 'CLAIMED';
    t.claimed_by = claimer;
    t.claimed_at = this.state.clock;
    this.log(claimer, 'task.claim', id);
    this.broadcastState();
    return { ok: true, latency: +(this.state.clock - t.created_at).toFixed(1) };
  }

  /** 处置回写：服务端只把 lamp_level + advice_text 下发给现场壳通道 */
  recordDisposition(id: string, lamp_level: 'green' | 'orange' | 'red', advice_text: string, note: string, actor: string) {
    const t = this.state.tickets.find((x) => x.id === id);
    if (!t) return { error: 404, message: '工单不存在' };
    if (advice_text.length > 20) return { error: 422, code: 'ADVICE_TOO_LONG', message: 'advice_text 超过 20 字，余光不可读等于没有建议' };
    t.status = 'RESOLVED';
    t.resolved_at = this.state.clock;
    this.state.lamp = lamp_level;
    this.state.advice = advice_text;
    const evt: DispositionEvent = {
      event: 'viewer.disposition_recorded',
      ts: this.state.clock,
      ticket_id: id,
      lamp_level,
      advice_text,
      claimed_by: t.claimed_by ?? actor,
      note,
      confidence: 0.8,
    };
    this.emit(evt);
    this.log(actor, 'disposition.recorded', `${id}→${lamp_level}/${advice_text}`);
    this.broadcastState();
    return { ok: true };
  }

  /** 结束采集：现场壳的终态。会话转 review，同时在服务端起草报告，分析壳立刻可见 */
  endSession() {
    const modality_set = (Object.entries(this.state.modality_health) as [ModalityKey, ModalityState][])
      .filter(([, v]) => v !== 'off')
      .map(([k]) => k);
    const s = this.state.sessions.find((x) => x.id === this.state.session_id);
    const precision_note =
      this.state.form === 'D' ? '本次仅语音 + 语义采集，视觉模态未启用，精度受限' : null;
    if (s) {
      s.status = 'review';
      s.duration_seconds = Math.round(this.state.clock);
      s.anomaly_count = this.state.anomalies.length;
      s.marker_count = this.state.markers.length;
      s.peak_lamp = this.state.anomalies.some((a) => a.severity === 'ESCALATED')
        ? 'red'
        : this.state.anomalies.some((a) => a.severity === 'ALERT')
          ? 'orange'
          : 'green';
      s.modality_set = modality_set;
    }
    const rid = `RP-${this.state.session_id.slice(4, 8)}-${String(this.state.reports.length + 1).padStart(2, '0')}`;
    const report: Report = {
      id: rid, session_id: this.state.session_id, subject_code: s?.subject_code ?? '对象',
      title: `${s?.scene ?? '谈话'}行为异常与心理变化分析报告`, status: 'drafting', reviewer: null,
      sections: [
        { key: 'overview', title: '一、谈话概况', text: `时长 ${Math.round(this.state.clock)}s（回放），有效问答 ${this.state.turns.length} 轮，现场标记 ${this.state.markers.length} 次。` },
        { key: 'anomaly', title: '二、异常行为事件', text: `共 ${this.state.anomalies.length} 条：ALERT ${this.state.anomalies.filter((a) => a.severity === 'ALERT').length} 条，ESCALATED ${this.state.anomalies.filter((a) => a.severity === 'ESCALATED').length} 条。` },
        { key: 'attribution', title: '三、可解释归因', text: this.state.anomalies.length ? '每条事件在分析壳可展开观察层→候选规则层→结论层三级链条。' : '本次未命中规则，无归因条目。' },
        { key: 'impact', title: '四、话题影响值', text: this.state.impacts.length ? `切分 ${this.state.impacts.length} 个语义边界，最高影响值 ${Math.max(...this.state.impacts.map((i) => i.impact_score)).toFixed(2)}。` : '未形成语义边界。' },
        { key: 'limit', title: '五、局限与免责', text: '本报告输出行为风险提示，不构成临床心理诊断；最终判断权归使用方。' },
      ],
      precision_note,
      revisions: [{ ts: now(), actor: '系统', action: 'create', note: '会话结束后自动起草' }],
      published_at: null,
    };
    this.state.reports = [report, ...this.state.reports];
    const evt: ReportEvent = {
      event: 'report',
      ts: this.state.clock,
      session_id: this.state.session_id,
      status: 'ready',
      capture_form: this.state.form,
      modality_set,
      precision_note: precision_note ?? undefined,
    };
    this.emit(evt);
    this.stop();
    this.log(this.state.collector.person, 'session.stop', this.state.session_id);
    this.broadcastState();
    return { ok: true, report_id: rid };
  }

  authField(pin: string) {
    if (!this.state.admin.form_d_enabled) return { error: 403, message: 'Admin 未启用外勤形态，采集壳未加载' };
    if (pin !== '1234') return { error: 401 };
    this.state.collector.authed_until = this.state.clock + 7200;
    this.log(this.state.collector.person, 'field.auth', '2h token');
    this.broadcastState();
    return { ok: true, expires_in: 7200 };
  }

  /** R8 第三道门：回传校验一致后擦除本机缓存 */
  purgeField() {
    const bytes = this.state.local_cache_bytes;
    this.state.local_cache_bytes = 0;
    this.state.collector.authed_until = null;
    this.log(this.state.collector.person, 'field.purge', `本机缓存已擦除（${bytes} KB）`);
    this.broadcastState();
    return { ok: true, purged_kb: bytes };
  }

  /* ── 离线导入素材：批分析通路（与实时监看严格分道） ─────────────────────────── */

  /** 已有素材的离线批分析：一次跑完整段脚本，可用模态由素材类型决定。
   *  刻意不复用实时监看通道——产物只落在 session.offline 上，不写 state.anomalies、
   *  不改灯色、不派发现场工单；否则一段旧录像就会在监看席上冒充成正在发生的实时结论。
   *  实时监看对导入会话仍然返回 409 IMPORT_NOT_WIRED，这条口子没有一起放开。 */
  analyzeOffline(id: string, actor: string) {
    const s = this.state.sessions.find((x) => x.id === id);
    if (!s) return { error: 404, message: '会话不存在' };
    if (s.source !== 'imported')
      return { error: 409, code: 'NOT_IMPORTED', message: '离线批分析只接已有素材；现场采集会话请走实时监看' };
    const assets = assetsOf(s);
    if (!assets.length) return { error: 422, message: '本会话未登记素材文件，离线分析没有输入' };
    if (s.offline_job) return { error: 409, code: 'ANALYZING', message: '本会话离线分析进行中，请等待完成' };
    if (s.status === 'closed') return { error: 409, message: '会话已归档，只读' };

    const result = this.runOfflinePass(s, assets);
    const stages = offlineStages(assets, result);
    this.log(
      actor,
      'session.analyze_offline',
      `${id}/素材 ${assets.length} 份（${assets.map((a) => ASSET_KIND_LABEL[a.kind]).join(' + ')}）/可用模态 ${result.modality_available.join('·')}`,
    );
    delete s.offline;
    s.offline_job = { progress: stages[0].progress, stage: stages[0].stage, steps: stages };
    this.broadcastState();

    // 分阶段推进只为让"批处理"在屏上可见；判定已在上面一次算完，避免中途状态被读到半份结果
    stages.forEach((st, i) => {
      setTimeout(() => {
        // 期间跑过 demo/reset：s 已不在会话表里，孤儿回调直接放弃，不要把报告塞回新状态
        if (!this.state.sessions.includes(s)) return;
        const last = i === stages.length - 1;
        s.offline_job = last ? null : { progress: st.progress, stage: st.stage, steps: stages };
        if (last) {
          s.offline = result;
          s.status = 'review';
          s.analyst = s.analyst ?? this.state.viewer.person;
          s.duration_seconds = result.duration_seconds;
          s.anomaly_count = result.anomalies.length;
          s.modality_set = result.modality_available;
          s.peak_lamp = result.anomalies.some((a) => a.severity === 'ESCALATED')
            ? 'red'
            : result.anomalies.some((a) => a.severity === 'ALERT')
              ? 'orange'
              : 'green';
          result.suppressed.forEach((x) => this.log('引擎 E2', 'anomaly.suppressed', `${x.id}/${x.reason}（离线批分析）`));
          this.draftOfflineReport(s, result, actor);
          this.broadcastState();
        }
        this.broadcastState();
      }, (i + 1) * 420);
    });
    return {
      ok: true,
      session_id: id,
      stages: stages.length,
      assets,
      slices: result.slices.length,
      report_id: result.report_id,
    };
  }

  private runOfflinePass(s: SessionSummary, assets: AssetRef[]): OfflineResult {
    const av = assets.filter((a) => !isExtKind(a.kind));
    const ext = assets.filter((a) => isExtKind(a.kind));
    // 脚本判定链是「一段谈话」的产物：主信号里取信号最宽的一路（视频优先）承接，
    // 其余音视频素材不重跑同一条链——否则一段谈话会按文件数复制出两份异常
    const primary = av.find((a) => a.kind === 'video') ?? av[0] ?? null;
    const health = scriptHealth(av);
    const dia = this.state.integrations.find((x) => x.id === 'IN-DIA');
    const turns = primary ? TURNS.map((t) => this.buildTurn(t, (dia?.status ?? 'ok') as ModalityState)) : [];
    const anomalies: AnomalyEvent[] = [];
    const impacts: ImpactEvent[] = [];
    const suppressed: Array<{ id: string; reason: string }> = [];

    if (!primary) {
      TOPICS.forEach((tp) => suppressed.push({ id: tp.id, reason: '本会话只登记了扩展信号素材，没有音视频输入，语义通道不成链' }));
      ANOMALIES.forEach((_, i) =>
        suppressed.push({ id: `EV-${String(i + 1).padStart(3, '0')}`, reason: '本会话只登记了扩展信号素材，脚本判定链（音视频口径）没有输入' }),
      );
    } else {
      TOPICS.forEach((tp) => {
        const r = this.buildImpact(tp, health);
        if (r.ok) impacts.push(r.value);
        else suppressed.push({ id: tp.id, reason: r.reason });
      });
      ANOMALIES.forEach((a, i) => {
        const evtId = `EV-${String(i + 1).padStart(3, '0')}`;
        const r = this.buildAnomaly(a, evtId, s.id, health);
        if (r.ok) {
          anomalies.push({ ...r.value, source_assets: carriersOf(r.value, av) });
          // 离线件同样进标注队列：误报闭环不该只在实时链上成立。前缀 AN-O 与实时 AN-L、播种 AN-0xx 隔离
          const anId = `AN-O${evtId.slice(3)}`;
          if (!this.state.annotations.some((x) => x.id === anId)) {
            this.state.annotations = [
              ...this.state.annotations,
              {
                id: anId, session_id: s.id, ev_id: evtId, ts: r.value.ts,
                modality: r.value.modality, model_label: r.value.attribution.conclusion.psych_state || r.value.type,
                model_confidence: r.value.confidence,
                rule_id: r.value.attribution.candidate_rules.find((x) => x.hit)?.rule_id ?? '-',
                human_label: null, reviewer: null, status: 'pending', note: '',
              },
            ];
          }
        } else {
          suppressed.push({ id: evtId, reason: r.reason });
        }
      });
    }

    const built = ext.map((a) => this.buildExtensionSlice(s, a));
    built.forEach((x) => anomalies.push(...x.events));

    const slices: OfflineSlice[] = assets.map((a) => {
      const x = built.find((y) => y.asset.id === a.id);
      if (x) return x.slice;
      const isPrimary = primary?.id === a.id;
      const healthOf = offlineHealth(a.kind);
      const entry = (Object.entries(healthOf) as [ModalityKey, ModalityState][]);
      return {
        asset_id: a.id,
        asset_name: a.name,
        kind: a.kind,
        role: 'primary' as const,
        size_bytes: a.size_bytes,
        duration_seconds: a.duration_seconds,
        modality_available: entry.filter(([, v]) => v !== 'off').map(([k]) => k),
        modality_unavailable: entry.filter(([, v]) => v === 'off').map(([k]) => k),
        steps: avSteps(a.kind),
        // 跨模态条目会同时挂在两份主素材上：语音观察既来自录像也来自录音，如实各记一次，不挑一个"归属"
        event_ids: [
          ...anomalies.filter((ev) => ev.source_assets?.some((y) => y.id === a.id)).map((ev) => ev.id),
          ...impacts.map((i) => i.topic_id),
        ],
        suppressed: isPrimary ? suppressed : [],
        trend: null,
        cap_note: null,
        quality: a.duration_seconds > 0 ? ('ok' as const) : ('degraded' as const),
        quality_note:
          a.duration_seconds > 0
            ? `元数据时基 ${a.duration_seconds}s，可与报告时间轴逐点对齐`
            : '素材容器未读出时长：时间轴按演示脚本时轴对齐展示，时长类结论不可用',
      };
    });

    return {
      finished_at: now(),
      asset_kind: primary?.kind === 'audio' ? 'audio' : 'video',
      assets,
      slices,
      modality_available: (Object.entries(health) as [ModalityKey, ModalityState][])
        .filter(([, v]) => v !== 'off')
        .map(([k]) => k),
      duration_seconds: Math.max(...assets.map((a) => a.duration_seconds), 0) || SCRIPT_LENGTH,
      turns,
      anomalies,
      impacts,
      suppressed,
      report_id: `RP-${s.id.slice(4, 8)}-${String(this.state.reports.length + 1).padStart(2, '0')}`,
      pipeline: `E1 融合 + E2 判定（与实时监看同一函数）· 素材 ${assets.length} 份 · 主素材 ${primary?.name ?? '无（仅扩展信号）'}`,
    };
  }

  /** 扩展信号（近红外 / 毫米波）切片的独立成链：只到生理趋势层 + 单模态异常。
   *  候选规则恒为空、严重度封顶 ALERT、不进聚合升级——这是口径上限，不是"这路信号没检出东西"。 */
  private buildExtensionSlice(s: SessionSummary, a: AssetRef): ExtensionSlice {
    const cfg = EXT_SIGNALS[a.kind as ExtKind];
    const series = extSeries(a.kind as ExtKind, a.duration_seconds);
    const drive = series.find((m) => m.name === (a.kind === 'nir' ? 'HbO 相对浓度变化' : '心率估算')) ?? series[0];
    const noise = series.find((m) => /伪迹|体动/.test(m.name)) ?? null;
    const tail = drive.series.slice(Math.floor(drive.series.length * 0.6));
    const jump = Math.abs(drive.peak - drive.baseline);
    const sustained = tail.filter((v) => Math.abs(v - drive.baseline) >= jump * 0.6).length;
    const rise = jump / Math.max(Math.abs(drive.baseline), 1e-6);
    const quality: 'ok' | 'degraded' =
      a.duration_seconds <= 0 || (noise && Math.abs(noise.peak) > (a.kind === 'nir' ? 20 : 8)) ? 'degraded' : 'ok';
    const fmt = (v: number, d: number) => v.toFixed(d);
    // 显著性判据（本系统自定义口径，非文献阈值）：峰值相对静息段中位数升幅 >12%，
    // 且末段 40% 采样窗里至少 3 窗维持在升幅的 60% 以上——单点尖峰不算上行，那通常是伪迹
    const significant = rise > 0.12 && sustained >= 3;
    const severity: Severity = significant && quality === 'ok' ? 'ALERT' : 'WARN';
    // 这里的 confidence 不是归因置信度：扩展信号没有规则可命中，它只表示趋势相对变化的显著度
    const confidence = +Math.min(0.85, rise * 0.9).toFixed(2);
    const id = `EV-X${a.id.slice(-2)}`;
    const capNote =
      `扩展信号结论上限：本条只到生理趋势层，不启用归因规则（候选规则层为空）、不进 ESCALATED、不参与跨模态聚合升级。` +
      `上报判据为自定义口径：峰值相对静息段（前 25% 采样窗）中位数升幅 ${Math.round(rise * 100)}% >12%，且末段 ${sustained}/${tail.length} 窗维持升幅 60% 以上；` +
      `confidence ${confidence} 是该升幅的折算值，不是归因置信度。` +
      (quality === 'degraded'
        ? `本素材质量降级（${noise ? `${noise.name}峰值 ${fmt(noise.peak, noise.decimals)}${noise.unit}` : '采样时基未读出'}），趋势仅供复核参考。`
        : '');

    const events: AnomalyEvent[] = significant
      ? [
          {
            event: 'anomaly',
            id,
            session_id: s.id,
            ts: drive.peak_ts,
            modality: 'physio',
            type: `${cfg.sensor_label} 生理趋势上行`,
            severity,
            confidence,
            lamp: 'orange',
            advice: '仅登记趋势并留档核对，不据此作出处置或追问',
            source_assets: [{ id: a.id, name: a.name, kind: a.kind }],
            cap_note: capNote,
            attribution: {
              observation: [
                {
                  modality: 'physio' as ModalityKey,
                  text:
                    `${cfg.sensor_label}：${drive.name} 基线 ${fmt(drive.baseline, drive.decimals)}${drive.unit} → 峰值 ${fmt(drive.peak, drive.decimals)}${drive.unit}` +
                    `（${drive.peak_ts}s，末段值 ${fmt(drive.end_value, drive.decimals)}${drive.unit}）；末段 ${sustained}/${tail.length} 个采样窗维持在峰值 60% 以上`,
                  ts_from: 0,
                  ts_to: drive.peak_ts,
                },
                ...(noise
                  ? [
                      {
                        modality: 'physio' as ModalityKey,
                        text: `${noise.name} 峰值 ${fmt(noise.peak, noise.decimals)}${noise.unit}（${noise.peak_ts}s）——超阈窗口内的主指标读数按不可用处理，未做插值补齐`,
                        ts_from: 0,
                        ts_to: noise.peak_ts,
                      },
                    ]
                  : []),
              ],
              candidate_rules: [],
              conclusion: {
                psych_state: '不做心理归因（扩展信号仅到生理趋势层）',
                confidence,
                counterfactual:
                  a.kind === 'nir'
                    ? '若采样段内探头耦合状态改变、或对象起身移动导致光程变化，本趋势作废而非降级'
                    : '若波束主目标跳变到在场第二人（谈话人），或体动幅度覆盖心跳带频谱，本趋势作废而非降级',
                disclaimer: '模型推断，非临床心理诊断；本条不含心理状态结论',
              },
            },
          },
        ]
      : [];

    const slice: OfflineSlice = {
      asset_id: a.id,
      asset_name: a.name,
      kind: a.kind,
      role: 'extension',
      size_bytes: a.size_bytes,
      duration_seconds: a.duration_seconds,
      modality_available: ['physio'],
      modality_unavailable: ['voice', 'semantic', 'face', 'pose', 'hand'],
      steps: cfg.steps,
      event_ids: events.map((e) => e.id),
      suppressed: significant
        ? []
        : [{ id, reason: `趋势未达显著上行判据（峰值/基线升幅 ${Math.round(rise * 100)}%、末段持续 ${sustained}/${tail.length} 窗），不上报异常，只保留趋势` }],
      trend: {
        sensor_label: cfg.sensor_label,
        samples: drive.series.length,
        time_base: a.duration_seconds > 0 ? '素材登记时长' : '脚本时轴（素材未提供时基）',
        metrics: series,
        limits: cfg.limits,
      },
      cap_note: capNote,
      quality,
      quality_note:
        a.duration_seconds <= 0
          ? `未从文件首列读出时间戳，趋势轴靠演示脚本时轴对齐——形状可读，绝对时刻不可用${noise ? `；噪声指标峰值 ${fmt(noise.peak, noise.decimals)}${noise.unit}` : ''}`
          : quality === 'ok'
            ? `噪声指标峰值 ${noise ? `${fmt(noise.peak, noise.decimals)}${noise.unit}` : '—'}，未触发质量降级`
            : `噪声指标峰值 ${noise ? `${fmt(noise.peak, noise.decimals)}${noise.unit}` : '—'} 超判据，本路趋势标降级`,
    };
    return { asset: a, slice, events };
  }

  private draftOfflineReport(s: SessionSummary, r: OfflineResult, actor: string) {
    const kinds = Array.from(new Set(r.anomalies.map((a) => a.modality)));
    const attributed = r.anomalies.filter((a) => !a.cap_note);
    const capped = r.anomalies.filter((a) => a.cap_note);
    const report: Report = {
      id: r.report_id,
      session_id: s.id,
      subject_code: s.subject_code,
      title: `${s.scene}行为异常与心理变化分析报告（离线导入）`,
      status: 'drafting',
      reviewer: null,
      origin: 'imported',
      asset: { name: r.slices[0]?.asset_name ?? '—', kind: r.slices[0]?.kind ?? r.asset_kind, duration_seconds: r.duration_seconds, size_bytes: r.slices[0]?.size_bytes ?? 0 },
      assets: r.assets,
      sections: [
        {
          key: 'overview',
          title: '一、素材与分析概况',
          text:
            `登记素材 ${r.assets.length} 份（${r.assets.map((a) => `${a.name}·${ASSET_KIND_LABEL[a.kind]}`).join('；')}），` +
            `会话时长按最长素材取 ${r.duration_seconds}s；本次进入脚本判定链的模态 ${r.modality_available.length}/6（${r.modality_available.map((m) => MODALITY_LABEL[m]).join('·') || '无'}）。` +
            `转写有效问答 ${r.turns.length} 轮，批分析完成于 ${r.finished_at}，判定口径：${r.pipeline}。`,
        },
        {
          key: 'slices',
          title: '二、素材切片与各自贡献',
          text:
            r.slices
              .map(
                (x) =>
                  `〔${x.asset_name}·${ASSET_KIND_LABEL[x.kind]}〕可解析模态 ${x.modality_available.map((m) => MODALITY_LABEL[m]).join('·')}，` +
                  `不可用 ${x.modality_unavailable.map((m) => MODALITY_LABEL[m]).join('·') || '无'}；` +
                  `解析 ${x.steps.length} 段，支撑事件 ${x.event_ids.length ? x.event_ids.join('、') : '无'}；` +
                  `质量 ${x.quality === 'ok' ? '达标' : '降级'}（${x.quality_note}）` +
                  (x.trend
                    ? `；趋势 ${x.trend.metrics.map((m) => `${m.name} ${m.baseline}→${m.peak}${m.unit}（${m.peak_ts}s）`).join('，')}，时基取${x.trend.time_base}`
                    : '') +
                  (x.cap_note ? `；${x.cap_note}` : '') +
                  (x.suppressed.length ? `；本素材裁撤 ${x.suppressed.length} 条` : ''),
              )
              .join(' ') +
            ' 所有登记素材均进入本次批分析并逐份列示，未提供任何一路素材的结论不会以"检测正常"的形式出现。',
        },
        {
          key: 'anomaly',
          title: '三、异常行为事件',
          text:
            `共上报 ${r.anomalies.length} 条，覆盖 ${kinds.length} 类异常模态（${kinds.map((m) => MODALITY_LABEL[m]).join('、') || '无'}）；` +
            `其中 ALERT ${r.anomalies.filter((a) => a.severity === 'ALERT').length} 条、ESCALATED ${r.anomalies.filter((a) => a.severity === 'ESCALATED').length} 条。` +
            `扩展信号（近红外 / 毫米波）另计 ${capped.length} 条趋势型条目，封顶 ALERT、不含心理归因，与主信号的 ${attributed.length} 条分列。` +
            `另有 ${r.suppressed.length} 条因模态不可用未上报，逐条原因见「离线分析结果」页与审计 anomaly.suppressed。`,
        },
        {
          key: 'attribution',
          title: '四、可解释归因与心理原因',
          text:
            (attributed.length
              ? `${attributed.map((a) => `${a.id} ${a.type} → ${a.attribution.conclusion.psych_state}（置信度 ${a.confidence}${a.source_assets?.length ? `·素材 ${a.source_assets.map((x) => x.name).join('/')}` : ''}）`).join('；')}。` +
                '每条的 L1 观察层、L2 候选规则（含心理状态假设与文献字段）、L3 反事实与免责，均可在结果页逐条展开核对。'
              : '本次未命中规则，无归因条目。') +
            (capped.length
              ? `${capped.map((a) => a.id).join('、')} 只到生理趋势层：候选规则层为空、不给出心理状态结论，其 confidence 为趋势显著度而非归因置信度。`
              : ''),
        },
        {
          key: 'impact',
          title: '五、话题切分与语义影响值',
          text: r.impacts.length
            ? `切分 ${r.impacts.length} 个语义边界，最高影响值 ${Math.max(...r.impacts.map((i) => i.impact_score)).toFixed(2)}。` +
              '影响值为 [0,1] 归一化相对量，仅在本会话内排序，不可跨会话比较，无临床量纲。'
            : '语义通道不可用（本会话无音视频主素材），未形成话题与影响值。',
        },
        {
          key: 'limit',
          title: '六、局限与免责',
          text:
            '本报告由已有素材离线批分析生成，口径为「离线导入 · 非实时」，不与实时监看结论混用；' +
            `登记素材 ${r.assets.length} 份中，${r.slices.filter((x) => x.role === 'extension').length} 份为扩展信号（文件级导入，非硬件在线接入），其结论上限见第二节逐份列示。` +
            `原型阶段的数据来自演示脚本回放，未接入真实模型权重，不构成算法精度证明。${DISCLAIMER_TEXT}，最终判断权归使用方。`,
        },
      ],
      precision_note: precisionNote(r),
      revisions: [{ ts: now(), actor, action: 'create', note: '离线批分析完成后自动起草（口径：离线导入 · 非实时）' }],
      published_at: null,
    };
    this.state.reports = [report, ...this.state.reports];
    this.log(actor, 'report.draft', `${report.id}/离线导入 · 非实时`);
  }

  /** 报告导出 / 打印。与 exportLedger 同一口径：导出即留痕，动作进审计哈希链并回显 seq。
   *  未发布件允许导出，但强制带「草稿 · 未经复核审批」水印。
   *  SM4 加密导出未实现——返回体里的 encrypted 恒为 false，界面据此如实标注，不装作已支持。 */
  exportReport(id: string, actor: string, mode: 'file' | 'print') {
    const m = this.state.members.find((x) => x.name === actor);
    if (!m) return { error: 403, message: `导出需以在册成员身份进行（${actor || '未占席'} 不在成员表）` };
    if (m.role === 'collector') return { error: 403, message: '采集员角色无导出权限（R7：判断权归 viewer）' };
    const r = this.findReport(id);
    if (!r) return { error: 404, message: '报告不存在' };
    const watermark = r.status === 'published' ? null : '草稿 · 未经复核审批';
    const session = this.state.sessions.find((x) => x.id === r.session_id);
    const html = reportHtml(r, watermark, session);
    this.log(actor, mode === 'print' ? 'report.print' : 'report.export', `${r.id}/status=${r.status}/sha=${sha256(html).slice(0, 12)}`);
    const entry = this.state.audit[this.state.audit.length - 1];
    return {
      ok: true,
      html,
      filename: `minddialogue_${r.id}${watermark ? '_DRAFT' : ''}.html`,
      watermark,
      audit_seq: entry.seq,
      hash: entry.hash.slice(0, 12),
      encrypted: false,
    };
  }

  /** 离线批分析产物导出 CSV：上报项与裁撤项同表，靠 outcome 列区分。
   *  裁撤条目必须出现在导出件里——只导出命中的那几条，等于把"没信号"洗成"没异常"。 */
  offlineCsv(id: string, actor: string) {
    const s = this.state.sessions.find((x) => x.id === id);
    if (!s) return { error: 404, message: '会话不存在' };
    if (!s.offline) return { error: 409, message: '本会话尚未完成离线批分析，没有可导出的产物' };
    const m = this.state.members.find((x) => x.name === actor);
    if (!m) return { error: 403, message: `导出需以在册成员身份进行（${actor || '未占席'} 不在成员表）` };
    if (m.role === 'collector') return { error: 403, message: '采集员角色无导出权限（R7：判断权归 viewer）' };

    const r = s.offline;
    const header = ['outcome', 'asset', 'id', 'modality', 'type_or_topic', 'ts', 'confidence', 'conclusion_layer', 'psych_state', 'hit_rules', 'reason'];
    const primary = r.slices.find((x) => x.role === 'primary')?.asset_name ?? '';
    const rows: unknown[][] = [
      ...r.anomalies.map((a) => [
        'reported', (a.source_assets ?? []).map((x) => x.name).join('|') || primary, a.id, a.modality, a.type, a.ts, a.confidence,
        a.cap_note ? 'trend_only（不出归因）' : 'attributed',
        a.attribution.conclusion.psych_state,
        a.attribution.candidate_rules.filter((x) => x.hit).map((x) => x.rule_id).join('|'), '',
      ]),
      ...r.impacts.map((i) => [
        'reported', primary, i.topic_id, 'semantic', i.label, i.ts, i.impact_score, 'attributed', '', '', i.boundary_evidence,
      ]),
      ...r.suppressed.map((x) => ['suppressed', primary, x.id, '', '', '', '', 'suppressed', '', '', x.reason]),
      // 切片级裁撤：主素材的那份已进 r.suppressed（同 id 不重复出两行），扩展素材的只在这里出现
      ...r.slices.flatMap((sl) =>
        sl.suppressed
          .filter((x) => !r.suppressed.some((y) => y.id === x.id))
          .map((x) => ['suppressed', sl.asset_name, x.id, 'physio', '', '', '', 'suppressed', '', '', x.reason]),
      ),
    ];
    const csv = csvDoc(header, rows);
    this.log(actor, 'dataset.export', `${id}/offline-rows=${rows.length}/sha=${sha256(csv).slice(0, 12)}`);
    const entry = this.state.audit[this.state.audit.length - 1];
    return {
      ok: true, csv,
      filename: `minddialogue_offline_${id}_${entry.seq}.csv`,
      rows: rows.length, audit_seq: entry.seq, hash: entry.hash.slice(0, 12),
    };
  }

  /* ── 分析壳侧：报告审批流 / 标注复核 / 规则库 / 成员 / 集成 ───────────────── */

  private findReport(id: string) {
    return this.state.reports.find((r) => r.id === id);
  }

  editReportSection(id: string, key: string, text: string, actor: string) {
    const r = this.findReport(id);
    if (!r) return { error: 404 };
    if (r.status === 'published') return { error: 409, message: '已发布报告为只读' };
    r.sections = r.sections.map((x) => (x.key === key ? { ...x, text } : x));
    r.revisions = [...r.revisions, { ts: now(), actor, action: 'edit', note: key }];
    this.log(actor, 'report.section.edit', `${id}/${key}`);
    this.broadcastState();
    return { ok: true, report: r };
  }

  /** 提交复核：drafting / rejected → pending_review；反事实缺失时工程侧拦下 */
  submitReport(id: string, actor: string, reviewer: string | null) {
    const r = this.findReport(id);
    if (!r) return { error: 404 };
    if (r.status === 'published') return { error: 409, message: '已发布报告不可重复提交' };
    if (!r.sections.some((x) => x.key === 'limit')) return { error: 422, message: '缺少「局限与免责」章节' };
    r.status = 'pending_review';
    r.reviewer = reviewer ?? '复核人 R-01';
    r.revisions = [...r.revisions, { ts: now(), actor, action: 'submit', note: `指派复核人 ${r.reviewer}` }];
    this.log(actor, 'report.submit', id);
    this.broadcastState();
    return { ok: true, report: r };
  }

  approveReport(id: string, actor: string) {
    const r = this.findReport(id);
    if (!r) return { error: 404 };
    if (!this.isReviewer(actor)) return { error: 403, message: '仅复核人可审批（职责分离）' };
    if (r.status !== 'pending_review') return { error: 409, message: `当前状态 ${r.status} 不可审批` };
    r.status = 'approved';
    r.revisions = [...r.revisions, { ts: now(), actor, action: 'approve' }];
    this.log(actor, 'report.approve', id);
    this.broadcastState();
    return { ok: true, report: r };
  }

  rejectReport(id: string, actor: string, note: string) {
    const r = this.findReport(id);
    if (!r) return { error: 404 };
    if (!this.isReviewer(actor)) return { error: 403, message: '仅复核人可驳回（职责分离）' };
    if (!note.trim()) return { error: 422, message: '驳回必须填写理由' };
    r.status = 'rejected';
    r.revisions = [...r.revisions, { ts: now(), actor, action: 'reject', note }];
    this.log(actor, 'report.reject', `${id}/${note.slice(0, 20)}`);
    this.broadcastState();
    return { ok: true, report: r };
  }

  publishReport(id: string, actor: string) {
    const r = this.findReport(id);
    if (!r) return { error: 404 };
    if (r.status !== 'approved') return { error: 409, message: '未通过复核的报告不能发布' };
    r.status = 'published';
    r.published_at = now();
    r.revisions = [...r.revisions, { ts: now(), actor, action: 'publish' }];
    const s = this.state.sessions.find((x) => x.id === r.session_id);
    if (s) s.status = 'closed';
    this.log(actor, 'report.publish', id);
    this.broadcastState();
    return { ok: true, report: r };
  }

  private isReviewer(actor: string) {
    const m = this.state.members.find((x) => x.name === actor);
    return !m || m.role === 'reviewer' || m.role === 'admin';
  }

  decideAnnotation(id: string, patch: { status: AnnotationItem['status']; human_label?: string; note?: string }, actor: string) {
    const a = this.state.annotations.find((x) => x.id === id);
    if (!a) return { error: 404 };
    a.status = patch.status;
    a.human_label = patch.human_label ?? a.model_label;
    a.reviewer = actor;
    a.note = patch.note ?? a.note;
    if (patch.status === 'confirmed') {
      const rule = this.state.rules.find((x) => x.id === a.rule_id);
      if (rule) rule.hits += 1;
    }
    this.log(actor, 'annotation.decide', `${id}/${patch.status}`);
    this.broadcastState();
    return { ok: true, annotation: a };
  }

  /** 标注回流：人工确认为新模式后写入规则库（待启用），形成 现场→分析→规则→现场 的闭环 */
  reflowAnnotation(id: string, actor: string) {
    if (!this.state.admin.annotation_reflow) return { error: 403, message: 'Admin 已关闭标注回流开关' };
    const a = this.state.annotations.find((x) => x.id === id);
    if (!a) return { error: 404 };
    if (a.status === 'false_positive') return { error: 422, message: '误报样本进入负例集，不生成规则' };
    const rid = `R-NL-${String(this.state.rules.filter((r) => r.source === '标注回流').length + 1).padStart(2, '0')}`;
    const rule: Rule = {
      id: rid, pattern: `${a.human_label ?? a.model_label}（由 ${a.ev_id} 回流）`,
      psych_state: a.human_label ?? a.model_label, literature_ref: '待补文献：需人工挂接证据',
      weight: +(a.model_confidence * 0.6).toFixed(2), threshold: +(a.model_confidence * 0.8).toFixed(2),
      enabled: false, owner: actor, updated_at: now().slice(0, 10), hits: 0, source: '标注回流',
    };
    this.state.rules = [...this.state.rules, rule];
    a.status = '回流中';
    this.log(actor, 'annotation.reflow', `${id}→${rid}`);
    this.broadcastState();
    return { ok: true, rule: rid };
  }

  toggleRule(id: string, enabled: boolean, actor: string) {
    const r = this.state.rules.find((x) => x.id === id);
    if (!r) return { error: 404 };
    if (enabled && r.source === '标注回流' && r.literature_ref.startsWith('待补'))
      return { error: 422, message: '回流规则需先挂接文献支撑再启用' };
    r.enabled = enabled;
    r.updated_at = now().slice(0, 10);
    this.log(actor, enabled ? 'rule.enable' : 'rule.disable', id);
    this.broadcastState();
    return { ok: true, rule: r };
  }

  updateRule(id: string, patch: Partial<Pick<Rule, 'weight' | 'threshold' | 'literature_ref'>>, actor: string) {
    const r = this.state.rules.find((x) => x.id === id);
    if (!r) return { error: 404 };
    Object.assign(r, patch);
    r.updated_at = now().slice(0, 10);
    this.log(actor, 'rule.update', id);
    this.broadcastState();
    return { ok: true, rule: r };
  }

  inviteMember(input: { name: string; role: MemberRole; seat: string; forms: DeploymentForm[] }) {
    if (this.state.members.some((m) => m.name === input.name)) return { error: 409, message: '同名成员已存在' };
    const m: Member = { id: input.name.slice(-4), name: input.name, role: input.role, seat: input.seat || '未分配', online: false, forms: input.forms.length ? input.forms : ['A'] };
    this.state.members = [...this.state.members, m];
    this.log('Admin', 'member.invite', `${m.name}/${m.role}`);
    this.broadcastState();
    return { ok: true, member: m };
  }

  setMemberForms(id: string, forms: DeploymentForm[], actor: string) {
    const m = this.state.members.find((x) => x.id === id);
    if (!m) return { error: 404 };
    m.forms = forms;
    this.log(actor, 'member.forms.update', `${m.name}/${forms.join('')}`);
    this.broadcastState();
    return { ok: true, member: m };
  }

  testIntegration(id: string, actor: string) {
    const i = this.state.integrations.find((x) => x.id === id);
    if (!i) return { error: 404 };
    i.status = i.status === 'off' ? 'degraded' : 'ok';
    i.latency_ms = i.latency_ms ? Math.max(60, Math.round(i.latency_ms * 0.9)) : 320;
    this.log(actor, 'integration.test', `${id}/${i.status}`);
    this.broadcastState();
    return { ok: true, integration: i };
  }

  /** 关停某路上行服务：模态健康随之变化，分析壳与现场壳在同一帧内看到降级 */
  setIntegration(id: string, status: Integration['status'], actor: string) {
    const i = this.state.integrations.find((x) => x.id === id);
    if (!i) return { error: 404 };
    i.status = status;
    const modality = INTEGRATION_MODALITY[id];
    if (modality) this.setModality(modality, status === 'ok' ? 'ok' : status === 'degraded' ? 'degraded' : 'off');
    else this.state.modality_health = this.healthFromIntegrations();
    this.log(actor, 'integration.set', `${id}/${status}`);
    this.broadcastState();
    return { ok: true, integration: i };
  }

  login(employee: string, pin: string) {
    const m = this.state.members.find((x) => x.id.toUpperCase() === employee.trim().toUpperCase());
    if (!m) return { error: 401, message: '工号不存在' };
    if (pin !== '1234') return { error: 401, message: '口令错误，连续 3 次失败锁定 15min' };
    if (this.state.form === 'D' && !m.forms.includes('D')) return { error: 403, message: '该成员未获授权形态 D' };
    this.state.viewer = { person: m.name, channel: this.state.viewer.channel };
    m.online = true;
    this.log(m.name, 'auth.login', m.seat);
    this.broadcastState();
    return { ok: true, member: m, token: `demo-${m.id}` };
  }

  logout(actor: string) {
    const m = this.state.members.find((x) => x.name === actor);
    if (m) m.online = false;
    this.log(actor, 'auth.logout', m?.seat ?? '—');
    this.broadcastState();
    return { ok: true };
  }

  /** 判定门控的统一返回：被裁掉时给出原因，供实时审计与离线产物共用一套措辞 */
  private gate<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
  private blocked(reason: string): { ok: false; reason: string } { return { ok: false, reason }; }

  /** 逐句原文成链。说话人分离是推断而非事实：通道降级按比例压低置信度，关停则直接标「未分离」 */
  private buildTurn(turn: Turn, diarState: ModalityState): DialogueTurn {
    return {
      event: 'dialogue',
      ts: turn.ts,
      speaker: turn.speaker,
      text: turn.text,
      speech_rate: turn.rate,
      diar_state: diarState,
      diar_confidence:
        diarState === 'off' ? null : +((turn.diar_conf ?? 0.9) * (diarState === 'degraded' ? 0.72 : 1)).toFixed(2),
    };
  }

  /** 语义边界成链。语义通道不可用时整条不产出——不是给 0 分，是删键 */
  private buildImpact(
    topic: (typeof TOPICS)[number],
    health: Record<ModalityKey, ModalityState>,
  ): { ok: true; value: ImpactEvent } | { ok: false; reason: string } {
    if (health.semantic === 'off') return this.blocked('语义通道不可用，话题与影响值整体不产出');
    return this.gate({
      event: 'impact',
      ts: topic.ts,
      topic_id: topic.id,
      boundary: [topic.ts, topic.end],
      label: topic.label,
      impact_score: topic.score,
      dims: topic.dims,
      rationale_text: topic.rationale,
      boundary_evidence: topic.boundary_evidence,
    });
  }

  /** 单条异常的完整成链判定（模态门控 → 观察层裁剪 → 规则门控 → 置信度折算）。
   *  实时 tick 与离线批分析调的是同一个函数：离线跑出来的 EV 必须和现场监看看到的一致，
   *  否则同一份脚本会有两套口径，实测时一句"两边数字不一样"就能问穿。 */
  private buildAnomaly(
    a: AnomalySpec,
    evtId: string,
    sessionId: string,
    health: Record<ModalityKey, ModalityState>,
  ): { ok: true; value: AnomalyEvent } | { ok: false; reason: string } {
    const avail = (m: ModalityKey) => health[m] !== 'off';
    if (!avail(a.modality)) return this.blocked(`${MODALITY_LABEL[a.modality]}通道不可用，本条不上报`);

    const keptObs = a.attribution.observation.filter((o) => avail(o.modality));
    const droppedObs = a.attribution.observation.length - keptObs.length;
    if (!keptObs.length) return this.blocked('观察层全部失效');

    const observation = droppedObs
      ? [
          ...keptObs,
          {
            modality: a.modality,
            text: `（${a.attribution.observation
              .filter((o) => !avail(o.modality))
              .map((o) => MODALITY_LABEL[o.modality])
              .join('/')} 通道关停，本条观察未计入融合）`,
            ts_from: keptObs[0].ts_from,
            ts_to: keptObs[keptObs.length - 1].ts_to,
          },
        ]
      : keptObs;

    const ruleEnabled = (ruleId: string) =>
      !this.state.rules.some((r) => r.id === ruleId) || this.state.rules.some((r) => r.id === ruleId && r.enabled);
    const baseRules = a.attribution.candidate_rules;
    const candidate_rules = baseRules.map((r) => ({ ...r, hit: r.hit && ruleEnabled(r.rule_id) }));
    const baseHits = baseRules.filter((r) => r.hit).length;
    const keptHits = candidate_rules.filter((r) => r.hit).length;
    if (baseHits > 0 && keptHits === 0) return this.blocked('候选规则全部停用，本条不上报');

    // 聚合升级的成立条件写进代码而不是只写在说明里：同窗可用模态不足三路，就不许拼故事
    const distinct = new Set(keptObs.map((o) => o.modality)).size;
    if (candidate_rules.some((r) => r.hit && r.rule_id === 'R-FUS-02') && distinct < 3)
      return this.blocked(`同窗可用模态仅 ${distinct} 路（<3），聚合升级条件不成立`);

    const confidence = +(
      a.confidence *
      (droppedObs ? keptObs.length / a.attribution.observation.length : 1) *
      (baseHits > keptHits ? keptHits / baseHits : 1)
    ).toFixed(2);

    return this.gate({
      event: 'anomaly',
      id: evtId,
      session_id: sessionId,
      ts: a.ts,
      modality: a.modality,
      type: a.type,
      severity: a.severity as Severity,
      confidence,
      lamp: a.lamp,
      advice: a.advice,
      attribution: { ...a.attribution, observation, candidate_rules },
    });
  }

  private tick() {
    const s = this.state;
    s.clock = +(s.clock + (TICK_MS / 1000) * s.speed).toFixed(2);
    if (s.clock > SCRIPT_LENGTH) {
      this.endSession();
      return;
    }
    s.buffer_seconds = this.weakNetwork
      ? Math.min(45, s.buffer_seconds + 1.5)
      : Math.max(0, s.buffer_seconds - 1);
    // 形态 D 的音频切片只驻留内存队列，回传校验成功后擦除
    if (s.form === 'D') s.local_cache_bytes = Math.round(Math.min(96, s.local_cache_bytes + 0.6) * 10) / 10;

    const curve = baseCurve(s.clock);
    let lamp: FusionTick['lamp'] = 'green';
    let advice = s.advice;

    const near = ANOMALIES.filter((a) => s.clock >= a.ts && s.clock - a.ts < 14);
    if (near.some((a) => a.severity === 'ESCALATED')) {
      lamp = 'red';
      advice = '呼叫后方·建议暂停核实';
    } else if (near.some((a) => a.severity === 'ALERT')) {
      lamp = 'orange';
      advice = '追问 10·12 记录归属';
    } else if (near.length) {
      lamp = 'orange';
      advice = '放慢语速复述问题';
    } else {
      lamp = s.lamp === 'red' ? 'red' : 'green';
    }
    s.lamp = lamp;
    s.advice = advice;

    const fusion: FusionTick = {
      event: 'partial_fusion',
      ts: s.clock,
      ...curve,
      risk_score: Math.round(curve.tension * 0.5 + curve.emotion * 0.3 + (lamp === 'red' ? 30 : lamp === 'orange' ? 12 : 0)),
      lamp,
      advice,
      modality_health: s.modality_health,
      buffer_seconds: Math.round(s.buffer_seconds),
      local_analysis: s.form === 'A' || s.form === 'D',
    };
    this.emit(fusion);

    // 倍速回放时一个 tick 会跨过多个时间点：按「已到时刻」逐条补发，
    // 否则 10× 快进会把逐句原文整段跳过，分析席位看到的是"有异常、无原话"
    const dueTurns = TURNS.filter((t) => t.ts <= s.clock && !this.firedTurns.has(t.ts));
    for (const turn of dueTurns) {
      this.firedTurns.add(turn.ts);
      const dia = s.integrations.find((x) => x.id === 'IN-DIA');
      const evt = this.buildTurn(turn, (dia?.status ?? 'ok') as ModalityState);
      // 快照里留最近 60 轮，让中途接入的分析席位也能立刻看到上下文（现场壳通道不下发）
      s.turns = [...s.turns, evt].slice(-60);
      this.emit(evt);
    }

    const topic = TOPICS.find((t) => !this.firedTopics.has(t.id) && s.clock >= t.ts);
    if (topic) {
      this.firedTopics.add(topic.id);
      const r = this.buildImpact(topic, s.modality_health);
      if (r.ok) {
        s.impacts = [...s.impacts, r.value];
        this.emit(r.value);
      } else {
        this.log('引擎 E2', 'impact.suppressed', `${topic.id}/${r.reason}`);
      }
    }

    ANOMALIES.forEach((a, i) => {
      if (this.firedAnomalies.has(i) || s.clock < a.ts) return;
      this.firedAnomalies.add(i);
      const evtId = `EV-${String(i + 1).padStart(3, '0')}`;
      const r = this.buildAnomaly(a, evtId, s.session_id, s.modality_health);
      if (!r.ok) {
        this.log('引擎 E2', 'anomaly.suppressed', `${evtId}/${r.reason}`);
        return;
      }
      const evt = r.value;
      s.anomalies = [...s.anomalies, evt];
      // 每条检测事件同时进入标注队列，分析侧的复核与回流因此是实时可见的而不是结束后补录。
      // 实时会话的标注用 AN-L 前缀，与历史会话播种的 AN-0xx 严格隔离（否则 React key 与队列计数撞车）。
      const anId = `AN-L${evt.id.slice(3)}`;
      if (!s.annotations.some((x) => x.id === anId)) {
        s.annotations = [
          ...s.annotations,
          {
            id: anId, session_id: evt.session_id, ev_id: evt.id, ts: evt.ts,
            modality: evt.modality, model_label: evt.attribution.conclusion.psych_state || evt.type,
            model_confidence: evt.confidence,
            rule_id: evt.attribution.candidate_rules.find((r) => r.hit)?.rule_id ?? '-',
            human_label: null, reviewer: null, status: 'pending', note: '',
          },
        ];
      }
      this.emit(evt);
      this.log('引擎 E2', 'anomaly.detect', `${evt.id}/${a.type}`);
    });

    // 呼叫超时链路：广播阈值取 Admin 门控 auto_escalate_seconds，超阈值 +15s 升级值班长
    const base = this.state.admin.auto_escalate_seconds;
    s.tickets.forEach((t) => {
      if (t.status !== 'PENDING') return;
      const age = s.clock - t.created_at;
      if (age > base + 15 && t.escalated !== 'urgent') {
        t.escalated = 'urgent';
        this.log('系统', 'task.timeout_urgent', t.id);
        this.emit({ event: 'modality_status', ts: s.clock, modality_health: s.modality_health, banner: `呼叫 ${t.id} 超时未受理，已升级值班长` });
      } else if (age > base && t.escalated === 'none') {
        t.escalated = 'broadcast';
        this.log('系统', 'task.timeout_broadcast', t.id);
        this.emit({ event: 'modality_status', ts: s.clock, modality_health: s.modality_health, banner: `呼叫 ${t.id} 超时未受理，已向全部席位广播` });
      }
    });
  }

  private emit(evt: ServerEvent) {
    this.listeners.forEach((fn) => fn(evt));
  }

  private broadcastState() {
    this.emit({ event: 'state', ts: this.state.clock, payload: this.state });
  }

  /** R6：审计只读追加，每条带 seq / prev_hash / hash，构成可校验的哈希链 */
  private log(actor: string, action: string, resource: string) {
    const prev = this.state.audit[this.state.audit.length - 1];
    const seq = (prev?.seq ?? 0) + 1;
    const ts = this.state.clock;
    const prev_hash = prev?.hash ?? GENESIS;
    this.state.audit = [
      ...this.state.audit.slice(-199),
      { seq, ts, actor, action, resource, prev_hash, hash: sha256(`${seq}|${ts}|${actor}|${action}|${resource}|${prev_hash}`) },
    ];
  }

  /** 在保留窗口内逐条复算：hash 对不上=被改写；prev_hash 接不上=被抽走或插入。
   *  窗口首条的父条目已按保留策略丢弃，只复算自身 hash，不断言其链位。 */
  verifyAudit() {
    const list = this.state.audit;
    const broken: number[] = [];
    list.forEach((e, i) => {
      if (sha256(`${e.seq}|${e.ts}|${e.actor}|${e.action}|${e.resource}|${e.prev_hash}`) !== e.hash) return broken.push(e.seq);
      const expectPrev = i === 0 ? (e.seq === 1 ? GENESIS : null) : list[i - 1].hash;
      if (expectPrev !== null && expectPrev !== e.prev_hash) broken.push(e.seq);
    });
    return { checked: list.length, head_seq: list[0]?.seq ?? 0, tail_seq: list[list.length - 1]?.seq ?? 0, broken, ok: broken.length === 0 };
  }

  snapshot(): DemoState {
    return JSON.parse(JSON.stringify(this.state));
  }

  /* ── Admin 数据台账 ─────────────────────────────────────────────────────
   * 台账不是第二套数据：每一行都从 state.anomalies / state.rules / state.annotations
   * / state.audit 现算拼接，所以"台账里对不上"等价于"判定链本身有问题"。 */

  ledger(): Ledger {
    const s = this.state;
    const auditSeqOf = (evId: string) =>
      s.audit.find((s2) => s2.action === 'anomaly.detect' && s2.resource.startsWith(`${evId}/`));
    const rows: LedgerRow[] = s.anomalies.map((a) => {
      const ann = s.annotations.find((x) => x.ev_id === a.id) ?? null;
      const logged = auditSeqOf(a.id);
      return {
        ev_id: a.id,
        session_id: a.session_id,
        ts: a.ts,
        modality: a.modality,
        type: a.type,
        severity: a.severity,
        confidence: a.confidence,
        observations: a.attribution.observation.map((o) => ({
          modality: o.modality, text: o.text, ts_from: o.ts_from, ts_to: o.ts_to,
        })),
        hit_rules: a.attribution.candidate_rules.filter((r) => r.hit).map((r) => r.rule_id),
        literature: a.attribution.candidate_rules.map((r) => {
          const live = s.rules.find((x) => x.id === r.rule_id);
          const ref = live?.literature_ref ?? r.literature_ref;
          return {
            rule_id: r.rule_id,
            ref,
            state: literatureState(ref),
            weight: live?.weight ?? r.weight,
            threshold: live?.threshold ?? 0,
            enabled: live?.enabled ?? false,
            source: live?.source ?? '内置',
            owner: live?.owner ?? '—',
            in_library: !!live,
          };
        }),
        counterfactual: a.attribution.conclusion.counterfactual,
        disclaimer: a.attribution.conclusion.disclaimer,
        annotation: ann && {
          id: ann.id, status: ann.status, human_label: ann.human_label, reviewer: ann.reviewer, note: ann.note,
        },
        audit: logged ? { action: logged.action, seq: logged.seq } : null,
      };
    });

    const count = (action: string) => s.audit.filter((x) => x.action === action).length;
    const annotations = { pending: 0, confirmed: 0, false_positive: 0, 回流中: 0 } as Record<AnnotationStatus, number>;
    s.annotations.forEach((a) => (annotations[a.status] += 1));
    const verify = this.verifyAudit();

    return {
      generated_at: now(),
      clock: s.clock,
      session_id: s.session_id,
      form: s.form,
      provenance_note:
        '本台账的行来自演示脚本回放与原型种子，数值是脚本真值而非真实采集结果；' +
        '它证明的是判定链可追溯（事件→观察→规则→文献→标注→审计），不证明检测精度。',
      rows,
      rules: seed(s.rules),
      summary: {
        events: rows.length,
        suppressed: count('anomaly.suppressed'),
        annotations,
        rules: {
          total: s.rules.length,
          enabled: s.rules.filter((r) => r.enabled).length,
          attached: s.rules.filter((r) => literatureState(r.literature_ref) === 'attached').length,
          placeholder: s.rules.filter((r) => literatureState(r.literature_ref) === 'placeholder').length,
        },
        audit: { total: s.audit.length, head_seq: verify.head_seq, tail_seq: verify.tail_seq, chain_ok: verify.ok },
        exports: count('dataset.export'),
      },
    };
  }

  /** 导出即留痕：每次导出往哈希链追加一条 dataset.export，并把该条 seq 回给前端。
   *  这是 R6「导出操作入链」的可执行版本——评审可以拿回显的 seq 去审计页对。 */
  exportLedger(actor: string, scope: 'events' | 'rules') {
    const m = this.state.members.find((x) => x.name === actor);
    if (!m) return { error: 403, message: `导出需以在册成员身份进行（${actor || '未占席'} 不在成员表）` };
    if (m.role === 'collector') return { error: 403, message: '采集员角色无导出权限（R7：判断权归 viewer）' };

    const led = this.ledger();
    const csv = scope === 'events' ? ledgerCsv(led) : rulesCsv(led);
    this.log(actor, 'dataset.export', `${scope}/rows=${led.rows.length}/sha=${sha256(csv).slice(0, 12)}`);
    const entry = this.state.audit[this.state.audit.length - 1];
    return {
      ok: true,
      scope,
      rows: scope === 'events' ? led.rows.length : led.rules.length,
      csv,
      filename: `minddialogue_${scope}_${entry.seq}.csv`,
      audit_seq: entry.seq,
      hash: entry.hash.slice(0, 12),
    };
  }
}

/** 值守屏与移动复核要回答的是"哪一路需要人"，不是离线批分析的归因明细与逐句原文。
 *  产物挂在 session.offline 上，裁剪点就必须覆盖它——否则接一条只读通道就能绕过 R7。 */
const stripOffline = (list: SessionSummary[]): SessionSummary[] =>
  list.map((x) => ({
    ...x,
    offline: undefined,
    offline_job: x.offline_job ? { progress: x.offline_job.progress, stage: '离线批分析进行中' } : null,
  }));

/** 通道投影：服务端出网前的唯一裁剪点。前端隐藏不作为安全边界。 */
export function project(evt: ServerEvent, channel: Channel): ServerEvent | null {  if (channel === 'workstation') return evt;

  if (channel === 'field') {
    switch (evt.event) {
      case 'partial_fusion':
        return {
          event: 'partial_fusion',
          ts: evt.ts,
          lamp: evt.lamp,
          advice: evt.advice,
          modality_health: evt.modality_health,
          buffer_seconds: evt.buffer_seconds,
          local_analysis: evt.local_analysis,
        } as FusionTick;
      case 'anomaly':
        return {
          event: 'anomaly',
          id: evt.id,
          session_id: evt.session_id,
          ts: evt.ts,
          severity: evt.severity,
          lamp: evt.lamp,
          advice: evt.advice,
        } as AnomalyEvent;
      case 'impact':
        // 现场壳只给一根影响度条：维度分解、边界与 rationale 属归因细节，不出网
        return {
          event: 'impact',
          ts: evt.ts,
          topic_id: evt.topic_id,
          label: evt.label,
          impact_score: evt.impact_score,
        } as ImpactEvent;
      case 'dialogue':
        return null;
      case 'modality_status':
        return { event: 'modality_status', ts: evt.ts, modality_health: evt.modality_health, banner: evt.banner };
      case 'field.marker':
        return { event: 'field.marker', ts: evt.ts, collector_id: evt.collector_id, device_id: evt.device_id, ack: evt.ack };
      case 'field.call_requested':
        return { event: 'field.call_requested', ts: evt.ts, ticket_id: evt.ticket_id, reason_code: evt.reason_code, session_id: evt.session_id, at_ts: evt.at_ts };
      case 'viewer.disposition_recorded':
        return {
          event: 'viewer.disposition_recorded',
          ts: evt.ts,
          ticket_id: evt.ticket_id,
          lamp_level: evt.lamp_level,
          advice_text: evt.advice_text,
        } as DispositionEvent;
      case 'report':
        return { event: 'report', ts: evt.ts, session_id: evt.session_id, status: evt.status, capture_form: evt.capture_form, modality_set: evt.modality_set };
      case 'state': {
        const s = evt.payload;
        return {
          event: 'state',
          ts: evt.ts,
          payload: {
            ...s,
            // 对话逐字稿与逐句原文不下发现场壳（与 dialogue → null 保持一致）
            turns: [],
            // 分析侧业务对象一律不出网：现场壳拿到的是空集合，即使被逆向也读不到归因与规则
            sessions: [],
            reports: [],
            annotations: [],
            rules: [],
            members: [],
            integrations: [],
            audit: [],
            // 配置对象只下发现场壳门控真正要读的三位：R8 未启用即无入口、留存策略展示、D 白名单展示。
            // 升级阈值与标注回流属后台口径，不随现场平板出网——平板是物理上离对象最近的一台设备。
            admin: {
              form_d_enabled: s.admin.form_d_enabled,
              modality_whitelist_d: s.admin.modality_whitelist_d,
              retention_days: s.admin.retention_days,
            } as AdminFlags,
            // 与 field 实时帧同 policy：只留灯色与建议，连 modality/type 这类归因线索也不留
            anomalies: s.anomalies.map((a) => ({
              id: a.id,
              session_id: a.session_id,
              ts: a.ts,
              severity: a.severity,
              lamp: a.lamp,
              advice: a.advice,
            } as AnomalyEvent)),
            impacts: s.impacts.map((i) => ({
              event: 'impact' as const,
              ts: i.ts,
              topic_id: i.topic_id,
              label: i.label,
              impact_score: i.impact_score,
            } as ImpactEvent)),
          },
        };
      }
    }
  }

  if (channel === 'wall') {
    switch (evt.event) {
      case 'anomaly': {
        const { attribution, ...rest } = evt;
        return {
          ...rest,
          attribution: {
            observation: [],
            candidate_rules: [],
            conclusion: { ...attribution.conclusion, counterfactual: '' },
          },
        } as AnomalyEvent;
      }
      case 'dialogue':
        return null;
      case 'state':
        // 值守视图只渲染态势：逐句原文、审计与配置类对象不出网
        return {
          ...evt,
          payload: {
            ...evt.payload,
            turns: [],
            audit: [],
            reports: [],
            annotations: [],
            rules: [],
            members: [],
            integrations: [],
            // 值守屏不渲染任何后台配置位，配置对象整块不出网
            admin: {} as AdminFlags,
            sessions: stripOffline(evt.payload.sessions),
            // 快照里的 anomalies 必须与实时帧同 policy，否则中途接入即可绕过裁剪
            anomalies: evt.payload.anomalies.map((a) => ({
              ...a,
              attribution: {
                observation: [],
                candidate_rules: [],
                conclusion: { ...a.attribution.conclusion, counterfactual: '' },
              },
            })),
          },
        };
      default:
        return evt;
    }
  }

  if (channel === 'mobile-h5') {
    switch (evt.event) {
      case 'anomaly': {
        const { attribution, ...rest } = evt;
        return {
          ...rest,
          attribution: {
            observation: [],
            candidate_rules: attribution.candidate_rules,
            conclusion: attribution.conclusion,
          },
        } as AnomalyEvent;
      }
      case 'dialogue':
        return null;
      case 'state':
        // 移动复核延伸可看待办与处置，但配置类对象（规则库 / 集成 / 成员 / 审计）只在桌面工作台出网
        return {
          ...evt,
          payload: {
            ...evt.payload,
            turns: [],
            audit: [],
            rules: [],
            members: [],
            integrations: [],
            // 移动复核只做待办与轻处置，门控参数与规则库口径属后台，不出网
            admin: {} as AdminFlags,
            sessions: stripOffline(evt.payload.sessions),
            // 与 mobile-h5 实时帧同 policy：观察层原文不出网，保留候选规则与结论供轻处置
            anomalies: evt.payload.anomalies.map((a) => ({
              ...a,
              attribution: { ...a.attribution, observation: [] },
            })),
          },
        };
      default:
        return evt;
    }
  }

  return evt;
}

function now(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ── 台账 CSV：严格表头 + 数据，不塞说明行。
 * 数据来源声明留在界面上（Ledger.provenance_note），不混进表里——
 * 一份要给别人做透视的 CSV，多一行前言就废掉一次使用。
 * BOM 是给 Excel 的，没有它中文列在 Windows Excel 里必乱码。 */
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvDoc = (header: string[], rows: unknown[][]) =>
  '\ufeff' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');

/** 导出件与界面页脚共用同一句声明（R2）：导出件离开系统之后，仍要能自己说清边界。 */
const DISCLAIMER_TEXT =
  '本系统输出行为风险提示，不构成临床心理诊断；所有结论为模型推断，最终判断由现场人员与后方分析师共同作出';

/** 素材类型决定可用模态：音频没有画面帧，视觉三路 + 生理按「不可用」处理。
 *  这里是 off 而不是 0 分——"没信号"和"有信号但没检出异常"是两件事，混为一谈就是误导。
 *  扩展信号（近红外 / 毫米波）不走这条链：它们各自的成链见 buildExtensionSlice。 */
const offlineHealth = (kind: AssetKind): Record<ModalityKey, ModalityState> => ({
  voice: 'ok',
  semantic: 'ok',
  face: kind === 'audio' ? 'off' : 'ok',
  pose: kind === 'audio' ? 'off' : 'ok',
  hand: kind === 'audio' ? 'off' : 'ok',
  physio: kind === 'audio' ? 'off' : 'ok',
});

const isExtKind = (k: AssetKind): k is ExtKind => k === 'nir' || k === 'mmwave';

/** 会话的素材清单：assets 是多信号源口径；历史种子只有单条 asset，读取时统一补齐 */
const assetsOf = (s: SessionSummary): AssetRef[] =>
  s.assets?.length
    ? s.assets
    : s.asset
      ? [{ id: 'AS-01', name: s.asset.name, size_bytes: s.asset.size_bytes, duration_seconds: s.asset.duration_seconds, kind: s.asset.kind }]
      : [];

/** 脚本判定链的通道健康度：只由音视频主素材决定。
 *  扩展信号即使登记了也不并入这条链——脚本里的生理观察是 rPPG（从画面帧反推）口径，
 *  让近红外文件去承接它，等于把两路不同估计量混成一件事。 */
const scriptHealth = (av: AssetRef[]): Record<ModalityKey, ModalityState> => {
  const keys = Object.keys(offlineHealth('audio')) as ModalityKey[];
  return keys.reduce<Record<ModalityKey, ModalityState>>((acc, k) => {
    acc[k] = av.some((a) => offlineHealth(a.kind)[k] !== 'off') ? 'ok' : 'off';
    return acc;
  }, { voice: 'off', semantic: 'off', face: 'off', pose: 'off', hand: 'off', physio: 'off' });
};

/** 一条异常的证据来自哪些素材：观察层用到的模态，逐个回落到能提供该模态的文件 */
const carriersOf = (ev: AnomalyEvent, av: AssetRef[]): AssetRef[] => {
  const mods = new Set(ev.attribution.observation.map((o) => o.modality));
  mods.add(ev.modality);
  const hit = av.filter((a) => [...mods].some((m) => offlineHealth(a.kind)[m] !== 'off'));
  return hit.length ? hit : av.slice(0, 1);
};

const avSteps = (kind: AssetKind): string[] =>
  kind === 'audio'
    ? [
        '解封装与时长校验：读取容器元数据，不做全片转码',
        '语音通道：VAD 分段 / ASR 转写 / 说话人分离',
        '语音特征：eGeMAPS 声学参数与基频轨迹',
        '语义通道：话题切分与四维影响值',
        '视觉与生理通道：素材无画面帧，四路按不可用处理（不产出 0 值）',
      ]
    : [
        '解封装与时长校验：读取容器元数据，不做全片转码',
        '语音通道：VAD 分段 / ASR 转写 / 说话人分离',
        '语音特征：eGeMAPS 声学参数与基频轨迹',
        '语义通道：话题切分与四维影响值',
        '视觉通道：AU 表情单元 / 姿态关键点 / 手部自触及',
        '生理通道：rPPG HRV 与唤醒度轨迹',
      ];

/** 报告首屏的精度受限声明：一个失效原因占一条，不合并成一句"部分通道受限"——
 *  读者要能在现场照着逐条说出"哪一路为什么没数"。 */
const precisionNote = (r: OfflineResult): string | null => {
  const parts: string[] = [];
  if (!r.assets.some((a) => a.kind === 'video'))
    parts.push('本会话无视频素材：面部表情、身体姿态、手部动作三路无可用信号帧，本次未纳入判定——这是"没有信号"，不是"检测正常"。');
  const ext = r.slices.filter((x) => x.role === 'extension');
  if (ext.length)
    parts.push(
      `扩展信号素材 ${ext.length} 份（${ext.map((x) => ASSET_KIND_LABEL[x.kind]).join('、')}）以文件级导入参与分析，结论只到生理趋势层：不进 ESCALATED、不出心理归因。` +
        '它与视频 rPPG 是两个不同估计量，不可互为校验（演示脚本里两路共用一条唤醒度基线，真实设备上两路估计误差不相关）。',
    );
  r.slices
    .filter((x) => x.quality === 'degraded')
    .forEach((x) => parts.push(`素材 ${x.asset_name} 质量降级：${x.quality_note}`));
  return parts.length ? parts.join(' ') : null;
};

type ExtensionSlice = { asset: AssetRef; slice: OfflineSlice; events: AnomalyEvent[] };

/** 批处理阶段只负责把"这是一次离线跑批、按素材逐片推进"演在屏上；
 *  判定结果已由 runOfflinePass 一次算完。进度按素材切片分段，最后一段是会话级融合。 */
const offlineStages = (assets: AssetRef[], r: OfflineResult): OfflineStageStep[] => {
  const labels = assets.flatMap((a) =>
    (isExtKind(a.kind) ? EXT_SIGNALS[a.kind].steps : avSteps(a.kind)).map((stage) => ({
      stage,
      asset: a.name,
      asset_kind: a.kind,
    })),
  );
  const total = labels.length + 1;
  const steps: OfflineStageStep[] = labels.map((l, i) => ({
    progress: Math.round(((i + 1) / total) * 92),
    stage: `〔${a_short(l.asset)}〕${l.stage}`,
    asset: l.asset,
    asset_kind: l.asset_kind,
  }));
  steps.push({
    progress: 96,
    stage: `融合判定与报告起草：素材 ${assets.length} 份全部参与 / 上报 ${r.anomalies.length} 条 / 裁撤 ${r.suppressed.length} 条`,
    asset: null,
    asset_kind: null,
  });
  return steps;
};

const a_short = (name: string) => (name.length > 18 ? `${name.slice(0, 8)}…${name.slice(-8)}` : name);

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/** 报告导出件：自包含 HTML（内联样式，不依赖前端资源），浏览器直接打印即为归档版式。
 *  水印、来源口径、审批流水、免责四块都必须随件出网——离开系统的报告不能只剩结论。 */
function reportHtml(r: Report, watermark: string | null, session?: SessionSummary): string {
  const assetList: AssetRef[] =
    r.assets ??
    (r.asset ? [{ id: 'AS-01', name: r.asset.name, size_bytes: r.asset.size_bytes, duration_seconds: r.asset.duration_seconds, kind: r.asset.kind }] : []);
  const originNote =
    r.origin === 'imported'
      ? `离线导入 · 非实时（素材 ${assetList.length} 份：${assetList.map((a) => `${a.name}·${ASSET_KIND_LABEL[a.kind]}`).join('；') || '未登记'}）`
      : '现场实时采集';
  const rows = r.revisions
    .map((x) => `<tr><td class="mono">${esc(x.ts)}</td><td>${esc(x.actor)}</td><td>${esc(x.action)}</td><td>${esc(x.note ?? '')}</td></tr>`)
    .join('');
  // 切片一览直接从会话产物取：报告正文是段落，评审要看"每个文件到底出了什么"需要一张表
  const slices = session?.offline?.slices ?? [];
  const sliceRows = slices
    .map(
      (x) =>
        `<tr><td>${esc(x.asset_name)}</td><td>${esc(ASSET_KIND_LABEL[x.kind])}</td><td>${x.role === 'extension' ? '扩展信号' : '主信号'}</td>` +
        `<td>${x.modality_available.map((m) => MODALITY_LABEL[m]).join('·') || '—'}</td>` +
        `<td>${x.modality_unavailable.map((m) => MODALITY_LABEL[m]).join('·') || '—'}</td>` +
        `<td class="mono">${x.event_ids.length || '—'}</td><td>${x.quality === 'ok' ? '达标' : '降级'}</td>` +
        `<td>${x.role === 'extension' ? '只到生理趋势层，不出归因' : '可出归因'}</td></tr>`,
    )
    .join('');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(r.title)} · ${esc(r.id)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm }
  body { margin:0; padding:32px 40px; color:#1c2330; font:14px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; background:#fff }
  .wm { position:fixed; inset:0; pointer-events:none; display:flex; align-items:center; justify-content:center; overflow:hidden }
  .wm span { font-size:74px; font-weight:700; color:rgba(207,19,34,.09); transform:rotate(-28deg); white-space:pre-wrap; line-height:2.4 }
  h1 { font-size:21px; margin:0 0 6px }
  .meta { font-size:12px; color:#5a677f; border-bottom:2px solid #1c2330; padding-bottom:12px; margin-bottom:18px }
  .badge { display:inline-block; font-size:11.5px; padding:1px 8px; border-radius:10px; border:1px solid #722ed1; color:#722ed1; margin-left:6px }
  .badge.draft { border-color:#cf1322; color:#cf1322 }
  section { margin:16px 0 }
  h3 { font-size:15px; margin:0 0 4px; color:#123 }
  p { margin:0 }
  table { border-collapse:collapse; width:100%; font-size:12px; margin-top:6px }
  th,td { border:1px solid #dfe3ea; padding:5px 8px; text-align:left }
  th { background:#f5f7fa }
  .mono { font-family:ui-monospace,Menlo,Consolas,monospace }
  .warn { background:#fff7e6; border-left:3px solid #d46b08; padding:8px 12px; font-size:12.5px; margin:10px 0 }
  .disc { margin-top:22px; padding-top:10px; border-top:1px dashed #b9c6de; font-size:12px; color:#3d4a63 }
  .foot { margin-top:8px; font-size:11px; color:#8d97a8 }
</style></head>
<body>
${watermark ? `<div class="wm"><span>${esc(watermark)}\n${esc(watermark)}\n${esc(watermark)}</span></div>` : ''}
<h1>${esc(r.title)}</h1>
<div class="meta">
  报告号 <b class="mono">${esc(r.id)}</b> · 会话 <span class="mono">${esc(r.session_id)}</span> · 对象 ${esc(r.subject_code)}
  <span class="badge">${originNote}</span>
  ${watermark ? `<span class="badge draft">${esc(watermark)}</span>` : ''}
  <div>状态 ${esc(r.status)} · 复核人 ${esc(r.reviewer ?? '—')} · 发布 ${esc(r.published_at ?? '未发布')} · 导出时间 ${esc(now())}</div>
</div>
${r.precision_note ? `<div class="warn">精度受限：${esc(r.precision_note)}</div>` : ''}
${r.sections.map((s) => `<section><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></section>`).join('')}
${sliceRows ? `<section><h3>附表 A · 素材切片一览</h3>
<table><thead><tr><th>素材文件</th><th>信号源</th><th>角色</th><th>可解析模态</th><th>不可用模态</th><th>支撑事件数</th><th>信号质量</th><th>结论上限</th></tr></thead><tbody>${sliceRows}</tbody></table>
<p style="font-size:12px;color:#3d4a63">扩展信号列出的"只到生理趋势层"是本版本的口径上限（文件级导入、未做个体标定、无硬件在线接入），不是该路信号未检出异常。</p></section>` : ''}
<section><h3>附表 B · 修订与审批流水</h3>
<table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>备注</th></tr></thead><tbody>${rows}</tbody></table></section>
<div class="disc">${esc(DISCLAIMER_TEXT)}。</div>
<div class="foot">数据来源：演示脚本回放与原型种子，数值为脚本真值而非真实采集结果，不证明检测精度。
${session ? `采集形态 ${esc(session.form)} · 授权文书 ${esc(session.consent_doc)} · 会话时长 ${session.duration_seconds}s。` : ''}
导出未加密（SM4 封装未实现），本件为明文 HTML。</div>
</body></html>`;
}

function ledgerCsv(led: Ledger): string {
  return csvDoc(
    [
      '事件号', '会话', '时刻(s)', '模态', '异常类型', '严重度', '融合置信度',
      '命中规则', '规则文献支撑', '文献状态', '是否登记入规则库', '规则责任人',
      '观察层证据', '反事实必查条件', '免责声明', '标注号', '标注状态', '人工标签', '复核人', '复核备注', '审计seq',
    ],
    led.rows.map((r) => [
      r.ev_id, r.session_id, r.ts, MODALITY_LABEL[r.modality], r.type, r.severity, r.confidence,
      r.hit_rules.join(' | ') || '（无命中，仅观察层）',
      r.literature.map((l) => l.ref).join(' | '),
      r.literature.map((l) => litLabel(l.state)).join(' | '),
      r.literature.map((l) => (l.in_library ? '是' : '否')).join(' | '),
      r.literature.map((l) => l.owner).join(' | '),
      r.observations.map((o) => `[${MODALITY_LABEL[o.modality]} ${o.ts_from}–${o.ts_to}s] ${o.text}`).join(' ⏐ '),
      r.counterfactual,
      r.disclaimer,
      r.annotation?.id ?? '（未进队列）',
      r.annotation?.status ?? '-',
      r.annotation?.human_label ?? '-',
      r.annotation?.reviewer ?? '-',
      r.annotation?.note ?? '',
      r.audit?.seq ?? '缺失',
    ]),
  );
}

function rulesCsv(led: Ledger): string {
  const cited = new Map<string, number>();
  led.rows.forEach((r) => r.literature.forEach((l) => cited.set(l.rule_id, (cited.get(l.rule_id) ?? 0) + 1)));
  return csvDoc(
    ['规则号', '观察模式', '心理状态', '文献支撑', '文献状态', '权重', '阈值', '启用', '来源', '责任人', '最近更新', '累计命中', '本会话被引用'],
    led.rules.map((x) => [
      x.id, x.pattern, x.psych_state, x.literature_ref,
      litLabel(literatureState(x.literature_ref)), x.weight, x.threshold, x.enabled ? '是' : '否',
      x.source, x.owner, x.updated_at, x.hits, cited.get(x.id) ?? 0,
    ]),
  );
}
