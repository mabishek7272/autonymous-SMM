"""Text-to-speech providers.

  google : Google Cloud Text-to-Speech REST (ta-IN / en-IN), LINEAR16
  mms    : local facebook/mms-tts-tam + mms-tts-eng (VITS). CC-BY-NC: non-commercial only.
  none   : text-only calls (no audio)

NOT supported, deliberately: VibeVoice (English-only, research-only licence, telephone use restricted),
macOS `say`, generated tones. A provider failure raises TtsError; the call continues text-only.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import threading
from dataclasses import dataclass
from typing import Optional

import httpx
import numpy as np

from .audio import float_to_pcm16, resample, resample_pcm16, wav_to_pcm
from .config import Config

logger = logging.getLogger("call_agent.tts")


class TtsError(Exception):
    """Synthesis failed."""


def detect_language(text: str) -> str:
    """'ta' if the sentence contains Tamil script (U+0B80-U+0BFF), else 'en'."""
    return "ta" if any("஀" <= ch <= "௿" for ch in text) else "en"


@dataclass
class TtsAudio:
    pcm: bytes  # int16 LE mono
    sample_rate: int


class TtsProvider:
    name = "none"
    enabled = False
    status = "disabled"

    def __init__(self, target_rate: int = 24000):
        self.target_rate = target_rate

    async def synthesize(self, text: str) -> TtsAudio:  # pragma: no cover - interface
        raise TtsError("TTS is not configured (TTS_PROVIDER=none)")

    async def aclose(self) -> None:
        return None


class NoTts(TtsProvider):
    pass


class GoogleTts(TtsProvider):
    name = "google"
    enabled = True
    URL = "https://texttospeech.googleapis.com/v1/text:synthesize"

    def __init__(self, config: Config, client: Optional[httpx.AsyncClient] = None):
        super().__init__(config.tts_sample_rate)
        self._key = config.google_tts_api_key
        self._voices = {"ta": ("ta-IN", config.google_tts_voice_ta), "en": ("en-IN", config.google_tts_voice_en)}
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0))
        self._owns = client is None
        self.status = "configured"

    async def aclose(self) -> None:
        if self._owns:
            await self._client.aclose()

    async def synthesize(self, text: str) -> TtsAudio:
        lang_code, voice = self._voices[detect_language(text)]
        body = {
            "input": {"text": text},
            "voice": {"languageCode": lang_code, "name": voice},
            "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": self.target_rate},
        }
        try:
            resp = await self._client.post(self.URL, json=body, headers={"X-Goog-Api-Key": self._key})
        except httpx.HTTPError as exc:
            self.status = f"error: {exc.__class__.__name__}"
            raise TtsError(f"Google TTS unreachable: {exc.__class__.__name__}: {exc}") from exc
        if resp.status_code >= 400:
            self.status = f"error: HTTP {resp.status_code}"
            raise TtsError(f"Google TTS HTTP {resp.status_code}: {resp.text[:200]}")
        try:
            wav = base64.b64decode(resp.json()["audioContent"])
            pcm, rate = wav_to_pcm(wav)  # Google returns a WAV with header for LINEAR16
        except Exception as exc:
            raise TtsError(f"Google TTS returned unusable audio: {exc}") from exc
        self.status = "ready"
        return TtsAudio(resample_pcm16(pcm, rate, self.target_rate), self.target_rate)


class MmsTts(TtsProvider):
    """Local MMS-TTS (Meta). Weights are CC-BY-NC 4.0: do not use for commercial calls."""

    name = "mms"
    enabled = True
    MODELS = {"ta": "facebook/mms-tts-tam", "en": "facebook/mms-tts-eng"}

    def __init__(self, config: Config):
        super().__init__(config.tts_sample_rate)
        self._models: dict[str, tuple] = {}
        self._lock = threading.Lock()
        self.status = "not_loaded"
        logger.warning(
            "TTS_PROVIDER=mms: MMS-TTS weights are licensed CC-BY-NC 4.0 (non-commercial). "
            "Do not use for production admissions calls without a commercial licence."
        )

    def _load(self, lang: str):
        with self._lock:
            if lang in self._models:
                return self._models[lang]
            try:
                from transformers import AutoTokenizer, VitsModel

                tok = AutoTokenizer.from_pretrained(self.MODELS[lang])
                model = VitsModel.from_pretrained(self.MODELS[lang]).eval()
            except Exception as exc:
                self.status = f"error: {exc.__class__.__name__}"
                raise TtsError(f"could not load {self.MODELS[lang]}: {exc}") from exc
            self._models[lang] = (tok, model)
            self.status = "ready"
            return self._models[lang]

    def _synth_sync(self, text: str) -> TtsAudio:
        import torch

        tok, model = self._load(detect_language(text))
        try:
            inputs = tok(text, return_tensors="pt")
            with torch.inference_mode():
                wave = model(**inputs).waveform[0].cpu().numpy()
        except Exception as exc:
            raise TtsError(f"MMS synthesis failed: {exc}") from exc
        x = resample(wave.astype(np.float32), model.config.sampling_rate, self.target_rate)
        return TtsAudio(float_to_pcm16(x), self.target_rate)

    async def synthesize(self, text: str) -> TtsAudio:
        return await asyncio.get_running_loop().run_in_executor(None, self._synth_sync, text)


def build_tts(config: Config, client: Optional[httpx.AsyncClient] = None) -> TtsProvider:
    if config.tts_provider == "google":
        return GoogleTts(config, client)
    if config.tts_provider == "mms":
        return MmsTts(config)
    return NoTts(config.tts_sample_rate)
