"""模型下载：ModelScope / HuggingFace 统一入口，失败重试 3 次。

所有模型落到 config.MODELS（不入库）；下载失败必须显式报错，
不得静默降级到 mock。
"""
from __future__ import annotations

import time
from pathlib import Path

from .config import MODELS

RETRIES = 3


def ms_download(model_id: str) -> Path:
    """ModelScope 模型 → models/<model_id>，重试 3 次。"""
    from modelscope import snapshot_download

    last_err: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        try:
            path = snapshot_download(model_id, cache_dir=str(MODELS))
            return Path(path)
        except Exception as e:                     # noqa: BLE001（网络类错误统一重试）
            last_err = e
            print(f"[model_dl] {model_id} 第 {attempt}/{RETRIES} 次下载失败: {e}")
            time.sleep(5 * attempt)
    raise RuntimeError(f"模型下载失败（重试 {RETRIES} 次）: {model_id}: {last_err}")


def hf_download(repo_id: str) -> Path:
    """HuggingFace 模型 → models/<repo_id 末段>，被墙时自动切 hf-mirror 重试。"""
    from huggingface_hub import snapshot_download

    target = MODELS / repo_id.split("/")[-1]
    endpoints = ["https://hf-mirror.com", "https://huggingface.co"]
    last_err: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        endpoint = endpoints[(attempt - 1) % len(endpoints)]
        try:
            snapshot_download(repo_id, local_dir=str(target),
                              endpoint=endpoint, max_workers=4)
            return target
        except Exception as e:                     # noqa: BLE001
            last_err = e
            print(f"[model_dl] {repo_id} 第 {attempt}/{RETRIES} 次下载失败"
                  f"（endpoint={endpoint}）: {e}")
            time.sleep(5 * attempt)
    raise RuntimeError(f"模型下载失败（重试 {RETRIES} 次）: {repo_id}: {last_err}")
