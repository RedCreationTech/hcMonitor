"""一次性下载 speech/semantic 链全部模型（首次运行约 6GB，后台跑）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import MS_ASR, MS_VAD, MS_PUNC, MS_DIAR, MS_EMBED, NLI_HF
from app.model_dl import ms_download, hf_download

for mid in (MS_VAD, MS_ASR, MS_PUNC, MS_DIAR, MS_EMBED):
    p = ms_download(mid)
    print(f"OK {mid} -> {p}", flush=True)

p = hf_download(NLI_HF)
print(f"OK {NLI_HF} -> {p}", flush=True)
print("ALL DONE")
