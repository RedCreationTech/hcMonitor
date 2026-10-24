"""种子数据：成员 + 历史会话行（真实服务同样保留演示态，但 offline 产物只来自真实分析）。

与 mock 的差异：历史种子的 offline 一律为 null——本服务的分析产物只能来自真实跑批，
不给种子伪造结果（此前 mock 的归档会话有脚本产物，属回放特例）。
"""
from __future__ import annotations

import datetime

MEMBERS = [
    {"id": "W-01", "name": "分析师 W-01", "role": "analyst", "seat": "研判席 1", "online": True, "forms": ["A", "B", "C"]},
    {"id": "W-02", "name": "分析师 W-02", "role": "analyst", "seat": "研判席 2", "online": True, "forms": ["A", "B", "C", "D"]},
    {"id": "W-03", "name": "分析师 W-03", "role": "analyst", "seat": "研判席 3", "online": False, "forms": ["B", "C"]},
    {"id": "R-01", "name": "复核人 R-01", "role": "reviewer", "seat": "复核席", "online": True, "forms": ["A", "B", "C", "D"]},
    {"id": "R-02", "name": "复核人 R-02", "role": "reviewer", "seat": "复核席 2", "online": True, "forms": ["A", "B"]},
    {"id": "C-04", "name": "专职采集员 C-04", "role": "collector", "seat": "谈话室 03", "online": False, "forms": ["A", "B"]},
    {"id": "V-01", "name": "值守席 V-01", "role": "reviewer", "seat": "值守台", "online": False, "forms": ["A", "B", "C", "D"]},
]

FORM_LABEL = {"A": "形态 A · 同址单人（边谈边看）", "B": "形态 B · 同址双人（隔壁分析）",
              "C": "形态 C · 异址多路（集中研判）", "D": "形态 D · 外勤单兵（手机采集）"}


def _ses(i, subject, scene, form, collector, analyst, status, started, dur, lamp,
         anomalies, markers, consent, modalities, source, assets=None):
    return {
        "id": i, "subject_code": subject, "scene": scene, "form": form,
        "collector": collector, "analyst": analyst, "status": status,
        "started_at": started, "duration_seconds": dur, "peak_lamp": lamp,
        "anomaly_count": anomalies, "marker_count": markers,
        "consent_doc": consent, "modality_set": modalities, "source": source,
        "asset": (assets[0] if assets else None),
        "assets": assets, "offline_job": None, "offline": None,
    }


def seed_sessions() -> list[dict]:
    a88 = {"id": "video:CAM03", "name": "CAM03_20261016_1430.mp4", "size_bytes": 104857600,
           "duration_seconds": 1560, "kind": "video"}
    return [
        _ses("SES-2026-1019-A07", "对象 M-118", "经侦询问 · 谈话室 03", "B", "专职采集员 C-04", "分析师 W-02",
             "live", "2026-10-19 14:26", 0, "green", 0, 0, "SQ-2026-118",
             ["voice", "semantic", "face", "pose", "hand", "physio"], "live"),
        _ses("SES-2026-1017-V31", "对象 M-088", "既往谈话录像复盘 · 离线导入", "A", "分析师 W-01", "分析师 W-01",
             "closed", "2026-10-17 10:02", 1560, "orange", 7, 1, "SQ-2026-088（含录像二次使用授权）",
             ["voice", "semantic", "face", "pose"], "imported",
             [a88, {"id": "mmwave:radar", "name": "mmwave_radar_1430.csv", "size_bytes": 20480,
                    "duration_seconds": 1560, "kind": "mmwave"}]),
        _ses("SES-2026-1018-A03", "对象 M-104", "信访约谈 · 谈室 01", "A", "谈话人本人", "分析师 W-01",
             "review", "2026-10-18 09:12", 2400, "red", 11, 6, "SQ-2026-104",
             ["voice", "semantic", "face", "pose"], "live"),
        _ses("SES-2026-1017-D22", "对象 R-077", "社区走访 · 外勤单兵", "D", "外勤员 D-11", "值守席 V-01",
             "review", "2026-10-17 16:40", 1140, "orange", 4, 3, "口头告知 · 录音留证",
             ["voice", "semantic"], "live"),
        _ses("SES-2026-1016-C08", "对象 M-091", "银行面审 · 异址多路", "C", "专职采集员 C-07", "分析师 W-03",
             "closed", "2026-10-16 10:05", 3300, "red", 17, 9, "SQ-2026-091",
             ["voice", "semantic", "face", "pose", "hand"], "live"),
        _ses("SES-2026-1015-A01", "对象 H-032", "医院随访 · 心理科", "A", "谈话人本人", "分析师 W-01",
             "closed", "2026-10-15 15:20", 1860, "orange", 6, 2, "SQ-2026-032",
             ["voice", "semantic", "face", "physio"], "live"),
    ]


def now_str() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
