"""One CallSession per call: its own Brain, VAD, state machine and tasks.

The transport (WebSocket, Twilio, CLI) supplies two coroutines, send_json and send_audio,
and feeds the session with handle_audio / handle_text / interrupt / end.
"""

from __future__ import annotations

import asyncio
import contextlib
import enum
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

from .audio import resample_pcm16
from .brain import ToolFailure
from .config import Config
from .llm import LlmError
from .node_client import NodeClient, NodeError
from .persona import PersonaProvider, PersonaUnavailable
from .stt import SttError
from .tts import TtsError, detect_language
from .vad import VoiceActivityDetector

logger = logging.getLogger("call_agent.session")

AUDIO_CHUNK_BYTES = 9600  # 200 ms at 24 kHz int16
MAX_TEXT_CHARS = 2000


class State(str, enum.Enum):
    IDLE = "IDLE"
    LISTENING = "LISTENING"
    THINKING = "THINKING"
    SPEAKING = "SPEAKING"


@dataclass
class SessionDeps:
    config: Config
    node: NodeClient
    persona: PersonaProvider
    stt: Any  # async transcribe(pcm) -> SttResult
    tts: Any  # .enabled, async synthesize(text) -> TtsAudio
    brain_factory: Callable[..., Any]  # (call_id, lead_id, caller_context, persona) -> Brain
    vad_factory: Callable[[], VoiceActivityDetector] = VoiceActivityDetector


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class CallSession:
    def __init__(
        self,
        deps: SessionDeps,
        send_json: Callable[[dict], Awaitable[None]],
        send_audio: Callable[[bytes], Awaitable[None]],
        *,
        call_id: Optional[str] = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.deps = deps
        self._send_json = send_json
        self._send_audio = send_audio
        self.call_id = call_id or uuid.uuid4().hex
        self._clock = clock
        self.state = State.IDLE
        self.turn = 0
        self.sample_rate = deps.config.tts_sample_rate
        self.vad = deps.vad_factory()
        self.brain: Any = None
        self.transcript: list[dict] = []
        self.caller_phone: Optional[str] = None
        self.lead_id: Optional[str] = None
        self.language: Optional[str] = None
        self.closed = asyncio.Event()
        self._task: Optional[asyncio.Task] = None
        self._watchdog: Optional[asyncio.Task] = None
        self._ended = False
        self._end_result: Optional[dict] = None
        self._playback_end = 0.0
        self._uncommitted_audio: Optional[bytes] = None
        self._tts_error_turn = -1
        self._bad_frames = 0
        self._started_wall = 0.0
        self._started_mono = 0.0
        self.log = logging.LoggerAdapter(logger, {"callId": self.call_id})

    # --- helpers --------------------------------------------------------------------
    @property
    def tts_on(self) -> bool:
        return bool(getattr(self.deps.tts, "enabled", False))

    @property
    def agent_speaking(self) -> bool:
        return self.state == State.SPEAKING or self._clock() < self._playback_end

    async def _emit(self, msg: dict) -> None:
        try:
            await self._send_json(msg)
        except Exception as exc:  # transport gone; the receive loop will notice and end the call
            self.log.debug("send_json failed: %s", exc)

    async def _error(self, code: str, message: str) -> None:
        self.log.warning("error %s: %s", code, message)
        await self._emit({"type": "error", "code": code, "message": message})

    async def _set_state(self, s: State) -> None:
        if s != self.state:
            self.state = s
            await self._emit({"type": "state_change", "state": s.value})

    def _add_transcript(self, role: str, text: str) -> None:
        self.transcript.append({"role": role, "text": text, "ts": _iso(time.time())})

    async def _cancel_task(self) -> None:
        task, self._task = self._task, None
        if task and not task.done() and task is not asyncio.current_task():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    async def _begin_turn(self) -> int:
        """Every new user turn (and every interrupt) bumps the turn id and cancels in-flight work."""
        self.turn += 1
        await self._cancel_task()
        return self.turn

    def _spawn(self, coro) -> None:
        self._task = asyncio.create_task(coro)

    # --- lifecycle ------------------------------------------------------------------
    async def start(self, msg: Optional[dict] = None) -> bool:
        msg = msg or {}
        if self.state != State.IDLE or self._ended:
            await self._error("already_started", "start_call was already received")
            return False
        phone = msg.get("callerPhone")
        self.caller_phone = phone.strip()[:40] if isinstance(phone, str) and phone.strip() else None
        lead = msg.get("leadId")
        self.lead_id = None
        if lead:
            try:
                self.lead_id = str(uuid.UUID(str(lead)))
            except ValueError:
                await self._error("bad_lead_id", "leadId must be a UUID; continuing without it")
        self._started_wall, self._started_mono = time.time(), self._clock()
        try:
            persona = await self.deps.persona.get()
        except PersonaUnavailable as exc:
            await self._error("persona_unavailable", f"cannot start call: {exc}")
            self._ended = True
            self.closed.set()
            return False
        context = None
        if self.caller_phone:
            try:
                context = await self.deps.node.identify(self.caller_phone)
            except NodeError as exc:
                self.log.warning("caller lookup failed: %s", exc)
        if context and not self.lead_id:
            self.lead_id = ((context.get("lead") or {}).get("id")) or None
        self.brain = self.deps.brain_factory(self.call_id, self.lead_id, context, persona)
        self.brain.add_assistant(persona.greeting)
        self._add_transcript("agent", persona.greeting)
        await self._emit({
            "type": "call_started",
            "callId": self.call_id,
            "greeting": persona.greeting,
            "sampleRate": self.sample_rate,
            "tts": self.tts_on,
            "callerKnown": bool(context and (context.get("parent") or context.get("lead"))),
        })
        self._watchdog = asyncio.create_task(self._watch_duration())
        await self._set_state(State.LISTENING)
        turn = await self._begin_turn()
        self._spawn(self._speak_greeting(turn, persona.greeting))
        return True

    async def _watch_duration(self) -> None:
        await asyncio.sleep(self.deps.config.max_call_seconds)
        await self._error("max_call_duration", f"call limit of {self.deps.config.max_call_seconds}s reached")
        await self.end("timeout")

    async def _speak_greeting(self, turn: int, greeting: str) -> None:
        try:
            await self._set_state(State.SPEAKING)
            await self._speak(turn, greeting)
            await self._finish_playback(turn)
        finally:
            if turn == self.turn and not self._ended:
                await self._set_state(State.LISTENING)

    # --- inbound --------------------------------------------------------------------
    async def handle_audio(self, data: bytes) -> None:
        if self._ended or self.state == State.IDLE:
            return
        if len(data) % 2 or len(data) > self.deps.config.max_frame_bytes or not data:
            self._bad_frames += 1
            if self._bad_frames <= 5:
                await self._error(
                    "bad_frame",
                    f"binary frames must be non-empty int16 PCM (even length) of at most "
                    f"{self.deps.config.max_frame_bytes} bytes; got {len(data)}",
                )
            return
        for ev in self.vad.process(data, agent_speaking=self.agent_speaking):
            if ev.kind == "barge_in":
                await self.interrupt("barge_in")
            elif ev.kind == "utterance":
                audio = ev.audio
                if self._uncommitted_audio:  # previous utterance not yet transcribed: caller just kept talking
                    audio = self._uncommitted_audio + audio
                self._uncommitted_audio = audio
                turn = await self._begin_turn()
                self._spawn(self._run_utterance(turn, audio))

    async def handle_text(self, text: str) -> None:
        text = (text or "").strip()
        if self._ended or self.state == State.IDLE:
            await self._error("not_started", "send start_call first")
            return
        if not text:
            return
        text = text[:MAX_TEXT_CHARS]
        turn = await self._begin_turn()
        self._uncommitted_audio = None
        self.language = detect_language(text)
        self._add_transcript("caller", text)
        await self._emit({"type": "user_speech", "text": text})
        self._spawn(self._respond(turn, text))

    async def interrupt(self, reason: str = "client") -> None:
        if self._ended or self.state == State.IDLE:
            return
        await self._begin_turn()
        self._playback_end = self._clock()
        self.log.info("interrupted (%s), turn=%d", reason, self.turn)
        await self._emit({"type": "interrupted"})
        await self._set_state(State.LISTENING)

    # --- turn pipeline ----------------------------------------------------------------
    async def _run_utterance(self, turn: int, audio: bytes) -> None:
        try:
            await self._set_state(State.THINKING)
            await self._emit({"type": "transcribing"})
            try:
                res = await self.deps.stt.transcribe(audio)
            except SttError as exc:
                self._uncommitted_audio = None
                await self._error("stt_failed", str(exc))
                return
            self._uncommitted_audio = None
            if not res.text:
                return
            self.language = res.language
            self._add_transcript("caller", res.text)
            await self._emit({"type": "user_speech", "text": res.text})
            await self._respond(turn, res.text)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.log.exception("turn failed")
            await self._error("internal", f"{exc.__class__.__name__}: {exc}")
        finally:
            if turn == self.turn and not self._ended:
                await self._set_state(State.LISTENING)

    async def _respond(self, turn: int, text: str) -> None:
        try:
            await self._set_state(State.THINKING)
            async for sentence in self.brain.reply(text, self.language):
                if turn != self.turn:
                    return
                self._add_transcript("agent", sentence)
                await self._emit({"type": "assistant_sentence", "text": sentence})
                await self._set_state(State.SPEAKING)
                if self.tts_on:
                    await self._speak(turn, sentence)
            await self._finish_playback(turn)
        except asyncio.CancelledError:
            raise
        except LlmError as exc:
            await self._error("llm_failed", str(exc))
        except ToolFailure as exc:
            await self._error("tool_failed", str(exc))
        except Exception as exc:
            self.log.exception("response failed")
            await self._error("internal", f"{exc.__class__.__name__}: {exc}")
        finally:
            if turn == self.turn and not self._ended:
                await self._set_state(State.LISTENING)

    async def _speak(self, turn: int, sentence: str) -> None:
        if not self.tts_on:
            return
        try:
            audio = await self.deps.tts.synthesize(sentence)
        except TtsError as exc:
            if self._tts_error_turn != turn:  # once per turn; the call continues text-only
                self._tts_error_turn = turn
                await self._error("tts_failed", str(exc))
            return
        if turn != self.turn:
            return
        pcm = audio.pcm
        if audio.sample_rate != self.sample_rate:
            pcm = resample_pcm16(pcm, audio.sample_rate, self.sample_rate)
        for i in range(0, len(pcm), AUDIO_CHUNK_BYTES):
            if turn != self.turn:
                return
            await self._send_audio(pcm[i : i + AUDIO_CHUNK_BYTES])
        now = self._clock()
        self._playback_end = max(now, self._playback_end) + len(pcm) / 2 / self.sample_rate

    async def _finish_playback(self, turn: int) -> None:
        """Stay in SPEAKING until the audio we sent would have finished playing at the client."""
        remaining = self._playback_end - self._clock()
        if remaining > 0 and turn == self.turn:
            await asyncio.sleep(remaining)

    # --- end of call ------------------------------------------------------------------
    def derive_outcome(self, reason: str) -> str:
        results = list(getattr(self.brain, "tool_results", []) or [])
        ok = [r for r in results if r.ok]
        if any(r.name == "book_demo" for r in ok):
            return "demo_booked"
        for r in reversed(ok):
            if r.name == "update_lead_status":
                status = (r.args or {}).get("status")
                if status == "lost":
                    return "not_interested"
                if status == "follow_up":
                    return "callback_requested"
        if reason in ("disconnect", "timeout"):
            return "dropped"
        if any(t["role"] == "caller" for t in self.transcript):
            return "info_only"
        return "unknown"

    def build_summary(self, outcome: str, duration: int) -> str:
        callers = sum(1 for t in self.transcript if t["role"] == "caller")
        actions = [f"{r.name} {'ok' if r.ok else 'failed'}" for r in getattr(self.brain, "tool_results", []) or []]
        s = f"Automated voice call, {duration}s, {callers} caller turn(s). Outcome: {outcome}."
        if actions:
            s += " Actions: " + ", ".join(actions) + "."
        return s

    async def end(self, reason: str = "client_end") -> dict:
        if self._ended and self._end_result is not None:
            return self._end_result
        if not self._started_wall and not self._ended:  # socket closed before start_call: nothing to log
            self._ended = True
            self.closed.set()
            return {}
        if self._ended:  # start() failed before the call existed
            self.closed.set()
            return {}
        self._ended = True
        self.turn += 1
        current = asyncio.current_task()
        for t in (self._task, self._watchdog):
            if t and not t.done() and t is not current:
                t.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await t
        ended_mono = self._clock()
        duration = max(0, int(round(ended_mono - self._started_mono)))
        outcome = self.derive_outcome(reason)
        summary = self.build_summary(outcome, duration)
        payload: dict[str, Any] = {
            "callId": self.call_id,
            "startedAt": _iso(self._started_wall),
            "endedAt": _iso(self._started_wall + duration),
            "durationSec": duration,
            "transcript": [
                {"role": t["role"], "text": t["text"][:5000], "ts": t["ts"]} for t in self.transcript[-2000:]
            ],
            "outcome": outcome,
            "summary": summary,
        }
        if self.caller_phone:
            payload["phone"] = self.caller_phone
        if self.lead_id:
            payload["leadId"] = self.lead_id
        logged = await self.deps.node.post_call_log(payload)
        self._end_result = {
            "type": "call_ended",
            "summary": summary,
            "callId": self.call_id,
            "outcome": outcome,
            "durationSec": duration,
            "reason": reason,
            "logged": logged,
        }
        self.state = State.IDLE
        await self._emit(self._end_result)
        self.closed.set()
        return self._end_result
