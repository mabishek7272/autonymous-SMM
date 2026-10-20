"""Speech-to-text: local fine-tuned Whisper (Tamil) via transformers 5.x.

Failures raise SttError. This module never returns canned or placeholder text.
"""

from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Optional

import numpy as np

from .audio import pcm16_to_float, rms

logger = logging.getLogger("call_agent.stt")

SAMPLE_RATE = 16000
CHUNK_SECONDS = 30
_SPECIAL = re.compile(r"<\|[^|>]*\|>|<[a-z_]{2,20}/>")  # also non-speech tags such as <music/>; this checkpoint's tokenizer leaves e.g. <|notimestamps|> unflagged
MIN_RMS = 0.002  # below this the clip is digital silence; Whisper would hallucinate text


class SttError(Exception):
    """Transcription or model loading failed."""


@dataclass
class SttResult:
    text: str
    language: str  # 'ta' or 'en'
    duration_s: float
    latency_s: float


def split_chunks(x: np.ndarray, sr: int = SAMPLE_RATE, max_s: int = CHUNK_SECONDS) -> list[np.ndarray]:
    """Split long audio into <= max_s windows, cutting at the quietest 100ms near the end of each window."""
    max_n = max_s * sr
    if x.size <= max_n:
        return [x]
    chunks: list[np.ndarray] = []
    pos = 0
    win = sr // 10
    while x.size - pos > max_n:
        lo, hi = pos + int(max_n * 0.8), pos + max_n
        seg = x[lo:hi]
        n = (seg.size // win) * win
        energies = np.square(seg[:n]).reshape(-1, win).mean(axis=1)
        cut = lo + int(np.argmin(energies)) * win + win // 2
        chunks.append(x[pos:cut])
        pos = cut
    chunks.append(x[pos:])
    return [c for c in chunks if c.size]


class WhisperStt:
    LANGS = ("ta", "en")

    def __init__(self, model_path: str, language: str = "auto", device: str = "cpu"):
        self.model_path = model_path
        self.language = language
        self.device_name = device
        self.status = "not_loaded"  # 'not_loaded' | 'ready' | 'error: ...'
        self._model = None
        self._processor = None
        self._lang_ids: dict[str, int] = {}
        self._load_lock = threading.Lock()
        self._infer_lock = threading.Lock()

    # --- loading --------------------------------------------------------------
    def load(self) -> None:
        with self._load_lock:
            if self._model is not None:
                return
            try:
                import torch
                from transformers import WhisperForConditionalGeneration, WhisperProcessor

                device = self.device_name
                if device == "mps" and not torch.backends.mps.is_available():
                    raise SttError("STT_DEVICE=mps requested but MPS is not available")
                if device == "cuda" and not torch.cuda.is_available():
                    raise SttError("STT_DEVICE=cuda requested but CUDA is not available")
                t0 = time.perf_counter()
                processor = WhisperProcessor.from_pretrained(self.model_path)
                model = WhisperForConditionalGeneration.from_pretrained(self.model_path)
                model.to(device).eval()
                self._lang_ids = {
                    code: processor.tokenizer.convert_tokens_to_ids(f"<|{code}|>") for code in self.LANGS
                }
                if any(i is None or i == processor.tokenizer.unk_token_id for i in self._lang_ids.values()):
                    raise SttError("Whisper tokenizer lacks <|ta|>/<|en|> language tokens")
                self._patch_generation_config(model, processor.tokenizer)
                self._processor, self._model = processor, model
                self.status = "ready"
                logger.info("Whisper loaded from %s on %s in %.1fs", self.model_path, device, time.perf_counter() - t0)
            except SttError as exc:
                self.status = f"error: {exc}"
                raise
            except Exception as exc:
                self.status = f"error: {exc.__class__.__name__}: {exc}"
                logger.exception("failed to load Whisper")
                raise SttError(f"could not load Whisper model at {self.model_path}: {exc}") from exc

    @staticmethod
    def _patch_generation_config(model, tokenizer) -> None:
        """The checkpoint ships a pre-4.37 generation_config without lang/task maps, which
        generate(language=..., task=...) requires. Patch it in memory (weights dir untouched)."""
        from transformers.models.whisper.tokenization_whisper import LANGUAGES

        gc = model.generation_config
        if getattr(gc, "lang_to_id", None) and getattr(gc, "task_to_id", None):
            return
        gc.lang_to_id = {f"<|{c}|>": tokenizer.convert_tokens_to_ids(f"<|{c}|>") for c in LANGUAGES}
        gc.task_to_id = {t: tokenizer.convert_tokens_to_ids(f"<|{t}|>") for t in ("transcribe", "translate")}
        gc.is_multilingual = True

    # --- inference ------------------------------------------------------------
    def _features(self, audio: np.ndarray):
        feats = self._processor.feature_extractor(audio, sampling_rate=SAMPLE_RATE, return_tensors="pt")
        return feats.input_features.to(self._model.device)

    def _detect_language(self, input_features) -> str:
        """Choose ta vs en by comparing the language-token logits at the first decoder step."""
        import torch

        start = self._model.generation_config.decoder_start_token_id
        ids = torch.tensor([[start]], device=self._model.device)
        with torch.inference_mode():
            logits = self._model(input_features=input_features, decoder_input_ids=ids).logits[0, -1]
        scores = {code: float(logits[tok]) for code, tok in self._lang_ids.items()}
        return max(scores, key=scores.get)

    def transcribe_sync(self, pcm: bytes) -> SttResult:
        import torch

        if len(pcm) % 2:
            raise SttError("audio must be int16 PCM (odd byte length)")
        self.load()
        audio = pcm16_to_float(pcm)
        duration = audio.size / SAMPLE_RATE
        t0 = time.perf_counter()
        if audio.size < SAMPLE_RATE // 10 or rms(audio) < MIN_RMS:
            return SttResult("", self.language if self.language != "auto" else "ta", duration, 0.0)
        try:
            with self._infer_lock:
                parts: list[str] = []
                lang = self.language
                for i, chunk in enumerate(split_chunks(audio)):
                    feats = self._features(chunk)
                    if lang == "auto":
                        lang = self._detect_language(feats)  # decided on the first chunk, reused for the rest
                    with torch.inference_mode():
                        out = self._model.generate(
                            input_features=feats, language=lang, task="transcribe", max_new_tokens=220
                        )
                    parts.append(_SPECIAL.sub("", self._processor.batch_decode(out, skip_special_tokens=True)[0]).strip())
        except SttError:
            raise
        except Exception as exc:
            logger.exception("transcription failed")
            raise SttError(f"transcription failed: {exc.__class__.__name__}: {exc}") from exc
        text = " ".join(p for p in parts if p).strip()
        return SttResult(text, lang, duration, time.perf_counter() - t0)

    async def transcribe(self, pcm: bytes) -> SttResult:
        """Run inference in a worker thread so the event loop stays responsive."""
        return await asyncio.get_running_loop().run_in_executor(None, self.transcribe_sync, pcm)
