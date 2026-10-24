#!/usr/bin/env python3
"""正式版解决方案 PPT 生成器（需求 7008111111）。

素材：docs/ppt-assets/*.png（CDP1234 实拍）+ stats.json（服务实测数字）。
用法：analysis-service/.venv/bin/python tools/make_ppt.py
"""
import json
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.util import Emu, Inches, Pt

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "docs" / "ppt-assets"
OUT = ROOT / "docs" / "解决方案汇报-7008111111.pptx"
STATS = json.loads((ASSETS / "stats.json").read_text("utf-8"))

BLUE = RGBColor(0x16, 0x64, 0xFF)
DARK = RGBColor(0x1F, 0x23, 0x29)
GRAY = RGBColor(0x6B, 0x72, 0x80)
LIGHT = RGBColor(0xF0, 0xF6, 0xFF)
RED = RGBColor(0xCF, 0x13, 0x22)
GREEN = RGBColor(0x38, 0x9E, 0x0D)

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]
SW, SH = prs.slide_width, prs.slide_height


def slide():
    return prs.slides.add_slide(BLANK)


def rect(s, x, y, w, h, fill=None, line=None):
    from pptx.enum.shapes import MSO_SHAPE
    sh = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
    sh.fill.solid() if fill else sh.fill.background()
    if fill:
        sh.fill.fore_color.rgb = fill
    if line:
        sh.line.color.rgb = line
        sh.line.width = Pt(0.75)
    else:
        sh.line.fill.background()
    sh.shadow.inherit = False
    return sh


def text(s, x, y, w, h, runs, size=14, color=DARK, bold=False, align=PP_ALIGN.LEFT,
         anchor=MSO_ANCHOR.TOP, leading=1.15):
    """runs: str 或 [(txt,{size,color,bold}),...] 或 [[段落runs],...]"""
    tb = s.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    paras = runs if isinstance(runs, list) and runs and isinstance(runs[0], list) else [runs]
    for i, para in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = leading
        items = para if isinstance(para, list) else [(para, {})]
        for txt, st in items:
            r = p.add_run()
            r.text = txt
            r.font.size = Pt(st.get("size", size))
            r.font.bold = st.get("bold", bold)
            r.font.color.rgb = st.get("color", color)
            r.font.name = "PingFang SC"
    return tb


def header(s, title, sub=None, idx=None):
    rect(s, 0, 0, SW, Inches(1.0), fill=BLUE)
    text(s, Inches(0.55), Inches(0.16), Inches(11), Inches(0.7),
         [[(title, {"size": 24, "bold": True, "color": RGBColor(255, 255, 255)})]],
         anchor=MSO_ANCHOR.MIDDLE)
    if sub:
        text(s, Inches(0.57), Inches(1.08), Inches(12.2), Inches(0.4),
             [[(sub, {"size": 12, "color": GRAY})]])
    if idx:
        text(s, SW - Inches(1.2), Inches(0.28), Inches(0.9), Inches(0.5),
             [[(idx, {"size": 13, "color": RGBColor(255, 255, 255)})]], align=PP_ALIGN.RIGHT)


def pic_fit(s, name, x, y, w, h, border=True):
    """等比放入指定框并居中。"""
    from PIL import Image
    p = ASSETS / name
    iw, ih = Image.open(p).size
    ratio = min(w / iw, h / ih)
    nw, nh = int(iw * ratio), int(ih * ratio)
    px = x + (w - nw) // 2
    py = y + (h - nh) // 2
    sh = s.shapes.add_picture(str(p), px, py, nw, nh)
    if border:
        sh.line.color.rgb = RGBColor(0xE3, 0xE7, 0xEE)
        sh.line.width = Pt(1)
    return sh


def bullets(s, x, y, w, h, items, size=14, gap=True):
    """items: [(标题, 说明)] 或 [str]"""
    paras = []
    for it in items:
        if isinstance(it, tuple):
            paras.append([("▎" + it[0] + "  ", {"size": size, "bold": True, "color": BLUE}),
                          (it[1], {"size": size - 1, "color": DARK})])
        else:
            paras.append([(it, {"size": size, "color": DARK})])
        if gap:
            paras.append([("", {"size": 6})])
    return text(s, x, y, w, h, paras, leading=1.12)


# ── 1 封面 ──────────────────────────────────────────────────────────
s = slide()
rect(s, 0, 0, SW, SH, fill=RGBColor(0x0B, 0x12, 0x20))
rect(s, 0, Inches(4.9), SW, Inches(0.06), fill=BLUE)
text(s, Inches(1), Inches(1.9), Inches(11.3), Inches(1.8),
     [[("基于对话内容的行为异常检测", {"size": 40, "bold": True, "color": RGBColor(255, 255, 255)})],
      [("和心理变化分析技术", {"size": 40, "bold": True, "color": RGBColor(255, 255, 255)})]], leading=1.1)
text(s, Inches(1), Inches(3.75), Inches(11), Inches(0.5),
     [[("—— 真实算法实现方案与产品实测 ——", {"size": 18, "color": RGBColor(0x9F, 0xC3, 0xFF)})]])
text(s, Inches(1), Inches(5.2), Inches(11), Inches(1.6),
     [[("需求编号：7008111111（中关村新域新质创新挑战赛 · 技术问题难题类）", {"size": 14, "color": RGBColor(0xCF, 0xD9, 0xEA)})],
      [("参赛单位：RedCreationTech　　　日期：2026 年 10 月", {"size": 14, "color": RGBColor(0xCF, 0xD9, 0xEA)})]])

# ── 2 需求解读 ───────────────────────────────────────────────────────
s = slide()
header(s, "需求解读与功能映射", "需求功能要求三条 + 主要指标三条 → 本方案逐条落地", "02")
rows = [("功能 1｜分角色识别 + 话题提取 + 语义影响值",
         "FunASR 中文 ASR（词级时间戳）+ CAM++ 说话人分离 → 真实分角色转写；BERTopic+bge-m3 切话题；影响值=时长占比×情感翻转×矛盾密度"),
        ("功能 2｜语音特征/言语表达异常 + 心理原因",
         "parselmouth（Praat 内核）提 F0/jitter/shimmer/HNR/语速/停顿 → 个体基线 z-score 突变检测 → 规则库归因（附文献与反事实）"),
        ("功能 3｜不限信号输入：表情/姿态/手部/生理指标异常 + 心理原因",
         "MediaPipe AU 代理 + RTMPose 躯干 + 手部自适应动作 + rPPG 心率趋势；毫米波/近红外文件级真实解析封顶趋势层；决策级多模态融合升级")]
y = Inches(1.7)
for t, d in rows:
    rect(s, Inches(0.55), y, Inches(12.2), Inches(1.5), fill=LIGHT)
    text(s, Inches(0.8), y + Inches(0.12), Inches(11.7), Inches(0.5),
         [[(t, {"size": 15, "bold": True, "color": DARK})]])
    text(s, Inches(0.8), y + Inches(0.62), Inches(11.7), Inches(0.85),
         [[(d, {"size": 12.5, "color": GRAY})]], leading=1.15)
    y += Inches(1.72)
text(s, Inches(0.55), y + Inches(0.05), Inches(12.2), Inches(0.5),
     [[("主要指标：输入（语音/语音+视频/多模态）✓　方法（单模态/多模态）✓　异常类型（言语表达·语音特征·姿态·手部·表情·生理指标+心理原因分析）✓",
        {"size": 12.5, "bold": True, "color": BLUE})]])

# ── 3 方案总览 ───────────────────────────────────────────────────────
s = slide()
header(s, "方案总览：一套真实管线，两类数据源", "以对话内容为驱动要素，不限于单一或多种信号输入", "03")
bullets(s, Inches(0.55), Inches(1.6), Inches(6.2), Inches(5),
        [("真实算法链", "ASR/分角色/声学/AU/姿态/手部/rPPG/NLI/话题 全部真实推理，非脚本回放"),
         ("单一分析管线", "文件导入与 WebRTC 活体采集走同一条离线批分析链路，报告口径一致"),
         ("可解释归因", "L1 观察 → L2 候选规则（文献）→ L3 结论含反事实与免责；LLM 仅叙述组装、不产出数值"),
         ("合规口径", "非临床诊断声明；双轨基线（现场标定/文献参考）；扩展信号封顶生理趋势层"),
         ("许可安全", "全栈 Apache-2.0/MIT/BSD，零授权费，可私有化商用")], size=14)
rect(s, Inches(7.1), Inches(1.6), Inches(5.7), Inches(5.1), fill=LIGHT)
text(s, Inches(7.35), Inches(1.75), Inches(5.2), Inches(0.5),
     [[("实测数据源（本轮验证真实使用）", {"size": 14, "bold": True, "color": BLUE})]])
bullets(s, Inches(7.35), Inches(2.3), Inches(5.2), Inches(4.2),
        [("录像样例 156s", "询问谈话双人对话 mp4（含画面+音轨）"),
         ("录音样例 156s", "同场谈话独立录音 m4a"),
         ("近红外序列 152s", "fNIRS HbO/HbR 厂商导出件 CSV"),
         ("毫米波序列 152s", "60GHz 雷达遥测导出件 CSV（呼吸/心率/体动）"),
         ("WebRTC 活体采集", "本机摄像头+麦克风实时采集，采集即入管线")], size=13)

# ── 4 总体架构 ───────────────────────────────────────────────────────
s = slide()
header(s, "总体架构", "契约不变、引擎替换：前端与报告链路零改动", "04")
boxes = [("采集层", "文件导入（mp4/m4a/csv）\nWebRTC 活体采集落盘", 0.55),
         ("预处理", "FFmpeg 统一 16kHz WAV\n25fps 抽帧 / 序列对齐", 3.35),
         ("真实分析链", "语音: FunASR+CAM++\n视觉: MediaPipe+RTMPose\n生理: rPPG POS\n语义: BERTopic+NLI", 6.15),
         ("融合与归因", "决策级时间窗聚合升级\n规则库 L2→L3 + LLM 叙述", 8.95),
         ("服务与呈现", "FastAPI 实现 /v1 契约\nWS 进度广播\n报告起草/审批/导出", 11.15)]
for t, d, x in [(b[0], b[1], b[2]) for b in boxes]:
    x = Inches(x)
    w = Inches(2.5) if x < Inches(11) else Inches(1.85)
    rect(s, x, Inches(2.0), w, Inches(2.9), fill=LIGHT, line=BLUE)
    text(s, x + Inches(0.12), Inches(2.15), w - Inches(0.24), Inches(0.5),
         [[(t, {"size": 14, "bold": True, "color": BLUE})]])
    text(s, x + Inches(0.12), Inches(2.7), w - Inches(0.24), Inches(2.1),
         [[(line, {"size": 10.5, "color": DARK})] for line in d.split("\n")], leading=1.25)
bullets(s, Inches(0.55), Inches(5.35), Inches(12.2), Inches(1.8),
        [("部署形态", "单机一体机（RTX 3060/4060 级即可全链路；CPU 可降级运行语音+视觉基础版），私有化部署"),
         ("中间产物全留痕", "转写 JSON/特征 CSV/AU 时序/脉搏波/规则命中清单逐环节落盘，实测可逐环节出示取证")], size=13)

# ── 5-7 技术路线 ─────────────────────────────────────────────────────
def tech_slide(idx, title, cols):
    s = slide()
    header(s, title, None, idx)
    w = Inches(12.2 / len(cols))
    x = Inches(0.55)
    for head, items in cols:
        rect(s, x, Inches(1.5), w - Inches(0.2), Inches(0.55), fill=BLUE)
        text(s, x + Inches(0.12), Inches(1.58), w - Inches(0.44), Inches(0.4),
             [[(head, {"size": 13.5, "bold": True, "color": RGBColor(255, 255, 255)})]])
        rect(s, x, Inches(2.05), w - Inches(0.2), Inches(4.6), fill=LIGHT)
        bullets(s, x + Inches(0.14), Inches(2.2), w - Inches(0.5), Inches(4.3),
                items, size=11.5, gap=False)
        x += w
    return s

tech_slide("05", "技术路线 ① 语音与言语分析", [
    ("ASR + 分角色", [("SenseVoiceSmall", "非自回归中文 ASR，CPU 17× 实时，词级时间戳"),
                  ("CAM++ 分离", "3D-Speaker 谱聚类，双人 DER≈4.7%"),
                  ("轮次对齐", "时间戳∩分离片段，真实 diar 置信度")]),
    ("声学特征", [("parselmouth", "F0/jitter/shimmer/HNR（Praat 内核）"),
                 ("librosa", "能量/静音段/谱质心"),
                 ("口径", "按 eGeMAPS 定义自复现，避开 openSMILE 商用禁令")]),
    ("言语异常", [("个体基线", "前段中位数+MAD，z-score 偏离"),
                 ("突变检测", "滑窗 z≥2.0 持续≥5s（jitter 2.5）"),
                 ("文献支撑", "焦虑/抑郁言语特征 Meta 分析（BMC Psychiatry 2024）")]),
    ("语义层", [("话题切分", "bge-m3 相似度变化点 + BERTopic"),
                ("矛盾检测", "Erlangshen-Roberta-NLI 初筛，≥0.5 放行"),
                ("影响值", "时长占比×情感翻转×矛盾密度，四维分解")])])

tech_slide("06", "技术路线 ② 视觉行为与视频生理", [
    ("面部 AU", [("FaceMesh 478 点", "小脸对策：Pose 引导 ROI + 3× 放大，检出率 0%→85%"),
                ("AU4/AU7 代理", "眉压/眼睑收紧几何映射，40–500ms 闪现检测"),
                ("头部姿态", "solvePnP 欧拉角（偏航/俯仰/翻滚）")]),
    ("姿态与手部", [("RTMPose", "躯干后仰角/肩线法线偏离，σ 带基线"),
                  ("手部 21 点", "手-脸距离+速度几何规则（自触/搓手）"),
                  ("冷启动路径", "几何规则 → 自标注 100-300 段 → 轻量分类器")]),
    ("rPPG 视频生理", [("POS 算法", "rPPG-Toolbox 口径自实现，8s 窗 HR"),
                 ("HRV 口径", "只报趋势方向，不报 LF/HF 绝对值"),
                 ("质量门", "光照 CV>0.3 或人脸检出<60% 降级")]),
    ("检测跟踪", [("SCRFD+ByteTrack", "单人谈话室稳定框"),
                ("离线逐帧", "稳定性优先于实时性"),
                ("许可", "全 Apache/MIT，零授权费")])])

tech_slide("07", "技术路线 ③ 扩展信号与融合归因", [
    ("毫米波雷达", [("文件级真实解析", "呼吸/心率遥测列 → 基线/峰值/趋势"),
                ("质量门", "体动超阈值区段降级"),
                ("在线契约", "MR60BHA2 级模组 UART→JSON（预留）")]),
    ("近红外 fNIRS", [("HbO/HbR 双通道", "漂移校正 + z 分数趋势"),
                ("口径", "MBLL 厂商导出，认知负荷需任务范式"),
                ("封顶", "只出生理趋势层，不进心理归因")]),
    ("多模态融合", [("决策级", "45s 滑窗：主信号≥1 且命中模态≥2 → ESCALATED"),
                ("同型合并", "60s 内 INFO/WARN 并条降噪，ALERT 保留"),
                ("显式缺失", "未命中模态列 ✕，避免「没测=正常」")]),
    ("可解释归因", [("规则库 YAML", "L2 条件→L3 心理解释+文献 DOI+反事实+免责"),
                ("LLM 边界", "Qwen2.5-7B 私有化仅叙述组装，数值全代码计算"),
                ("幻觉四件套", "RAG 白名单+JSON Mode+引用回溯+temperature 0")])])

# ── 8 许可优势 ───────────────────────────────────────────────────────
s = slide()
header(s, "许可优势：全栈零授权费", "招标语境下可私有化商用的合规选型", "08")
from pptx.util import Cm
tbl_data = [("环节", "本方案选型（许可）", "避开的风险项"),
            ("声学特征", "parselmouth 自复现 eGeMAPS（GPLv3+/ISC）", "openSMILE/eGeMAPS 开源版禁止商用"),
            ("面部 AU", "MediaPipe Face Landmarker（Apache-2.0）", "OpenFace 2.0 需 CMU 商用版税"),
            ("姿态/跟踪", "RTMPose / SCRFD+ByteTrack（Apache/MIT）", "Ultralytics YOLO AGPL 需企业授权"),
            ("ASR/分离", "FunASR / CAM++（MIT / Apache-2.0）", "无 HuggingFace 门禁与署名雷区"),
            ("LLM", "Qwen2.5-7B GGUF 私有化（Apache-2.0）", "数据不出域，无 API 依赖")]
tbl = s.shapes.add_table(len(tbl_data), 3, Inches(0.55), Inches(1.6), Inches(12.2), Inches(4.4)).table
tbl.columns[0].width = Inches(1.8)
tbl.columns[1].width = Inches(6.2)
tbl.columns[2].width = Inches(4.2)
for r, row in enumerate(tbl_data):
    for c, val in enumerate(row):
        cell = tbl.cell(r, c)
        cell.text = val
        for p in cell.text_frame.paragraphs:
            for run in p.runs:
                run.font.size = Pt(12 if r else 13)
                run.font.bold = (r == 0)
                run.font.name = "PingFang SC"
                run.font.color.rgb = RGBColor(255, 255, 255) if r == 0 else DARK
        cell.fill.solid()
        cell.fill.fore_color.rgb = BLUE if r == 0 else (LIGHT if r % 2 else RGBColor(255, 255, 255))
text(s, Inches(0.55), Inches(6.3), Inches(12.2), Inches(0.6),
     [[("结论：全部依赖 Apache-2.0 / MIT / BSD / ISC，私有化商用零授权费，满足「定制研发生产」比选方式。",
        {"size": 13, "bold": True, "color": GREEN})]])

# ── 9 合规口径 ───────────────────────────────────────────────────────
s = slide()
header(s, "合规与口径红线", "心理分析类系统的三条生命线", "09")
bullets(s, Inches(0.55), Inches(1.7), Inches(12.2), Inches(4.8),
        [("非临床诊断", "界面/报告/导出三处写死「行为与心理状态辅助分析，不构成临床心理诊断」；所有结论标注「模型推断」"),
         ("双轨基线", "首选现场静息标定（入席 3-5 分钟中位数作个体基线）；文献参考水平（如 RR 12-20 次/分）仅作区间参照；无标定只出相对升幅"),
         ("扩展信号封顶", "毫米波/近红外结论封顶生理趋势层：不进升级、不出心理归因，报告强制标注「离线导入 · 非实时」"),
         ("数据合规", "音视频与生理数据按《个人信息保护法》敏感个人信息处理：单独同意、加密存储、脱敏导出、审计哈希链留痕（抽改任一条其后全部断裂）"),
         ("人工终审", "NLI 矛盾≠事实矛盾、微表情学术 SOTA F1 仅 0.41-0.45——系统只出「候选解释排序 + 反事实」，最终判断权在使用方")],
        size=14)

# ── 10-18 实测截图页 ────────────────────────────────────────────────-
def shot_slide(idx, title, img, caption, points=None):
    s = slide()
    header(s, title, None, idx)
    pic_fit(s, img, Inches(0.55), Inches(1.35), Inches(9.4), Inches(5.6))
    text(s, Inches(10.15), Inches(1.5), Inches(2.75), Inches(5.3),
         [[(caption, {"size": 12.5, "bold": True, "color": BLUE})]] +
         [[(p, {"size": 11.5, "color": DARK})] for p in (points or [])])
    return s

shot_slide("10", "产品界面 · 任务台与多源素材登记", "02_新建会话.png",
           "一次登记 1-4 份素材：音视频为主信号，近红外/毫米波为扩展信号；登记即入分析",
           ["服务端 ffprobe 实测时长", "登记口径：每份都进分析、都出切片", "扩展信号非必填可多选"])
shot_slide("11", "产品界面 · WebRTC 活体采集", "03_活体采集.png",
           "本机摄像头+麦克风采集，结束后自动进入与文件导入相同的离线批分析管线",
           ["采集端只做预览（画面/电平/计时）", "报告强制标注来源", "双人对话含 1 分钟静息标定段效果最佳"])
shot_slide("12", "实测结果 · 会话级汇总", "04_结果_汇总.png",
           f"四素材 156s 会话真实批分析产物（{STATS['finished_at']} 完成）",
           [f"上报异常 {STATS['anomalies']} 条 / 裁撤 {STATS['suppressed']} 条",
            f"转写 {STATS['turns']} 轮 / 话题 {STATS['impacts']} 个",
            f"峰值严重度 {STATS['peak'].upper()}（含跨模态聚合升级）",
            f"判定口径 {STATS['pipeline']}"])
shot_slide("13", "实测结果 · 逐素材切片", "05_结果_素材切片.png",
           "每份文件各跑各的解析链：步骤、模态可用性、质量门、封顶口径逐片列示",
           ["视频 6 步/音频 5 步/扩展 4 步", "质量降级显式标注（人脸检出率/亮度/体动）", "未提供模态列 ✕ 不出 0 值"])
shot_slide("14", "实测结果 · 异常事件列表", "06_结果_异常表.png",
           "真实检测事件：语音特征/语义矛盾/姿态/聚合升级分级列示，点击进三级归因",
           [f"级别分布 {STATS['severity']}", f"模态分布 {STATS['modality']}",
            "ALERT 逐条保留，INFO/WARN 同型合并"])
shot_slide("15", "实测结果 · 三级归因抽屉", "08_三级归因抽屉.png",
           "L1 观察层（物理量+单位）→ L2 候选规则（文献）→ L3 结论（反事实+免责）",
           ["规则库 9 条覆盖六模态+融合", "结论=规则命中，LLM 仅叙述组装", "导出 CSV 含裁撤条目"])
shot_slide("16", "实测结果 · 话题与语义影响值", "07_结果_话题表.png",
           "话题边界由 bge-m3 相似度变化点判定（非人工划定），影响值四维分解",
           ["影响值仅会话内排序", "矛盾对 NLI 判定，≥0.5 放行", "边界判定依据逐话题写明"])
shot_slide("17", "实测结果 · 分析报告与审批", "10_报告详情与审批流水.png",
           "批分析完成自动起草 → 提交 → 复核人审批/驳回 → 发布导出，全流程服务端校验",
           ["R1：缺文书号 403 拦截", "R2：免责章节删除 422 拦截", "R6：导出落审计哈希链"])

# ── 19 实测数据一览 ─────────────────────────────────────────────────
s = slide()
header(s, "本轮实测数据一览（真实算法输出）", f"会话 {STATS['session']} · {STATS['subject']} · 四素材 {STATS['duration']}s", "18")
cards = [(str(STATS['anomalies']), "上报异常"), (str(STATS['turns']), "分角色转写轮次"),
         (str(STATS['impacts']), "话题边界"), (str(STATS['slices']), "素材切片"),
         (STATS['peak'].upper(), "峰值严重度")]
x = Inches(0.55)
for v, t in cards:
    rect(s, x, Inches(1.6), Inches(2.32), Inches(1.5), fill=LIGHT, line=BLUE)
    text(s, x, Inches(1.78), Inches(2.32), Inches(0.8),
         [[(v, {"size": 30, "bold": True, "color": RED if v == "RED" else BLUE})]], align=PP_ALIGN.CENTER)
    text(s, x, Inches(2.62), Inches(2.32), Inches(0.4),
         [[(t, {"size": 12, "color": GRAY})]], align=PP_ALIGN.CENTER)
    x += Inches(2.47)
tbl2 = [["典型事件", "级别", "模态", "置信度"]]
for a in STATS["top_anomalies"]:
    tbl2.append([a["type"][:20], a["severity"], a["modality"], str(a["conf"])])
tbl = s.shapes.add_table(len(tbl2), 4, Inches(0.55), Inches(3.5), Inches(12.2), Inches(3.3)).table
tbl.columns[0].width = Inches(6.2)
for r, row in enumerate(tbl2):
    for c, val in enumerate(row):
        cell = tbl.cell(r, c)
        cell.text = val
        for p in cell.text_frame.paragraphs:
            for run in p.runs:
                run.font.size = Pt(11.5)
                run.font.bold = (r == 0)
                run.font.name = "PingFang SC"
                run.font.color.rgb = RGBColor(255, 255, 255) if r == 0 else DARK
        cell.fill.solid()
        cell.fill.fore_color.rgb = BLUE if r == 0 else (LIGHT if r % 2 else RGBColor(255, 255, 255))

# ── 20 验证计划 ─────────────────────────────────────────────────────
s = slide()
header(s, "实测考察 · 验证方式与中间产物", "「主要考察参赛方提供的行为异常检测能力」——逐环节可出示", "19")
bullets(s, Inches(0.55), Inches(1.6), Inches(6.4), Inches(5.3),
        [("文件样例端到端", "四素材登记→真实批分析→逐素材切片→异常列表→三级归因→报告导出"),
         ("WebRTC 活体采集", "现场双人对话（含静息标定段）→ 采集即入同一管线 → 同口径报告"),
         ("单环节可复算", "任一条异常可回放定位到素材时间点，中间产物齐全")], size=13.5)
rect(s, Inches(7.3), Inches(1.6), Inches(5.5), Inches(5.1), fill=LIGHT)
text(s, Inches(7.55), Inches(1.75), Inches(5), Inches(0.4),
     [[("每环节可出示的中间产物", {"size": 13.5, "bold": True, "color": BLUE})]])
bullets(s, Inches(7.55), Inches(2.25), Inches(5), Inches(4.3),
        ["turns.json（转写+词级时间戳+分离置信度）",
         "features.csv（逐窗声学特征与基线）",
         "au_series.csv / pose_series.csv（时序）",
         "waveform.csv / hr_series.csv（rPPG）",
         "mmwave/nir 趋势序列与质量门记录",
         "contradictions.json（NLI 逐对分数）",
         "规则命中清单 + 审计哈希链"], size=12, gap=False)

# ── 21 交付与里程碑 ────────────────────────────────────────────────
s = slide()
header(s, "交付内容与计划", "定制研发（市场无标准化产品，可按需求方场景定制）", "20")
bullets(s, Inches(0.55), Inches(1.6), Inches(7.2), Inches(5),
        [("已交付", "真实算法分析系统（文件导入+活体采集双链路，可现场实测）"),
         ("方案文档", "真实实现优化方案设计（技术路线/契约/口径/风险）"),
         ("后续定制项", "毫米波/fNIRS 硬件在线接入与时空同步；现场标定工具；标注回流迭代手部动作模型"),
         ("部署支持", "单机一体机私有化部署，数据不出域")], size=14)
rect(s, Inches(8.1), Inches(1.6), Inches(4.7), Inches(5.1), fill=LIGHT)
text(s, Inches(8.35), Inches(1.75), Inches(4.2), Inches(0.4),
     [[("联系方式", {"size": 14, "bold": True, "color": BLUE})]])
text(s, Inches(8.35), Inches(2.3), Inches(4.2), Inches(3),
     [[("RedCreationTech", {"size": 16, "bold": True, "color": DARK})],
      [("（此处放置联系人/电话/邮箱）", {"size": 12, "color": GRAY})],
      [("", {"size": 8})],
      [("需求编号：7008111111", {"size": 12, "color": GRAY})],
      [("比选方式：文字解决方案 + 产品实测", {"size": 12, "color": GRAY})]])

prs.save(OUT)
print("SAVED", OUT, len(prs.slides.__iter__.__self__._sldIdLst), "slides")
