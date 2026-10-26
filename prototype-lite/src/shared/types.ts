/* 「言心」原型共享类型 —— 与《技术架构与详细设计文档》§5.1 / §6.1 对齐 */

export type Severity = 'INFO' | 'WARN' | 'ALERT' | 'ESCALATED';
export type LampLevel = 'green' | 'orange' | 'red';
export type DeploymentForm = 'A' | 'B' | 'C' | 'D';
export type ModalityKey = 'voice' | 'semantic' | 'face' | 'pose' | 'hand' | 'physio';
export type ModalityState = 'ok' | 'degraded' | 'off';

/** 订阅通道：服务端按此裁剪载荷（R7 红线的实现点） */
export type Channel = 'workstation' | 'wall' | 'mobile-h5' | 'field';

export interface Attribution {
  observation: Array<{ modality: ModalityKey; text: string; ts_from: number; ts_to: number }>;
  candidate_rules: Array<{
    rule_id: string;
    pattern: string;
    psych_state: string;
    literature_ref: string;
    weight: number;
    hit: boolean;
  }>;
  conclusion: {
    psych_state: string;
    confidence: number;
    counterfactual: string;
    disclaimer: string;
  };
}

export interface AnomalyEvent {
  run_id?: string; participant_id?: string | null; source_event_ids?: string[];
  event: 'anomaly';
  id: string;
  session_id: string;
  ts: number;
  modality: ModalityKey;
  type: string;
  severity: Severity;
  confidence: number;
  lamp: LampLevel;
  advice: string;
  attribution: Attribution;
  /** 多信号源导入会话：本条观察层证据来自哪些素材。一份结论可由多路素材共同支撑，
   *  也必须能追溯到具体文件——否则"多信号融合"在导出件里就是一句无法核对的话 */
  source_assets?: Array<{ id: string; name: string; kind: AssetKind }>;
  /** 扩展信号（近红外 / 毫米波）产物的结论上限。有此字段即表示本条只到生理趋势层、不进心理归因 */
  cap_note?: string;
}

export interface FusionTick {
  event: 'partial_fusion';
  ts: number;
  emotion: number;
  tension: number;
  arousal: number;
  risk_score: number;
  lamp: LampLevel;
  advice: string;
  modality_health: Record<ModalityKey, ModalityState>;
  buffer_seconds: number;
  local_analysis: boolean;
}

export interface ImpactEvent {
  event: 'impact';
  ts: number;
  topic_id: string;
  boundary: [number, number];
  label: string;
  impact_score: number;
  dims: { 情绪冲击: number; 认知冲突: number; 利益相关: number; 持续影响: number };
  rationale_text: string;
  /** 语义边界切分依据：话题边界由哪个信号判定，非人工划定 */
  boundary_evidence: string;
}

export interface DialogueTurn {
  event: 'dialogue';
  ts: number;
  speaker: 'interviewer' | 'subject' | 'unknown' | 'overlap';
  id?: string; end?: number; asset_id?: string; participant_id?: string | null; speaker_id?: string | null;
  text: string;
  speech_rate?: number;
  /** 说话人分离置信度；分离通道关停时为 null，界面据此把角色标为「未分离」 */
  diar_confidence: number | null;
  diar_state: ModalityState;
}

export interface ModalityStatusEvent {
  event: 'modality_status';
  ts: number;
  modality_health: Record<ModalityKey, ModalityState>;
  banner: string | null;
}

export interface FieldMarkerEvent {
  event: 'field.marker';
  ts: number;
  collector_id: string;
  device_id: string;
  ack: boolean;
}

export interface CallRequestedEvent {
  event: 'field.call_requested';
  ts: number;
  ticket_id: string;
  reason_code: string;
  session_id: string;
  at_ts: number;
}

export interface DispositionEvent {
  event: 'viewer.disposition_recorded';
  ts: number;
  ticket_id: string;
  lamp_level: LampLevel;
  advice_text: string;
  /** 以下字段仅分析壳可见，现场壳通道会被服务端剔除 */
  claimed_by?: string;
  note?: string;
  confidence?: number;
}

export interface ReportEvent {
  event: 'report';
  ts: number;
  session_id: string;
  status: 'drafting' | 'ready';
  capture_form: DeploymentForm;
  modality_set: ModalityKey[];
  precision_note?: string;
}

export type ServerEvent =
  | FusionTick
  | AnomalyEvent
  | ImpactEvent
  | DialogueTurn
  | ModalityStatusEvent
  | FieldMarkerEvent
  | CallRequestedEvent
  | DispositionEvent
  | ReportEvent
  | { event: 'state'; ts: number; payload: DemoState };

export interface Ticket {
  id: string;
  session_id: string;
  requested_by: string;
  reason_code: string;
  status: 'PENDING' | 'CLAIMED' | 'RESOLVED' | 'CANCELLED';
  claimed_by: string | null;
  created_at: number;
  claimed_at: number | null;
  resolved_at: number | null;
  /** 超时链路：none → broadcast（超 3min 全席广播）→ urgent（超 5min 升级值班长） */
  escalated: 'none' | 'broadcast' | 'urgent';
}

/* ── 以下集合供分析壳 / Admin 终端使用，全部在服务端出口按通道剔除（R7） ───────── */

export type SessionStatus = 'draft' | 'live' | 'review' | 'closed';

/** 素材信号源类型。近红外 / 毫米波是招标 28.01「不限于语音、视频、近红外、毫米波」列举的扩展路，
 *  当前版本按文件登记并可参与分析，正式硬件接入需另做驱动与时间同步 */
export type AssetKind = 'video' | 'audio' | 'nir' | 'mmwave';

/** 一份上传素材的登记项。只存元数据（文件名 / 大小 / 时长），原型不落地文件内容 */
export interface AssetRef {
  upload_status?: string; sha256?: string;
  id: string;
  name: string;
  size_bytes: number;
  duration_seconds: number;
  kind: AssetKind;
}

/** 扩展信号（近红外 / 毫米波）的生理趋势：只到趋势层，不换算成心理量 */
export interface PhysioTrend {
  sensor_label: string;
  /** 采样点数与时基说明：时基来自素材登记时长，未知则按脚本时轴对齐并如实标注 */
  samples: number;
  time_base: '素材登记时长' | '脚本时轴（素材未提供时基）';
  metrics: Array<{
    name: string;
    unit: string;
    decimals: number;
    baseline: number;
    peak: number;
    peak_ts: number;
    end_value: number;
    series: number[];
  }>;
  /** 为什么这条趋势不能直接进归因（逐条独立陈述，不合并） */
  limits: string[];
}

/** 一份素材的解析切片：该文件贡献了什么、没贡献什么、结论走到哪一层为止 */
export interface OfflineSlice {
  asset_id: string;
  asset_name: string;
  kind: AssetKind;
  /** 主信号（音视频，走完整判定链）/ 扩展信号（只到生理趋势层） */
  role: 'primary' | 'extension';
  size_bytes: number;
  duration_seconds: number;
  modality_available: ModalityKey[];
  modality_unavailable: ModalityKey[];
  /** 解析链逐段说明，与批分析进度一一对应 */
  steps: string[];
  /** 本切片支撑的事件 id（主信号为脚本判定链产物，扩展信号为其自身趋势事件） */
  event_ids: string[];
  /** 被本切片裁掉且原因归属于本素材的条目 */
  suppressed: Array<{ id: string; reason: string }>;
  trend: PhysioTrend | null;
  /** 结论上限：扩展信号强制填写；主信号为 null 表示可出归因 */
  cap_note: string | null;
  /** 信号质量。低质量时界面标降级，不给它出 escalated */
  quality: 'ok' | 'degraded';
  quality_note: string;
}

export interface SessionSummary {
  revision?: number; stale?: boolean; restricted?: boolean; current_run_id?: string;
  participants?: Array<{ id: string; role: string; purposes: Record<string, boolean> }>;
  primary_asset_id?: string;
  corrections?: { turns: DialogueTurn[]; topics: Array<{ asset_id: string; boundary: [number, number]; label: string }> };
  id: string;
  subject_code: string;
  scene: string;
  form: DeploymentForm;
  collector: string;
  analyst: string | null;
  status: SessionStatus;
  started_at: string;
  duration_seconds: number;
  peak_lamp: LampLevel;
  anomaly_count: number;
  marker_count: number;
  consent_doc: string;
  modality_set: ModalityKey[];
  /** 数据来源：现场实时采集 live / 已有素材离线导入 imported。导入态不得与实时结论混为一类 */
  source: 'live' | 'imported';
  /** source=imported 时的素材登记。多信号源版本改用 assets，这条保留为首个素材（历史种子与旧报告兼容读它） */
  asset?: { name: string; size_bytes: number; duration_seconds: number; kind: AssetKind };
  /** source=imported 时登记的全部素材文件：上传后每一份都进入批分析并出现在报告里 */
  assets?: AssetRef[];
  /** 离线批分析进行中：进度与当前阶段。跑完即清空，产物落在 offline */
  offline_job?: { id?: string; status?: string; progress: number; stage: string; steps?: OfflineStageStep[] } | null;
  /** 离线批分析产物。与实时监看状态严格隔离：不写进 state.anomalies、不派发现场工单 */
  offline?: OfflineResult;
}

/** 批分析进度条上的一段：归属某一份素材（fusion 段 asset 为 null） */
export interface OfflineStageStep {
  progress: number;
  stage: string;
  asset: string | null;
  asset_kind: AssetKind | null;
}

/** 离线导入素材的批分析产物。可用模态由素材类型决定——音频没有画面帧，
 *  视觉与生理四路按「不可用」处理，其异常记入 suppressed 并写明原因，而不是给一个 0 分。 */
export interface OfflineResult {
  run_id?: string;
  narrative?: { status: string; text?: string; reason?: string; citations?: unknown[] };
  manifest?: unknown;
  finished_at: string;
  /** 首个主素材的类型，保留给旧导出件与历史报告读 */
  asset_kind: 'video' | 'audio';
  /** 会话登记的全部素材（含扩展信号） */
  assets: AssetRef[];
  /** 逐素材切片：每个文件各跑各的解析链，产物分开列，最后在会话层融合 */
  slices: OfflineSlice[];
  modality_available: ModalityKey[];
  duration_seconds: number;
  turns: DialogueTurn[];
  anomalies: AnomalyEvent[];
  impacts: ImpactEvent[];
  /** 被裁掉的条目：id + 原因。审计里同有一条 anomaly.suppressed 与之对应 */
  suppressed: Array<{ id: string; reason: string }>;
  report_id: string;
  /** 与实时链共用的判定口径版本号，导出件与审计对账时读这一行 */
  pipeline: string;
}

export type ReportStatus = 'drafting' | 'pending_review' | 'rejected' | 'approved' | 'published';

export interface ReportRevision {
  ts: string;
  actor: string;
  action: string;
  note?: string;
}

export interface Report {
  preview_sections?: Array<{key: string; title: string; text: string}>;
  version?: number; revision?: number; source_run_id?: string; content_hash?: string;
  grants?: Array<{ id: string; recipient: string; purpose: string; actions: string[]; expires_at: number; revoked: boolean }>;
  id: string;
  session_id: string;
  subject_code: string;
  title: string;
  status: ReportStatus;
  sections: Array<{ key: string; title: string; text: string }>;
  precision_note: string | null;
  /** 报告口径来源：缺省视为实时采集。导入件必须显式标「离线导入 · 非实时」，不与实时结论混为一类 */
  origin?: 'live' | 'imported';
  asset?: { name: string; kind: AssetKind; duration_seconds: number; size_bytes: number };
  /** 离线导入件登记的全部素材；导出件逐一列名，避免"只写了主素材、其余文件不见了" */
  assets?: AssetRef[];
  reviewer: string | null;
  revisions: ReportRevision[];
  published_at: string | null;
}

export type AnnotationStatus = 'pending' | 'confirmed' | 'false_positive' | '回流中';

export interface AnnotationItem {
  id: string;
  session_id: string;
  ev_id: string;
  ts: number;
  modality: ModalityKey;
  model_label: string;
  model_confidence: number;
  rule_id: string;
  human_label: string | null;
  reviewer: string | null;
  status: AnnotationStatus;
  note: string;
}

export interface Rule {
  id: string;
  pattern: string;
  psych_state: string;
  literature_ref: string;
  weight: number;
  threshold: number;
  enabled: boolean;
  owner: string;
  updated_at: string;
  hits: number;
  source: '内置' | '标注回流';
}

export type MemberRole = 'analyst' | 'reviewer' | 'collector' | 'admin' | 'reader' | 'auditor';

export interface Member {
  id: string;
  name: string;
  role: MemberRole;
  seat: string;
  online: boolean;
  forms: DeploymentForm[];
}

export interface Integration {
  id: string;
  name: string;
  kind: string;
  endpoint: string;
  status: 'ok' | 'degraded' | 'off';
  latency_ms: number;
  note: string;
}

export interface AdminFlags {
  /** R8 第一道门：关闭后手机端采集壳入口不加载（不是置灰） */
  form_d_enabled: boolean;
  field_view_enabled: boolean;
  modality_whitelist_d: ModalityKey[];
  retention_days: number;
  auto_escalate_seconds: number;
  annotation_reflow: boolean;
}

/** 只读追加的审计条目（R6）。
 *  hash = sha256(seq|ts|actor|action|resource|prev_hash)，prev_hash 取上一条 hash；
 *  改写、删除或抽走任一条，其后所有 prev_hash 断裂，校验见 GET /audit/verify。 */
export interface AuditEntry {
  seq: number;
  ts: number;
  actor: string;
  action: string;
  resource: string;
  prev_hash: string;
  hash: string;
}

export interface DemoState {
  session_id: string;
  running: boolean;
  clock: number;
  speed: number;
  form: DeploymentForm;
  field_view_enabled: boolean;
  consent: boolean;
  lamp: LampLevel;
  advice: string;
  modality_health: Record<ModalityKey, ModalityState>;
  buffer_seconds: number;
  /** 上行链路降级：现场端转入本机续采，恢复后续传（R5 显性告知） */
  weak_network: boolean;
  collector: { device: string; person: string; authed_until: number | null };
  viewer: { person: string; channel: Channel };
  markers: number[];
  tickets: Ticket[];
  anomalies: AnomalyEvent[];
  impacts: ImpactEvent[];
  /** 最近若干轮逐句原文；仅 workstation 通道下发，现场壳 / 值守 / 移动通道在服务端出口置空 */
  turns: DialogueTurn[];
  audit: AuditEntry[];
  sessions: SessionSummary[];
  reports: Report[];
  annotations: AnnotationItem[];
  rules: Rule[];
  members: Member[];
  integrations: Integration[];
  admin: AdminFlags;
  /** 本机缓存指纹：外勤回传校验通过后清空（R8 第三道门） */
  local_cache_bytes: number;
}

/* ── Admin 数据台账（GET /v1/admin/ledger）────────────────────────────────
 * 把「事件 → 观察层证据 → 命中规则 → 文献支撑 → 人工标注 → 审计留痕」拼成一行。
 * 全部字段由服务端当前状态即时派生，不存在第二套数据：台账里能对不上的，
 * 就说明判定链本身有问题。 */

/** 文献支撑的三态。只按 literature_ref 字面判定，不引入未经登记的"已核实"位——
 *  逐条核实进度在《研发素材 04》§3.1，那里才是事实源。 */
export type LiteratureState = 'attached' | 'placeholder';

export interface LedgerRow {
  ev_id: string;
  session_id: string;
  ts: number;
  modality: ModalityKey;
  type: string;
  severity: Severity;
  confidence: number;
  /** 观察层证据句：含物理量与单位，导出时逐字保留 */
  observations: Array<{ modality: ModalityKey; text: string; ts_from: number; ts_to: number }>;
  /** 本条实际命中的规则（已按 Admin 停用过滤，与下发给分析壳的候选层同源） */
  hit_rules: string[];
  literature: Array<{
    rule_id: string;
    ref: string;
    state: LiteratureState;
    weight: number;
    threshold: number;
    enabled: boolean;
    source: Rule['source'];
    owner: string;
    /** false = 该规则只出现在演示脚本的候选层，未登记进 Admin 规则库（素材 04 §2 已记此缺口） */
    in_library: boolean;
  }>;
  counterfactual: string;
  /** 结论层常驻免责声明（R2：模型推断，非临床心理诊断） */
  disclaimer: string;
  annotation: {
    id: string;
    status: AnnotationStatus;
    human_label: string | null;
    reviewer: string | null;
    note: string;
  } | null;
  /** 该条检测事件在审计链上的落点；为 null 说明报了异常却没留痕，属于 R6 缺陷 */
  audit: { action: string; seq: number } | null;
}

export interface Ledger {
  generated_at: string;
  clock: number;
  session_id: string;
  form: DeploymentForm;
  /** 评审必须先看这一行，才知道表里的数字是什么 */
  provenance_note: string;
  rows: LedgerRow[];
  rules: Rule[];
  summary: {
    events: number;
    /** 被模态门控 / 规则停用抑制掉、因此压根没有上报的条数（来自 anomaly.suppressed 审计） */
    suppressed: number;
    annotations: Record<AnnotationStatus, number>;
    rules: { total: number; enabled: number; attached: number; placeholder: number };
    audit: { total: number; head_seq: number; tail_seq: number; chain_ok: boolean };
    exports: number;
  };
}
