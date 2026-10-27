"""All formats render the same frozen report and evidence snapshot."""
import csv
import hashlib
import html
import io
import json
import os
from pathlib import Path
from .config import DISCLAIMER


def safe_csv(value):
    value=str(value if value is not None else '')
    return "'"+value if value.lstrip().startswith(('=','+','-','@')) else value


def document(report):
    snapshot=report['snapshot']; result=snapshot['result']
    provenance=f"报告 {report['id']} / v{report['version']} · run {report['source_run_id']} · 内容 {report['content_hash']}"
    if snapshot.get('presentation'):
        return provenance,[(s['title'],s['text']) for s in snapshot['presentation']]
    sections=[(s['title'],s['text']) for s in snapshot['sections']]
    labels={'confirmed':'行为成立','rejected':'不支持','abstain':'弃权','supported':'支持候选解释'}
    evidence=[]
    for e in result['anomalies']:
        review=snapshot['reviews'].get(e['id'],{})
        evidence.append(f"{e['id']} · {e['ts']}秒 · {e['type']} · 素材 {','.join(a['id'] for a in e['source_assets'])}")
        if e.get('segment_id'):evidence.append('连续区间：'+e['segment_id']+'；时刻已映射回原件文件秒数')
        evidence.append('观察：'+'；'.join(o['text'] for o in e['attribution']['observation']))
        evidence.append('行为判断：'+labels.get(review.get('behavior'),'未复核')+'；候选解释：'+labels.get(review.get('explanation'),'未复核'))
        evidence.append('复核依据：'+review.get('note',''))
        if e.get('cap_note'):evidence.append('能力上限：'+e['cap_note'])
        for rule in e['attribution']['candidate_rules']:
            if rule['hit']:evidence.append(f"候选规则 {rule['rule_id']}：{rule['pattern']}；引文条目 {rule['literature_ref']}（需专业核验，非本项目效度证明）")
    quality=[]
    for item in result.get('slices',[]):
        quality.append(f"{item['asset_name']}：质量 {item['quality']}；{item.get('quality_note','')}；个人基线 {item.get('baseline_status') or '不适用'}；不可用通道 {'、'.join(item.get('modality_unavailable',[])) or '见逐项说明'}")
    intervals=result.get('manifest',{}).get('analysis_intervals')
    if intervals:
        quality.append('连续有效区间核验人：'+intervals['verified_by']+'；依据：'+intervals['note'])
        quality.extend(f"素材 {r['asset_id']} 有效文件秒数 {r['start']}—{r['end']}；其余范围排除；不跨区间归一、基线或融合" for r in intervals['ranges'])
    if quality:sections.append(('系统能力与质量记录（固定附件）','\n'.join(quality)))
    sections.append(('附录：来源与逐条复核','\n'.join(evidence) or '本次无候选异常事件。'))
    narrative=result['narrative'];status={'generated':'本地模型已生成候选叙述','not_applicable':'本次无符合条件的叙述输入','degraded':'本地模型降级，使用确定性规则'}
    text=status.get(narrative['status'],narrative['status'])+'\n'+(narrative.get('text') or narrative.get('reason',''))
    if narrative.get('model_hash'):text+='\n叙述模型 SHA256 '+narrative['model_hash']
    for ref in narrative.get('citations',[]):text+=f"\n引用 {ref['run_id']} / {ref['event_id']} / {ref['rule_id']}"
    sections.append(('本地叙述与引用',text))
    sections.append(('原件指纹','\n'.join(f"{a['id']} {a['name']} SHA256 {a['sha256']}" for a in result['assets'])))
    manifest=result['manifest'];method=[DISCLAIMER,'方法：话题指数仅按文件内归一；不同文件独立时轴，不进行跨文件同窗升级。']
    if intervals:method.append('本轮话题指数按连续有效区间分别归一；片段之间不直接比较，不将排除时长计作沉默。')
    capture=manifest.get('capture') or {}
    if capture.get('mode')=='independent-segments-v1':
        method.append('暂停分段：每个连续片段为独立原件；现场时钟仅作采集记录，分析与回看使用各文件独立时轴。')
        method.extend(f"素材 {p['asset_id']}：现场 {p['wall_start']:.3f}—{p['wall_end']:.3f}秒；结束原因 {p['closed_by']}" for p in capture['segments'])
        method.extend(f"排除空片段 {p['id']}：{p['reason']}" for p in capture.get('omitted_segments',[]))
    runtime=manifest.get('environment',{})
    if runtime:
        method.append('运行环境：Python '+runtime['python']+'；'+runtime['platform'])
        method.append('依赖版本：'+'；'.join(f'{k} {v}' for k,v in runtime['packages'].items()))
        for name,tool in runtime['tools'].items():method.append(name+' SHA256 '+tool.get('sha256','不可用'))
    if manifest.get('code_hash'):method.append('代码指纹 SHA256 '+manifest['code_hash'])
    for model in manifest.get('models',[]):method.append(f"模型/规则/字体 {model['path']} · SHA256 {model['sha256']}")
    if manifest.get('result_artifact'):method.append('算法输出 result.json · SHA256 '+manifest['result_artifact']['sha256'])
    for artifact in manifest.get('files',[]):method.append(f"运行工件 {artifact['path']} · SHA256 {artifact['sha256']}")
    sections.append(('方法与复现指纹','\n'.join(method)))
    return provenance,sections


def render(report,fmt,recipient,purpose):
    meta,sections=document(report)
    frozen_disclaimer=report['snapshot'].get('disclaimer',DISCLAIMER)
    watermark=f"接收人 {recipient} · 用途 {purpose}"
    if fmt=='html':
        esc=html.escape
        markup=f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>{esc(report["title"])}</title><style>body{{font-family:system-ui;max-width:900px;margin:32px auto;line-height:1.8}}p{{white-space:pre-wrap;overflow-wrap:anywhere}}.meta{{color:#666;font-size:12px}}@media print{{body{{margin:15mm}}}}</style><body><h1>{esc(report["title"])}</h1><p class="meta">{esc(meta)}<br>{esc(watermark)}</p>'
        markup+=''.join(f'<h2>{esc(title)}</h2><p>{esc(text)}</p>' for title,text in sections)
        return (markup+'</body></html>').encode(), 'text/html; charset=utf-8'
    if fmt=='csv':
        buf=io.StringIO(newline='');w=csv.writer(buf)
        segmented=bool(report['snapshot']['result'].get('manifest',{}).get('analysis_intervals'))
        w.writerow(['report_id','version','content_hash','run_id','event_id','time_s','type','sources','observation','behavior','explanation','review_note','disclaimer']+(['segment_id'] if segmented else []))
        for e in report['snapshot']['result']['anomalies']:
            review=report['snapshot']['reviews'].get(e['id'],{})
            w.writerow([safe_csv(v) for v in [report['id'],report['version'],report['content_hash'],report['source_run_id'],e['id'],e['ts'],e['type'],json.dumps(e['source_assets'],ensure_ascii=False),json.dumps(e['attribution']['observation'],ensure_ascii=False),review.get('behavior'),review.get('explanation'),review.get('note'),frozen_disclaimer]+([e.get('segment_id','')] if segmented else [])])
        # Empty evidence still carries the exact version and disclaimer.
        if not report['snapshot']['result']['anomalies']: w.writerow([report['id'],report['version'],report['content_hash'],report['source_run_id'],'','','','','','','','',frozen_disclaimer]+([''] if segmented else []))
        return ('\ufeff'+buf.getvalue()).encode(), 'text/csv; charset=utf-8'
    if fmt!='pdf': raise ValueError('不支持的格式')
    from reportlab.pdfgen.canvas import Canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    font=Path(os.getenv('PDF_FONT',str(Path(__file__).parent.parent/'fonts'/'chinese.ttf')))
    if not font.is_file(): raise ValueError('离线中文字体缺失，请配置PDF_FONT或导入字体包')
    if 'M1Chinese' not in pdfmetrics.getRegisteredFontNames(): pdfmetrics.registerFont(TTFont('M1Chinese',str(font)))
    buf=io.BytesIO();doc=SimpleDocTemplate(buf,pagesize=A4,rightMargin=42,leftMargin=42,topMargin=48,bottomMargin=48)
    style=ParagraphStyle('body',fontName='M1Chinese',fontSize=10,leading=16,wordWrap='CJK',spaceAfter=10)
    title_style=ParagraphStyle('title',parent=style,fontSize=16,leading=24,spaceAfter=16,keepWithNext=True)
    story=[Paragraph(html.escape(report['title']),title_style),Paragraph(html.escape(meta),style),Paragraph(html.escape(watermark),style)]
    for title,text in sections:
        story += [Paragraph(html.escape(title),title_style)]
        # Bound individual paragraphs so long evidence does not exceed a page frame.
        for line in text.splitlines() or ['']:
            for i in range(0,max(1,len(line)),350): story.append(Paragraph(html.escape(line[i:i+350]) or ' ',style))
    def footer(canvas,document):
        canvas.setFont('M1Chinese',8);canvas.drawString(42,26,f"{report['id']} / v{report['version']} / {document.page}")
    doc.build(story,onFirstPage=footer,onLaterPages=footer)
    return buf.getvalue(),'application/pdf'
