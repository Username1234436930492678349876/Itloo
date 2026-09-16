from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from typing import Any

import numpy as np

ALIGNMENT_MODEL = os.getenv("QWS_ALIGNMENT_MODEL", "jonatasgrosman/wav2vec2-large-xlsr-53-arabic")
QURAN_MODEL = os.getenv("QWS_QURAN_MODEL", "TBOGamer22/wav2vec2-quran-phonetics")


@dataclass
class LoadedModel:
    processor: Any
    model: Any
    device: str


_lock = threading.Lock()
_alignment: LoadedModel | None = None
_quran: LoadedModel | None = None


def _imports():
    try:
        import torch
        from transformers import AutoModelForCTC, AutoProcessor
    except Exception as exc:
        raise RuntimeError(
            "AI dependencies are not installed. Run setup-ai.ps1 (or pip install -r backend/requirements.txt)."
        ) from exc
    return torch, AutoModelForCTC, AutoProcessor


def _device(torch: Any) -> str:
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _load(model_id: str) -> LoadedModel:
    torch, AutoModelForCTC, AutoProcessor = _imports()
    device = _device(torch)
    processor = AutoProcessor.from_pretrained(model_id)
    model = AutoModelForCTC.from_pretrained(model_id)
    model.eval().to(device)
    return LoadedModel(processor=processor, model=model, device=device)


def get_alignment_model() -> LoadedModel:
    global _alignment
    with _lock:
        if _alignment is None:
            _alignment = _load(ALIGNMENT_MODEL)
    return _alignment


def get_quran_model() -> LoadedModel:
    global _quran
    with _lock:
        if _quran is None:
            _quran = _load(QURAN_MODEL)
    return _quran


def emissions(runtime: LoadedModel, audio: np.ndarray, sample_rate: int = 16000) -> np.ndarray:
    torch, _, _ = _imports()
    processor = runtime.processor
    model = runtime.model
    inputs = processor(audio, sampling_rate=sample_rate, return_tensors="pt", padding=True)
    model_inputs: dict[str, Any] = {"input_values": inputs.input_values.to(runtime.device)}
    attention_mask = getattr(inputs, "attention_mask", None)
    if attention_mask is not None:
        model_inputs["attention_mask"] = attention_mask.to(runtime.device)
    with torch.inference_mode():
        logits = model(**model_inputs).logits[0]
        log_probs = torch.log_softmax(logits.float(), dim=-1).cpu().numpy()
    return log_probs
