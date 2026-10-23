/* 演示脚本：一段 150 秒的供应商面审回放，逐条覆盖招标 28.07 列举的六类异常
 * （言语表达 / 语音特征 / 身体姿态 / 手部动作 / 面部表情 / 生理指标）。
 * 说明：文献标注为演示占位，正式交付时替换为规则库（PsyRule）中的真实条目。 */
import type { AssetKind, Attribution, DeploymentForm, ModalityKey } from '../src/shared/types';

export const SCRIPT_LENGTH = 152;

export interface Turn {
  ts: number;
  speaker: 'interviewer' | 'subject';
  text: string;
  rate?: number;
  /** 说话人分离置信度（pyannote 口径）：脚本预置真值，界面按通道健康度折算后展示 */
  diar_conf?: number;
}

export const TURNS: Turn[] = [
  { ts: 0, speaker: 'interviewer', diar_conf: 0.98, text: '请把 10 月 12 日那笔付款的审批流程从头讲一遍。' },
  { ts: 6, speaker: 'subject', diar_conf: 0.95, text: '那笔是三十七万，业务端提的单，我这边核了一下金额就报上去了。' },
  { ts: 16, speaker: 'interviewer', diar_conf: 0.97, text: '签字的人是谁？' },
  { ts: 18, speaker: 'subject', diar_conf: 0.93, text: '是我……经办人代签的，他当时在场。', rate: 7.9 },
  { ts: 28, speaker: 'interviewer', diar_conf: 0.96, text: '你上周的书面说明里写的是"本人签署"。' },
  { ts: 36, speaker: 'subject', diar_conf: 0.71, text: '那个措辞可能不太准确，意思是一样的，都是走流程。', rate: 8.6 },
  { ts: 48, speaker: 'interviewer', diar_conf: 0.97, text: '代签有没有授权？' },
  { ts: 52, speaker: 'subject', diar_conf: 0.94, text: '有口头授权，我们组里一直这么办。' },
  { ts: 62, speaker: 'interviewer', diar_conf: 0.9, text: '一直这么办是从什么时候开始？' },
  { ts: 66, speaker: 'subject', diar_conf: 0.88, text: '今年三月之后比较常见，之前还是规规矩矩签的。' },
  { ts: 78, speaker: 'interviewer', diar_conf: 0.97, text: '这三笔加起来一共九十二万，全部是代签。' },
  { ts: 86, speaker: 'subject', diar_conf: 0.66, text: '金额我不清楚，我只负责前面那一段。' },
  { ts: 96, speaker: 'interviewer', diar_conf: 0.95, text: '那后面那一段是谁负责？' },
  { ts: 100, speaker: 'subject', diar_conf: 0.89, text: '这个要问财务，我确实不知道。' },
  { ts: 110, speaker: 'interviewer', diar_conf: 0.98, text: '我再问一次：10 月 12 日当天，你人在哪里？' },
  { ts: 116, speaker: 'subject', diar_conf: 0.92, text: '我在办公室，那天下午一直在开会。' },
  { ts: 126, speaker: 'interviewer', diar_conf: 0.96, text: '会议记录里没有你，签到表也没有。' },
  { ts: 132, speaker: 'subject', diar_conf: 0.69, text: '那可能是漏签了，我可以找参会的人证明。' },
  { ts: 144, speaker: 'interviewer', diar_conf: 0.97, text: '今天先谈到这里，你回去把三份说明补一份书面材料。' },
];

/** 逐 2 秒采样的情绪/张力曲线基线，异常点在其上叠加脉冲 */
export function baseCurve(t: number): { emotion: number; tension: number; arousal: number } {
  const wobble = Math.sin(t / 7) * 4 + Math.sin(t / 3.1) * 2;
  const climb = Math.min(26, t / 152 * 26);
  return {
    emotion: clamp(30 + wobble + climb * 0.6, 5, 96),
    tension: clamp(22 + wobble * 0.8 + climb, 5, 96),
    arousal: clamp(34 + Math.sin(t / 4.4) * 6 + climb * 0.8, 5, 96),
  };
}

export interface AnomalySpec {
  ts: number;
  modality: ModalityKey;
  type: string;
  severity: 'WARN' | 'ALERT' | 'ESCALATED';
  confidence: number;
  lamp: 'orange' | 'red';
  advice: string;
  attribution: Attribution;
}

const DISCLAIMER = '模型推断，非临床心理诊断';

export const ANOMALIES: AnomalySpec[] = [
  {
    ts: 18,
    modality: 'voice',
    type: '音调升高 + jitter 异常',
    severity: 'WARN',
    confidence: 0.58,
    lamp: 'orange',
    advice: '放慢语速复述问题',
    attribution: {
      observation: [
        { modality: 'voice', text: 'F0 均值由 132Hz 升至 178Hz；jitter 0.41%→1.12%；HNR 下降 5.2dB', ts_from: 17.2, ts_to: 20.6 },
        { modality: 'semantic', text: '回答长度较前一问缩短 42%，出现代词泛指"他"', ts_from: 18.0, ts_to: 21.4 },
      ],
      candidate_rules: [
        { rule_id: 'R-VOC-03', pattern: 'voice.F0_delta>30% AND jitter>1.0%', psych_state: '应激性紧张', literature_ref: '语音应激特征与声带肌张力（演示占位）', weight: 0.62, hit: true },
        { rule_id: 'R-VOC-07', pattern: 'voice.HNR_drop>4dB AND rate_delta>15%', psych_state: '言语抑制', literature_ref: '语速与潜伏期作为负荷指标（演示占位）', weight: 0.44, hit: false },
      ],
      conclusion: {
        psych_state: '应激性紧张（中度）',
        confidence: 0.58,
        counterfactual: '若该时段环境噪声 >55dB 或对象刚结束饮水，本结论不成立',
        disclaimer: DISCLAIMER,
      },
    },
  },
  {
    ts: 36,
    modality: 'semantic',
    type: '信息前后矛盾（NLI 不一致）',
    severity: 'ALERT',
    confidence: 0.74,
    lamp: 'orange',
    advice: '追问 10·12 记录归属',
    attribution: {
      observation: [
        { modality: 'semantic', text: '本轮"经办人代签"与书面说明"本人签署"构成矛盾关系（NLI 0.81）', ts_from: 36.0, ts_to: 41.2 },
        { modality: 'voice', text: '同窗口出现填充词"可能/意思是一样的"共 3 次', ts_from: 36.0, ts_to: 41.2 },
      ],
      candidate_rules: [
        { rule_id: 'R-SEM-01', pattern: 'nli.relation=contradiction AND anchor=prior_statement', psych_state: '陈述一致性风险', literature_ref: '陈述一致性核验（演示占位）', weight: 0.81, hit: true },
        { rule_id: 'R-SEM-05', pattern: 'hedge_rate>2/100words AND answer_len_delta<-30%', psych_state: '回避性表述', literature_ref: '模糊限制语与承诺度（演示占位）', weight: 0.57, hit: true },
      ],
      conclusion: {
        psych_state: '陈述一致性风险（需人工核验）',
        confidence: 0.74,
        counterfactual: '若书面说明系他人代笔或存在措辞转写误差，本结论应降级为 INFO',
        disclaimer: DISCLAIMER,
      },
    },
  },
  {
    ts: 58,
    modality: 'face',
    type: '微表情 AU4+AU7（<500ms）',
    severity: 'WARN',
    confidence: 0.51,
    lamp: 'orange',
    advice: '切换中性话题后回看',
    attribution: {
      observation: [
        { modality: 'face', text: 'AU4（皱眉肌）+AU7（眼睑收紧）持续 380ms，出现在"口头授权"表述后 0.6s', ts_from: 57.4, ts_to: 57.8 },
      ],
      candidate_rules: [
        { rule_id: 'R-FAC-02', pattern: 'au.4+au.7 duration<500ms', psych_state: '负性情绪闪现', literature_ref: 'FACS AU4+AU7 动作单元释义（演示占位）', weight: 0.55, hit: true },
      ],
      conclusion: {
        psych_state: '负性情绪闪现（低置信）',
        confidence: 0.51,
        counterfactual: '单帧遮挡或侧脸角度 >35° 时该 AU 组合不可判定',
        disclaimer: DISCLAIMER,
      },
    },
  },
  {
    ts: 74,
    modality: 'physio',
    type: '生理指标异常（rPPG-HRV 应激未回落）',
    severity: 'WARN',
    confidence: 0.56,
    lamp: 'orange',
    advice: '放缓节奏，给片刻停顿',
    attribution: {
      observation: [
        { modality: 'physio', text: 'rPPG LF/HF 由 1.24 升至 2.11，HR 78→94 bpm，唤醒状态自 57.6s 起持续 62s 未回落', ts_from: 57.6, ts_to: 73.8 },
        { modality: 'voice', text: '同窗语速 4.2→7.9 字/秒，句间停顿缩短 38%，与生理上行起点相差 5.6s', ts_from: 52.0, ts_to: 66.0 },
      ],
      candidate_rules: [
        { rule_id: 'R-PSY-19', pattern: 'rPPG HRV 低频占比上行 + 唤醒度持续 60s', psych_state: '生理应激未回落', literature_ref: 'Laboratory for Affective Signal Processing 手册 §7', weight: 0.58, hit: true },
        { rule_id: 'R-PSY-03', pattern: '语速突增 >30%（20s 窗）且停顿率下降', psych_state: '紧张性唤醒上行', literature_ref: 'Scherer 2009, Emotion review section 4.2', weight: 0.42, hit: true },
      ],
      conclusion: {
        psych_state: '生理应激未回落（中度，需与言语通道互证）',
        confidence: 0.56,
        counterfactual: 'rPPG 对头部位移与环境光敏感：若该窗口人脸 mask 占比 >35% 或对象曾起身移动，生理读数不可用，本结论应作废而非降级',
        disclaimer: DISCLAIMER,
      },
    },
  },
  {
    ts: 86,
    modality: 'pose',
    type: '躯干后仰 + 头部回避',
    severity: 'WARN',
    confidence: 0.49,
    lamp: 'orange',
    advice: '拆分问题逐个确认',
    attribution: {
      observation: [
        { modality: 'pose', text: '躯干俯仰角 -11°→-23°，头部偏航持续 2.4s 避开镜头中线', ts_from: 85.2, ts_to: 88.6 },
        { modality: 'semantic', text: '回答将责任外移（"金额我不清楚""要问财务"）', ts_from: 86.0, ts_to: 92.0 },
      ],
      candidate_rules: [
        { rule_id: 'R-POS-04', pattern: 'torso_lean_back>10deg AND head_avoid>2s', psych_state: '心理距离拉开', literature_ref: '身体取向与回避姿态（演示占位）', weight: 0.48, hit: true },
      ],
      conclusion: {
        psych_state: '心理距离拉开（低置信，建议结合语义）',
        confidence: 0.49,
        counterfactual: '座椅调整或拾取到镜头不适均会产生同样姿态，不能单独作为依据',
        disclaimer: DISCLAIMER,
      },
    },
  },
  {
    ts: 110,
    modality: 'hand',
    type: '反复搓手（适应性动作）',
    severity: 'WARN',
    confidence: 0.53,
    lamp: 'orange',
    advice: '给予思考时间勿打断',
    attribution: {
      observation: [
        { modality: 'hand', text: '双手互搓 6 次 / 18s，指尖接触压力峰值递增', ts_from: 108.0, ts_to: 126.0 },
      ],
      candidate_rules: [
        { rule_id: 'R-HND-01', pattern: 'self_adaptor_freq>4/20s', psych_state: '紧张性自我安抚', literature_ref: '适应性动作与紧张调节（演示占位）', weight: 0.5, hit: true },
      ],
      conclusion: {
        psych_state: '紧张性自我安抚（中度）',
        confidence: 0.53,
        counterfactual: '室温偏低或手部不适同样会引发搓手，需结合环境记录',
        disclaimer: DISCLAIMER,
      },
    },
  },
  {
    ts: 132,
    modality: 'semantic',
    type: '跨模态同窗聚合升级',
    severity: 'ESCALATED',
    confidence: 0.83,
    lamp: 'red',
    advice: '呼叫后方·建议暂停核实',
    attribution: {
      observation: [
        { modality: 'semantic', text: '"在开会"与签到记录冲突，属可查证事实型矛盾', ts_from: 132.0, ts_to: 138.0 },
        { modality: 'voice', text: '同窗 jitter 再次抬升 0.9pp', ts_from: 131.4, ts_to: 135.2 },
        { modality: 'hand', text: '搓手频率 18s 内 6 次未回落', ts_from: 130.0, ts_to: 140.0 },
        { modality: 'physio', text: 'rPPG HR 稳定在 96 bpm，自 57.6s 起的唤醒状态已持续 76s 未回落', ts_from: 130.0, ts_to: 138.0 },
      ],
      candidate_rules: [
        { rule_id: 'R-FUS-02', pattern: 'count(modality where hit)>=3 within 10s AND severity>=WARN', psych_state: '综合异常升级', literature_ref: '多模态同窗聚合判定（演示占位）', weight: 0.86, hit: true },
      ],
      conclusion: {
        psych_state: '综合异常（高）——建议人工介入核实',
        confidence: 0.83,
        counterfactual: '若四个模态的命中窗口实际错开 >10s，则不满足聚合条件，应回落为单条 WARN',
        disclaimer: DISCLAIMER,
      },
    },
  },
];

export const TOPICS: Array<{
  ts: number;
  end: number;
  id: string;
  label: string;
  score: number;
  dims: { 情绪冲击: number; 认知冲突: number; 利益相关: number; 持续影响: number };
  rationale: string;
  /** 语义边界切分依据：说明这个话题不是人工划的，而是嵌入距离突变 + 实体切换检测出来的 */
  boundary_evidence: string;
}> = [
  {
    ts: 0, end: 34, id: 'T1', label: '付款审批流程与签字归属', score: 0.62,
    dims: { 情绪冲击: 0.55, 认知冲突: 0.72, 利益相关: 0.68, 持续影响: 0.5 },
    rationale: '对象在"谁签字"上出现两次表述漂移，且该问题直接决定责任归属，故认知冲突与利益相关两项权重最高。',
    boundary_evidence: '边界由 Sentence-BERT 相邻句嵌入余弦距离在 34s 处出现 0.41 跳变判定；实体集由 {付款, 审批, 金额} 切换为 {授权, 惯例}。',
  },
  {
    ts: 34, end: 76, id: 'T2', label: '代签授权来源与惯例', score: 0.71,
    dims: { 情绪冲击: 0.6, 认知冲突: 0.78, 利益相关: 0.82, 持续影响: 0.55 },
    rationale: '"口头授权""一直这么办"把个案扩大为惯例，涉及面超出单笔交易；对象在同窗内出现回避性表述与微表情闪现。',
    boundary_evidence: '76s 处提问句法转为"合计 + 责任归属"，嵌入距离跳变 0.37；话题内命中 2 条规则（R-SEM-05 / R-FAC-02），持续性标记为"惯例化陈述"。',
  },
  {
    ts: 76, end: 108, id: 'T3', label: '三笔合计九十二万的责任划分', score: 0.78,
    dims: { 情绪冲击: 0.66, 认知冲突: 0.8, 利益相关: 0.9, 持续影响: 0.62 },
    rationale: '金额显著上升且对象连续两次将责任外移至"财务"，姿态与语义在同一窗口出现回避信号，利益相关维度接近上限。',
    boundary_evidence: '108s 处话题词由 {财务, 责任} 突变为 {在场, 行踪}，边界置信度 0.79；窗口内两次"不清楚/不知道"触发责任外移计数。',
  },
  {
    ts: 108, end: 152, id: 'T4', label: '10 月 12 日行踪可查证性', score: 0.91,
    dims: { 情绪冲击: 0.84, 认知冲突: 0.95, 利益相关: 0.88, 持续影响: 0.9 },
    rationale: '该话题存在客观佐证（会议记录、签到表），矛盾可被直接证实或推翻；四模态同窗命中触发升级，持续影响因牵涉后续书面材料而最高。',
    boundary_evidence: '110s 处出现时间锚点复述（"我再问一次"），系统据此把该段判为可查证型话题；四模态同窗命中使影响值上限被触发。',
  },
];

export const MODALITY_LABEL: Record<ModalityKey, string> = {
  voice: '语音',
  semantic: '语义',
  face: '表情',
  pose: '姿态',
  hand: '手部',
  physio: '生理',
};

/** 扩展信号源（招标 28.01 列举的近红外 / 毫米波）的登记口径。
 *  当前版本按采样序列文件导入，只到生理趋势层：不进 ESCALATED、不出心理归因。 */
export type ExtKind = 'nir' | 'mmwave';

export const EXT_SIGNALS: Record<
  ExtKind,
  {
    sensor_label: string;
    /** 上传框接受的文件类型：扩展信号是采样序列导出件，不是音视频容器 */
    accept: string;
    /** 解析链逐段说明，与批分析进度一一对应 */
    steps: string[];
    /** 该路信号为什么只到趋势层——逐条独立陈述，一个失效原因占一条 */
    limits: string[];
    metrics: Array<{ name: string; unit: string; base: number; span: number; decimals: number }>;
  }
> = {
  nir: {
    sensor_label: '近红外（fNIRS 口径）',
    accept: '.csv,.tsv,.txt,.json',
    steps: [
      '读取采样序列文件：非音视频容器，不做解封装、不产生画面帧',
      '通道配对与光程归一：按源-探距离折算 HbO / HbR 相对浓度变化',
      '运动伪迹剔除：头动占比超阈的窗口置空（填 0 会把伪迹读成 activations）',
      '基线校正与切片：以静息段为基线，按 10s 窗切分趋势，仅出生理趋势层',
    ],
    limits: [
      '近红外测的是局部血流动力学，不是心理量：从 HbO 上行到"紧张"之间还隔着负荷任务标定这一环，本系统未做个体标定，故不出归因',
      '单通道 fNIRS 无空间分辨力可言：无法区分前额叶激活与面部肌电串扰，本版本按整体趋势呈现',
      '光强与耦合状态无参考通道：素材内不含探头贴合度记录，读数只能做会话内相对比较',
    ],
    metrics: [
      { name: 'HbO 相对浓度变化', unit: 'mmol·mm/L', base: 0.08, span: 0.19, decimals: 3 },
      { name: 'HbR 相对浓度变化', unit: 'mmol·mm/L', base: -0.05, span: -0.12, decimals: 3 },
      { name: '头动伪迹占比', unit: '%', base: 6, span: 17, decimals: 1 },
    ],
  },
  mmwave: {
    sensor_label: '毫米波雷达（呼吸 / 心跳带）',
    accept: '.csv,.tsv,.txt,.json',
    steps: [
      '读取点云 / 距离-相位序列：非音视频容器，不做解封装、不产生画面帧',
      '目标波束选定：按呼吸带幅度锁定主目标，多人同场时其余波束丢弃',
      '带通分离：0.1–0.5 Hz 取呼吸带、0.7–2.5 Hz 取心跳带，窗口 30s',
      '体动幅度切片：位移超阈的窗口心率读数标记为不可用，仅出生理趋势层',
    ],
    limits: [
      '心率是从胸腔微动反推的估计量：体动幅度 >8mm 的窗口里该读数被体动频谱覆盖，本版本对这些窗口置空而非插值',
      '无接触式电极参考：与心电口径不可直接对齐，跨设备比较不成立',
      '波束锁定是推断而非事实：谈室内存在第二人（谈话人）时，主目标可能跳变，需人工核对锁定序列',
    ],
    metrics: [
      { name: '呼吸频率', unit: 'rpm', base: 14.5, span: 8.5, decimals: 1 },
      { name: '心率估算', unit: 'bpm', base: 76, span: 22, decimals: 0 },
      { name: '体动幅度', unit: 'mm', base: 2.5, span: 11, decimals: 1 },
    ],
  },
};

/** 扩展信号的采样序列：与视频 rPPG 取同一条唤醒度基线，保证两路读数趋势一致。
 *  注意这是脚本设定（两路同源），不是真实设备的交叉验证——真机上两路误差不相关。
 *  基线取静息段（前 25% 采样窗）中位数而不是首点：首点可能正好落在一次体动上。 */
export function extSeries(kind: ExtKind, duration: number, samples = 24) {
  const span = duration > 0 ? duration : SCRIPT_LENGTH;
  const step = span / (samples - 1);
  return EXT_SIGNALS[kind].metrics.map((m) => {
    const series: number[] = [];
    for (let i = 0; i < samples; i++) {
      const t = +(i * step).toFixed(1);
      const c = baseCurve(t);
      const drive = m.name.includes('伪迹') || m.name.includes('体动') ? c.tension : c.arousal;
      const frac = clamp((drive - 22) / 40, 0, 1);
      series.push(+(m.base + m.span * frac).toFixed(m.decimals));
    }
    const peakIdx = series.reduce((best, v, i) => (Math.abs(v) > Math.abs(series[best]) ? i : best), 0);
    const rest = series.slice(0, Math.max(2, Math.floor(series.length * 0.25))).sort((a, b) => a - b);
    const baseline = rest[Math.floor(rest.length / 2)];
    return {
      name: m.name,
      unit: m.unit,
      decimals: m.decimals,
      baseline,
      peak: series[peakIdx],
      peak_ts: +(peakIdx * step).toFixed(1),
      end_value: series[series.length - 1],
      series,
    };
  });
}

/** 素材信号源类型的界面名称：主信号两路与扩展两路的措辞必须区分开，
 *  否则评审会把"上传了近红外文件"读成"接入了近红外硬件"。 */
export const ASSET_KIND_LABEL: Record<AssetKind, string> = {
  video: '视频（主信号）',
  audio: '音频（主信号）',
  nir: '近红外（扩展信号）',
  mmwave: '毫米波（扩展信号）',
};

export const FORM_LABEL: Record<DeploymentForm, string> = {
  A: '形态 A · 同址单人（边谈边看）',
  B: '形态 B · 同址双人（隔壁分析）',
  C: '形态 C · 异址多路（集中研判）',
  D: '形态 D · 外勤单兵（手机采集）',
};

export const MODALITY_WHITELIST_D: ModalityKey[] = ['voice', 'semantic'];

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
