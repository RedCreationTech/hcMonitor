"""检测器内部事件格式（fusion 升级与归因的输入）。

各检测模块产出 RawEvent；fusion 做时间窗聚合与升级；
attribution 把 RawEvent + 命中的规则组装成契约形状的 AnomalyEvent。
cap_note 非 None 即封顶条目（扩展信号产物，不进心理归因）。
"""
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class RawEvent:
    ts: float                        # 事件发生时刻（秒，会话时轴）
    modality: str                    # voice/semantic/face/pose/hand/physio
    type: str                        # 人类可读的异常类型名
    severity: str                    # INFO/WARN/ALERT/ESCALATED（fusion 前最高 ALERT）
    confidence: float                # 0-1，检测置信度或偏离度归一
    deviation: float = 0.0           # 个体基线偏离（z-score），规则阈值判定读这个
    window: tuple = (0.0, 0.0)       # 证据时段 (from, to)
    metrics: dict = field(default_factory=dict)   # {指标名: (值, 单位)}——观察层证据句原料
    asset_id: Optional[str] = None   # 证据素材
    participant_id: Optional[str] = None
    member_ids: list[str] = field(default_factory=list)
    asset_ids: list[str] = field(default_factory=list)
    cap_note: Optional[str] = None   # 非 None = 趋势层封顶
    segment_id: Optional[str] = None
