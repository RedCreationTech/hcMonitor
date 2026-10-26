"""音频预处理：ffmpeg 子进程转 16kHz 单声道 WAV（FunASR/声学分析统一入口）。

m4a/mp4 等容器只取音轨；同目录缓存 *.16k.wav，重复分析直接复用。
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from ..config import SR, FFMPEG


def audio_to_wav(path: str | Path) -> Path:
    """任意 ffmpeg 可解码音频 → 16kHz 单声道 WAV，缓存同目录 <stem>.16k.wav。"""
    src = Path(path)
    if not src.exists():
        raise FileNotFoundError(f"音频素材不存在: {src}")
    dst = src.with_name(src.name + ".16k.wav")
    if dst.exists() and dst.stat().st_size > 0:
        return dst                                  # 缓存命中
    cmd = [FFMPEG, "-hide_banner", "-y", "-nostdin",
           "-i", str(src), "-vn", "-ac", "1", "-ar", str(SR),
           "-acodec", "pcm_s16le", str(dst)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if proc.returncode != 0 or not dst.exists():
        dst.unlink(missing_ok=True)
        raise RuntimeError(
            f"ffmpeg 转码失败（{src.name}）: {proc.stderr[-500:]}")
    return dst
