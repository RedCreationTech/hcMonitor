"""全局配置：路径、模型 ID、判定口径。

模型一律从 ModelScope 拉取（国内网络友好），缓存到 models/ 不入库。
许可红线：全栈 Apache-2.0/MIT/BSD，禁用 openSMILE（商用禁令）、OpenFace（CMU 版税）、
Ultralytics YOLO（AGPL）——选型理由见 docs/优化需求方案设计-7008111111.md §11。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT.parent / "data"
MODELS = ROOT.parent / "models"
UPLOADS = DATA / "uploads"          # 会话素材原文
ARTIFACTS = DATA / "artifacts"      # 每会话中间产物（转写/特征/AU 时序…可出示取证）
STORE = DATA / "store.json"         # 会话/报告/审计的状态库

# ── ModelScope 模型 ID ──────────────────────────────────────────────
MS_ASR = "iic/SenseVoiceSmall"                    # 主选：非自回归，中文 CPU 17× 实时，附情感标签
MS_ASR_LARGE = "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"  # 备选
MS_VAD = "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"   # onnx 版在 funasr1.4.16 无法加载，用同权重 pytorch 版
MS_PUNC = "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch"
MS_DIAR = "iic/speech_campplus_speaker-diarization_common"   # VAD+CAM++ 一体化分角色
MS_EMBED = "BAAI/bge-m3"                          # 话题切分 embedding
NLI_HF = "IDEA-CCNL/Erlangshen-Roberta-330M-NLI"  # 中文 NLI 矛盾初筛（ModelScope 无镜像，走 HF；
                                                  #  下载失败时设 HF_ENDPOINT=https://hf-mirror.com）
MS_LLM_GGUF = "Qwen/Qwen2.5-7B-Instruct-GGUF"     # 归因叙述组装（Q4_K_M）

# ── 判定口径 ─────────────────────────────────────────────────────────
PIPELINE_VERSION = "real-1.0"     # 与实时链共用的口径版本号（导出件对账读这一行）
DISCLAIMER = ("本系统输出行为风险提示，不构成临床心理诊断；所有结论为模型推断，"
              "最终判断由现场人员与后方分析师共同作出。")

# 生理趋势层封顶声明（扩展信号 cap_note，语义与原型一致）
CAP_NOTE = ("扩展信号（离线导入 · 非实时）：结论封顶生理趋势层——不进升级、不出心理归因。"
            "硬件在线接入、时钟同步与个体标定属后续项。")

# 采样与窗口
SR = 16000                        # 统一音频采样率
VIDEO_FPS = 25                    # 抽帧率
FUSION_WINDOW_S = 45              # 跨模态升级滑窗（秒）
EXT_RESAMPLE_HZ = 1               # 扩展信号公共时轴

MODALITY_LABEL = {
    "voice": "语音", "semantic": "语义", "face": "表情",
    "pose": "姿态", "hand": "手部", "physio": "生理",
}
