"""Shared service container (built once per process, used by REST, WS, Twilio and CLI)."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Optional

from . import __version__
from .brain import Brain
from .call_session import CallSession, SessionDeps
from .config import Config
from .llm import LlmClient
from .node_client import NodeClient
from .persona import PersonaProvider
from .stt import WhisperStt
from .tts import TtsProvider, build_tts
from .vad import VoiceActivityDetector

logger = logging.getLogger("call_agent.services")


class Services:
    def __init__(self, config: Config, *, node=None, persona=None, llm=None, stt=None, tts: Optional[TtsProvider] = None):
        self.config = config
        self.node = node or NodeClient(config)
        self.persona = persona or PersonaProvider(self.node)
        self.llm = llm or LlmClient(config)
        self.stt = stt or WhisperStt(config.whisper_model_path, config.stt_language, config.stt_device)
        self.tts = tts or build_tts(config)
        self._health_cache: tuple[float, dict] = (0.0, {})
        self._flush_task: Optional[asyncio.Task] = None

    def brain_factory(self, call_id, lead_id, caller_context, persona) -> Brain:
        return Brain(self.llm, self.node, persona, call_id, lead_id, caller_context)

    def vad_factory(self) -> VoiceActivityDetector:
        return VoiceActivityDetector(
            energy_threshold=self.config.vad_energy_threshold, silence_ms=self.config.vad_silence_ms
        )

    def session_deps(self) -> SessionDeps:
        return SessionDeps(
            config=self.config,
            node=self.node,
            persona=self.persona,
            stt=self.stt,
            tts=self.tts,
            brain_factory=self.brain_factory,
            vad_factory=self.vad_factory,
        )

    def new_session(self, send_json, send_audio, **kw) -> CallSession:
        return CallSession(self.session_deps(), send_json, send_audio, **kw)

    async def health(self, detailed: bool = False) -> dict:
        ts, cached = self._health_cache
        if time.monotonic() - ts > 10 or not cached:
            llm_ok, node = await asyncio.gather(self.llm.probe(), self.node.ping())
            cached = {"llm": llm_ok, "node": node}
            self._health_cache = (time.monotonic(), cached)
        node = cached["node"]
        tts_state = {"provider": self.tts.name, "ready": bool(self.tts.enabled)}
        out: dict[str, Any] = {
            "status": "ok" if cached["llm"] and node["reachable"] and not str(self.stt.status).startswith("error") else "degraded",
            "stt": self.stt.status,
            "llm": cached["llm"],
            "tts": tts_state,
            "node": node["reachable"],
            "version": __version__,
        }
        if detailed:
            out["details"] = {
                "llmProvider": self.config.llm_provider,
                "llmModel": self.llm.model,
                "sttModelPath": self.config.whisper_model_path,
                "sttLanguage": self.config.stt_language,
                "ttsStatus": self.tts.status,
                "node": node,
                "spoolPending": self.node.spool_pending(),
                "twilioStream": self.config.twilio_stream_enabled,
                "maxCallSeconds": self.config.max_call_seconds,
            }
        return out

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(60)
            try:
                await self.node.flush_spool()
            except Exception:
                logger.exception("spool flush failed")

    async def start_background(self) -> None:
        try:
            await self.node.flush_spool()
        except Exception:
            logger.exception("initial spool flush failed")
        self._flush_task = asyncio.create_task(self._flush_loop())

    async def aclose(self) -> None:
        if self._flush_task:
            self._flush_task.cancel()
        await self.node.aclose()
        await self.llm.aclose()
        await self.tts.aclose()
