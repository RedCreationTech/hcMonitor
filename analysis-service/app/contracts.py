"""契约模型：镜像 prototype-lite/src/shared/types.ts。

服务对外下发的 JSON 必须与前端读取的字段名/类型一致；改动这里=改契约。
"""
from typing import Literal, Optional
from pydantic import BaseModel

Severity = Literal["INFO", "WARN", "ALERT", "ESCALATED"]
LampLevel = Literal["green", "orange", "red"]
AssetKind = Literal["video", "audio", "nir", "mmwave"]
ModalityKey = Literal["voice", "semantic", "face", "pose", "hand", "physio"]


class AssetRef(BaseModel):
    id: str
    name: str
    size_bytes: int
    duration_seconds: int
    kind: AssetKind


class SourceAsset(BaseModel):
    id: str
    name: str
    kind: AssetKind


class Observation(BaseModel):
    modality: ModalityKey
    text: str
    ts_from: float
    ts_to: float


class CandidateRule(BaseModel):
    rule_id: str
    pattern: str
    psych_state: str
    literature_ref: str
    weight: float
    hit: bool


class Attribution(BaseModel):
    observation: list[Observation]
    candidate_rules: list[CandidateRule]
    conclusion: dict          # {psych_state, confidence, counterfactual, disclaimer}


class AnomalyEvent(BaseModel):
    run_id: Optional[str] = None
    participant_id: Optional[str] = None
    source_event_ids: list[str] = []
    event: Literal["anomaly"] = "anomaly"
    id: str
    session_id: str
    ts: float
    modality: ModalityKey
    type: str
    severity: Severity
    confidence: float
    lamp: LampLevel = "green"
    advice: str = ""
    attribution: Attribution
    source_assets: Optional[list[SourceAsset]] = None
    cap_note: Optional[str] = None


class DialogueTurn(BaseModel):
    event: Literal["dialogue"] = "dialogue"
    ts: float
    id: str = ""
    end: float = 0
    speaker_id: Optional[str] = None
    participant_id: Optional[str] = None
    asset_id: Optional[str] = None
    speaker: Literal["interviewer", "subject", "unknown", "overlap"]
    text: str
    speech_rate: Optional[float] = None
    diar_confidence: Optional[float] = None
    diar_state: Literal["ok", "degraded", "off"] = "ok"


class ImpactEvent(BaseModel):
    event: Literal["impact"] = "impact"
    ts: float
    topic_id: str
    boundary: tuple[float, float]
    label: str
    impact_score: float
    dims: dict                # {情绪冲击, 认知冲突, 利益相关, 持续影响}
    rationale_text: str = ""
    boundary_evidence: str


class TrendMetric(BaseModel):
    name: str
    unit: str
    decimals: int
    baseline: float
    peak: float
    peak_ts: float
    end_value: float
    series: list[float]


class PhysioTrend(BaseModel):
    sensor_label: str
    samples: int
    time_base: Literal["素材登记时长", "脚本时轴（素材未提供时基）"]
    metrics: list[TrendMetric]
    limits: list[str]


class SuppressedItem(BaseModel):
    id: str
    reason: str


class OfflineSlice(BaseModel):
    asset_id: str
    asset_name: str
    kind: AssetKind
    role: Literal["primary", "extension"]
    size_bytes: int
    duration_seconds: int
    modality_available: list[ModalityKey]
    modality_unavailable: list[ModalityKey]
    steps: list[str]
    event_ids: list[str]
    suppressed: list[SuppressedItem]
    trend: Optional[PhysioTrend] = None
    cap_note: Optional[str] = None
    quality: Literal["ok", "degraded"] = "ok"
    quality_note: str = ""


class OfflineResult(BaseModel):
    schema_version: str = "2.0"
    run_id: Optional[str] = None
    narrative: dict = {}
    manifest: dict = {}
    raw_events: list[dict] = []
    finished_at: str
    asset_kind: Literal["video", "audio"]
    assets: list[AssetRef]
    slices: list[OfflineSlice]
    modality_available: list[ModalityKey]
    duration_seconds: int
    turns: list[DialogueTurn]
    anomalies: list[AnomalyEvent]
    impacts: list[ImpactEvent]
    suppressed: list[SuppressedItem]
    report_id: str
    pipeline: str
