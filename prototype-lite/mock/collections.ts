/* 原型静态种子数据：让每个终端打开时就有真实可操作的业务对象，而不是空列表。
 * 与《技术架构与详细设计文档》§5.1 表结构同名，接真实后端时整文件可删除。 */
import type {
  AdminFlags,
  AnnotationItem,
  Integration,
  Member,
  Report,
  Rule,
  SessionSummary,
} from '../src/shared/types';

export const LIVE_SESSION = 'SES-2026-1019-A07';

export const SEED_SESSIONS: SessionSummary[] = [
  {
    id: LIVE_SESSION, subject_code: '对象 M-118', scene: '经侦询问 · 谈话室 03', form: 'B',
    collector: '专职采集员 C-04', analyst: '分析师 W-02', status: 'live',
    started_at: '2026-10-19 14:26', duration_seconds: 0, peak_lamp: 'orange',
    anomaly_count: 0, marker_count: 0, consent_doc: 'SQ-2026-118',
    modality_set: ['voice', 'semantic', 'face', 'pose', 'hand', 'physio'],
    source: 'live',
  },
  {
    // 已有录像复盘：办案常态。导入态在界面与报告中必须标「离线导入 · 非实时」
    id: 'SES-2026-1017-V31', subject_code: '对象 M-088', scene: '既往谈话录像复盘 · 离线导入', form: 'A',
    collector: '分析师 W-01', analyst: '分析师 W-01', status: 'closed',
    started_at: '2026-10-17 10:02', duration_seconds: 1540, peak_lamp: 'orange',
    anomaly_count: 7, marker_count: 1, consent_doc: 'SQ-2026-088（含录像二次使用授权）',
    modality_set: ['voice', 'semantic', 'face', 'pose'],
    source: 'imported',
    asset: { name: 'CAM03_20261016_1430.mp4', size_bytes: 1873000000, duration_seconds: 1540, kind: 'video' },
    // 归档件里的历史登记：扩展信号当时只有录像旁的毫米波导出表，未做归因，只留趋势
    assets: [
      { id: 'AS-01', name: 'CAM03_20261016_1430.mp4', size_bytes: 1873000000, duration_seconds: 1540, kind: 'video' },
      { id: 'AS-02', name: 'mmwave_radar_1430.csv', size_bytes: 4120000, duration_seconds: 1540, kind: 'mmwave' },
    ],
  },
  {
    id: 'SES-2026-1018-A03', subject_code: '对象 M-104', scene: '信访约谈 · 谈室 01', form: 'A',
    collector: '谈话人本人', analyst: '分析师 W-01', status: 'review',
    started_at: '2026-10-18 09:12', duration_seconds: 2418, peak_lamp: 'red',
    anomaly_count: 11, marker_count: 6, consent_doc: 'SQ-2026-104',
    modality_set: ['voice', 'semantic', 'face', 'pose'],
    source: 'live',
  },
  {
    id: 'SES-2026-1017-D22', subject_code: '对象 R-077', scene: '社区走访 · 外勤单兵', form: 'D',
    collector: '外勤员 D-11', analyst: '值守席 V-01', status: 'review',
    started_at: '2026-10-17 16:40', duration_seconds: 1122, peak_lamp: 'orange',
    anomaly_count: 4, marker_count: 3, consent_doc: '口头告知 · 录音留证',
    modality_set: ['voice', 'semantic'],
    source: 'live',
  },
  {
    id: 'SES-2026-1016-C08', subject_code: '对象 M-091', scene: '银行面审 · 异址多路', form: 'C',
    collector: '专职采集员 C-07', analyst: '分析师 W-03', status: 'closed',
    started_at: '2026-10-16 10:05', duration_seconds: 3305, peak_lamp: 'red',
    anomaly_count: 17, marker_count: 9, consent_doc: 'SQ-2026-091',
    modality_set: ['voice', 'semantic', 'face', 'pose', 'hand'],
    source: 'live',
  },
  {
    id: 'SES-2026-1015-A01', subject_code: '对象 H-032', scene: '医院随访 · 心理科', form: 'A',
    collector: '谈话人本人', analyst: '分析师 W-01', status: 'closed',
    started_at: '2026-10-15 15:20', duration_seconds: 1866, peak_lamp: 'orange',
    anomaly_count: 6, marker_count: 2, consent_doc: 'SQ-2026-032',
    modality_set: ['voice', 'semantic', 'face', 'physio'],
    source: 'live',
  },
];

export const SEED_REPORTS: Report[] = [
  {
    id: 'RP-1018-03', session_id: 'SES-2026-1018-A03', subject_code: '对象 M-104',
    title: '行为异常与心理变化分析报告（信访约谈）', status: 'pending_review', reviewer: '复核人 R-01',
    sections: [
      { key: 'overview', title: '一、谈话概况', text: '全程 40min，有效问答 61 轮，语音清晰率 96.4%；情绪强度峰值出现在第 21 分钟涉及"补偿款去向"的话题段。' },
      { key: 'anomaly', title: '二、异常行为事件', text: '共 11 条，其中 ALERT 3 条、ESCALATED 1 条（EV-011）：语义回避 + 手部动作频率翻倍 + 唤醒度上行同窗口聚合。' },
      { key: 'attribution', title: '三、可解释归因', text: '每条事件均给出观察层→候选规则层→结论层三级链条；EV-011 命中 R-PSY-07（举证期矛盾陈述），文献支撑为该规则内 12 项研究中的 2 项。' },
      { key: 'impact', title: '四、话题影响值', text: 'impact = w1 情绪冲击 + w2 认知冲突 + w3 利益相关 + w4 持续影响；最高 0.78 落在"补偿款去向"。' },
      { key: 'limit', title: '五、局限与免责', text: '本报告输出行为风险提示，不构成临床心理诊断；置信度为模型输出，最终判断权归使用方。' },
    ],
    precision_note: null,
    revisions: [
      { ts: '2026-10-18 10:02', actor: '分析师 W-01', action: 'create', note: '会话结束后自动起草' },
      { ts: '2026-10-18 10:41', actor: '分析师 W-01', action: 'edit', note: 'EV-006 反事实描述补充' },
      { ts: '2026-10-18 11:05', actor: '分析师 W-01', action: 'submit', note: '提交复核' },
    ],
    published_at: null,
  },
  {
    id: 'RP-1017-22', session_id: 'SES-2026-1017-D22', subject_code: '对象 R-077',
    title: '外勤走访行为风险提示（语音 + 语义）', status: 'drafting', reviewer: null,
    sections: [
      { key: 'overview', title: '一、走访概况', text: '外勤单兵形态，18min，仅上传音频切片与转写文本。' },
      { key: 'anomaly', title: '二、异常行为事件', text: '4 条（WARN 3 / ALERT 1），视觉模态未启用，姿态与表情相关规则未参与计算。' },
      { key: 'limit', title: '三、局限与免责', text: '本报告精度受限，不建议单独作为决策依据。' },
    ],
    precision_note: '本次仅语音 + 语义采集，视觉模态未启用，融合权重已按可用模态动态归一',
    revisions: [{ ts: '2026-10-17 17:10', actor: '值守席 V-01', action: 'create' }],
    published_at: null,
  },
  {
    id: 'RP-1016-08', session_id: 'SES-2026-1016-C08', subject_code: '对象 M-091',
    title: '集中研判报告（异址多路）', status: 'rejected', reviewer: '复核人 R-01',
    sections: [
      { key: 'overview', title: '一、谈话概况', text: '55min，两路采集（谈话室 + 隔壁席位复核）。' },
      { key: 'anomaly', title: '二、异常行为事件', text: '17 条，其中 2 条由值守视图升级。' },
      { key: 'attribution', title: '三、可解释归因', text: 'EV-014 反事实缺失，已被复核打回。' },
    ],
    precision_note: null,
    revisions: [
      { ts: '2026-10-16 11:20', actor: '分析师 W-03', action: 'create' },
      { ts: '2026-10-16 12:02', actor: '分析师 W-03', action: 'submit' },
      { ts: '2026-10-16 13:44', actor: '复核人 R-01', action: 'reject', note: 'EV-014 缺反事实说明；第 4 节影响值未标注维度权重' },
    ],
    published_at: null,
  },
  {
    id: 'RP-1015-01', session_id: 'SES-2026-1015-A01', subject_code: '对象 H-032',
    title: '随访心理变化趋势提示', status: 'published', reviewer: '复核人 R-02',
    sections: [
      { key: 'overview', title: '一、随访概况', text: '31min，rPPG 心率变异性通道正常。' },
      { key: 'anomaly', title: '二、异常行为事件', text: '6 条，全部为 WARN。' },
      { key: 'limit', title: '三、局限与免责', text: '本报告不构成临床心理诊断。' },
    ],
    precision_note: null,
    revisions: [
      { ts: '2026-10-15 16:10', actor: '分析师 W-01', action: 'create' },
      { ts: '2026-10-15 16:55', actor: '分析师 W-01', action: 'submit' },
      { ts: '2026-10-15 17:30', actor: '复核人 R-02', action: 'approve' },
      { ts: '2026-10-15 17:32', actor: '复核人 R-02', action: 'publish' },
    ],
    published_at: '2026-10-15 17:32',
  },
];

export const SEED_RULES: Rule[] = [
  { id: 'R-PSY-03', pattern: '语速突增 >30%（20s 窗）且停顿率下降', psych_state: '紧张性唤醒上行', literature_ref: 'Scherer 2009, Emotion review section 4.2', weight: 0.42, threshold: 0.28, enabled: true, owner: '分析师 W-01', updated_at: '2026-10-12', hits: 37, source: '内置' },
  { id: 'R-PSY-07', pattern: '指代前后不一致 + AU4+AU7 同窗出现', psych_state: '矛盾陈述下的抑制尝试', literature_ref: 'Vrij et al. 2017, Verbal cues meta-analysis', weight: 0.55, threshold: 0.34, enabled: true, owner: '分析师 W-02', updated_at: '2026-10-14', hits: 21, source: '内置' },
  { id: 'R-PSY-11', pattern: '手部自触及频率 ≥4 次/20s 且 F0 jitter ↑', psych_state: '自我安抚行为', literature_ref: 'Bugaev 2018 附录 B；Ekman & Friesen 1969', weight: 0.31, threshold: 0.25, enabled: true, owner: '分析师 W-03', updated_at: '2026-10-09', hits: 15, source: '内置' },
  { id: 'R-PSY-14', pattern: '语义回避：答非所问 + 话题外延 >2 句', psych_state: '信息保护性回避', literature_ref: 'Holkamp 2022, 回避类陈述研究', weight: 0.48, threshold: 0.30, enabled: true, owner: '分析师 W-01', updated_at: '2026-10-16', hits: 9, source: '标注回流' },
  { id: 'R-PSY-19', pattern: 'rPPG HRV 低频占比上行 + 唤醒度持续 60s', psych_state: '生理应激未回落', literature_ref: 'Laboratory for Affective Signal Processing 手册 §7', weight: 0.58, threshold: 0.44, enabled: true, owner: 'Admin', updated_at: '2026-10-19', hits: 11, source: '内置' },
  { id: 'R-PSY-22', pattern: '长句后异常沉默 >3.5s 且躯干后仰', psych_state: '认知负荷超载', literature_ref: '待补挂文献（原型占位，正式交付替换为规则库真实条目）', weight: 0.29, threshold: 0.26, enabled: false, owner: '分析师 W-02', updated_at: '2026-10-18', hits: 6, source: '标注回流' },
];

export const SEED_ANNOTATIONS: AnnotationItem[] = [
  { id: 'AN-001', session_id: 'SES-2026-1018-A03', ev_id: 'EV-004', ts: 412, modality: 'voice', model_label: '紧张性唤醒上行', model_confidence: 0.81, rule_id: 'R-PSY-03', human_label: null, reviewer: null, status: 'pending', note: '' },
  { id: 'AN-002', session_id: 'SES-2026-1018-A03', ev_id: 'EV-009', ts: 1104, modality: 'semantic', model_label: '信息保护性回避', model_confidence: 0.63, rule_id: 'R-PSY-14', human_label: null, reviewer: null, status: 'pending', note: '' },
  { id: 'AN-003', session_id: 'SES-2026-1018-A03', ev_id: 'EV-011', ts: 1268, modality: 'pose', model_label: '矛盾陈述下的抑制尝试', model_confidence: 0.74, rule_id: 'R-PSY-07', human_label: null, reviewer: null, status: 'pending', note: '' },
  { id: 'AN-004', session_id: 'SES-2026-1016-C08', ev_id: 'EV-021', ts: 890, modality: 'hand', model_label: '自我安抚行为', model_confidence: 0.52, rule_id: 'R-PSY-11', human_label: '自我安抚行为', reviewer: '分析师 W-03', status: 'confirmed', note: '与手部关键点轨迹一致' },
  { id: 'AN-005', session_id: 'SES-2026-1016-C08', ev_id: 'EV-026', ts: 1540, modality: 'physio', model_label: '生理应激未回落', model_confidence: 0.44, rule_id: 'R-PSY-19', human_label: '误报', reviewer: '分析师 W-03', status: 'false_positive', note: '对象侧身导致 rPPG 人脸 mask 失效，PPG 峰值被误读为心率上行' },
];

export const SEED_MEMBERS: Member[] = [
  { id: 'W-01', name: '分析师 W-01', role: 'analyst', seat: '研判席 1', online: true, forms: ['A', 'B', 'C'] },
  { id: 'W-02', name: '分析师 W-02', role: 'analyst', seat: '研判席 2', online: true, forms: ['A', 'B', 'C', 'D'] },
  { id: 'W-03', name: '分析师 W-03', role: 'analyst', seat: '研判席 3', online: false, forms: ['C'] },
  { id: 'R-01', name: '复核人 R-01', role: 'reviewer', seat: '复核席', online: true, forms: ['A', 'B', 'C', 'D'] },
  { id: 'C-04', name: '采集员 C-04', role: 'collector', seat: '谈话室 03', online: true, forms: ['B', 'C'] },
  { id: 'D-11', name: '外勤员 D-11', role: 'collector', seat: '外勤（手机）', online: false, forms: ['D'] },
  { id: 'A-01', name: 'Admin', role: 'admin', seat: '管理后台', online: true, forms: ['A', 'B', 'C', 'D'] },
];

export const SEED_INTEGRATIONS: Integration[] = [
  { id: 'IN-ASR', name: 'Whisper / FunASR 流式转写', kind: 'ASR', endpoint: 'http://asr.internal:9000/v1/stream', status: 'ok', latency_ms: 210, note: '中英混说；说话人分离由 pyannote 提供' },
  { id: 'IN-DIA', name: 'pyannote 说话人分离', kind: 'Diarization', endpoint: 'http://diar.internal:9001/v1/rttm', status: 'ok', latency_ms: 90, note: '两说话人场景下 EER 6.8%' },
  { id: 'IN-PRO', name: 'openSMILE eGeMAPS 声学特征', kind: 'Prosody', endpoint: 'http://prosody.internal:9002/v1/feature', status: 'ok', latency_ms: 160, note: 'F0 / jitter / shimmer / HNR' },
  { id: 'IN-FAC', name: 'AU / FACS 表情单元', kind: 'Vision', endpoint: 'http://vision.internal:9003/v1/au', status: 'degraded', latency_ms: 480, note: '遮挡场景强度偏低，安全注意力 mask 生效' },
  { id: 'IN-POS', name: 'ViTPose 躯干与头部姿态', kind: 'Vision', endpoint: 'http://vision.internal:9004/v1/pose', status: 'ok', latency_ms: 320, note: '躯干俯仰角与头部偏航回避持续时间' },
  { id: 'IN-HND', name: 'MediaPipe Hands 手部自触及', kind: 'Vision', endpoint: 'http://vision.internal:9008/v1/hand', status: 'ok', latency_ms: 260, note: '搓手/摸颈等适应性动作计数与压力峰值' },
  { id: 'IN-RPP', name: 'rPPG 生理信号', kind: 'Physio', endpoint: 'http://rppg.internal:9005/v1/hrv', status: 'ok', latency_ms: 400, note: '需要稳定面部区域，光照敏感' },
  { id: 'IN-SEM', name: 'Sentence-BERT 语义嵌入', kind: 'Semantic', endpoint: 'http://nlu.internal:9006/v1/embed', status: 'ok', latency_ms: 120, note: '话题边界切分与矛盾检测' },
  { id: 'IN-LLM', name: '归因解释生成', kind: 'LLM', endpoint: 'http://llm.internal:9007/v1/explain', status: 'off', latency_ms: 0, note: '仅在分析壳出网，现场壳通道不可调用' },
];

export const DEFAULT_FLAGS: AdminFlags = {
  form_d_enabled: true,
  field_view_enabled: true,
  modality_whitelist_d: ['voice', 'semantic'],
  retention_days: 30,
  auto_escalate_seconds: 20,
  annotation_reflow: true,
};
