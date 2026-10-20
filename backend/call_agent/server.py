"""FastAPI app: /health, POST /api/call/chat, WS /ws/call, optional WS /ws/twilio.

Run from backend/:  python3 -m uvicorn call_agent.server:app --port 8085
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import __version__
from .audio import wav_bytes
from .auth import is_authorized
from .brain import ToolFailure
from .config import Config, ConfigError, load_config
from .llm import LlmError
from .persona import PersonaUnavailable
from .services import Services
from .telephony_twilio import build_router as build_twilio_router
from .tts import TtsError, detect_language

logger = logging.getLogger("call_agent.server")

CHAT_BRAIN_TTL = 1800
CHAT_BRAIN_MAX = 100


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    callId: Optional[str] = Field(default=None, max_length=64)


def create_app(services: Optional[Services] = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        svc = services
        if svc is None:
            logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
            try:
                cfg = load_config()
            except ConfigError as exc:
                logger.error("%s", exc)
                raise
            svc = Services(cfg)
        app.state.services = svc
        app.state.chat_brains = {}
        app.state.chat_locks = {}
        await svc.start_background()
        report = await svc.health(detailed=True)
        logger.info("call agent %s startup readiness: %s", __version__, json.dumps(report))
        try:
            yield
        finally:
            await svc.aclose()

    app = FastAPI(title="E-Kalavya Call Agent", version=__version__, lifespan=lifespan)

    # CORS is read from the environment at import time so the middleware can be installed;
    # origins are an explicit allow-list (no '*' with credentials).
    from .config import from_env

    try:
        origins = from_env().cors_origins if services is None else services.config.cors_origins
    except ConfigError:
        origins = []
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=False,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type"],
        )

    def get_services(request: Request) -> Services:
        return request.app.state.services

    def require_auth(request: Request, svc: Services = Depends(get_services)) -> Services:
        if not is_authorized(svc.config.api_key, request.headers, request.query_params.get("token")):
            raise HTTPException(status_code=401, detail="invalid or missing API key", headers={"WWW-Authenticate": "Bearer"})
        return svc

    @app.get("/health")
    async def health(request: Request, svc: Services = Depends(get_services)):
        authed = is_authorized(svc.config.api_key, request.headers, request.query_params.get("token"))
        out = await svc.health(detailed=authed)
        if not authed:
            out = {k: out[k] for k in ("status", "stt", "llm", "tts", "version")}
            if str(out["stt"]).startswith("error"):
                out["stt"] = "error"  # details (paths, exceptions) only for authenticated callers
        return out

    @app.post("/api/call/chat")
    async def chat(body: ChatRequest, request: Request, svc: Services = Depends(require_auth)):
        brains: dict = request.app.state.chat_brains
        now = time.monotonic()
        for k in [k for k, (_, t) in brains.items() if now - t > CHAT_BRAIN_TTL]:
            brains.pop(k, None)
            request.app.state.chat_locks.pop(k, None)
        call_id = body.callId or f"chat-{uuid.uuid4().hex[:12]}"
        entry = brains.get(call_id)
        try:
            persona = await svc.persona.get()
        except PersonaUnavailable as exc:
            raise HTTPException(status_code=503, detail=f"persona unavailable: {exc}")
        if entry is None:
            if len(brains) >= CHAT_BRAIN_MAX:
                raise HTTPException(status_code=429, detail="too many concurrent chat sessions")
            brain = svc.brain_factory(call_id, None, None, persona)
        else:
            brain = entry[0]
        language = detect_language(body.message)
        sentences: list[str] = []
        locks: dict = request.app.state.chat_locks
        lock = locks.setdefault(call_id, asyncio.Lock())
        try:
            async with lock:
                async for s in brain.reply(body.message, language):
                    sentences.append(s)
        except LlmError as exc:
            raise HTTPException(status_code=503, detail=f"llm failed: {exc}")
        except ToolFailure as exc:
            raise HTTPException(status_code=503, detail=f"tool failed: {exc}")
        brains[call_id] = (brain, time.monotonic())
        out: dict = {"callId": call_id, "text": " ".join(sentences), "tts": svc.tts.enabled}
        if svc.tts.enabled and sentences:
            try:
                parts = [(await svc.tts.synthesize(s)) for s in sentences]
                pcm = b"".join(p.pcm for p in parts)
                rate = parts[0].sample_rate
                out["audio_base64"] = base64.b64encode(wav_bytes(pcm, rate)).decode()
                out["sampleRate"] = rate
            except TtsError as exc:
                out["tts_error"] = str(exc)
        return out

    @app.websocket("/ws/call")
    async def ws_call(ws: WebSocket):
        svc: Services = ws.app.state.services
        if not is_authorized(svc.config.api_key, ws.headers, ws.query_params.get("token")):
            await ws.close(code=4401)
            return
        origin = ws.headers.get("origin")
        if origin and svc.config.cors_origins and "*" not in svc.config.cors_origins and origin not in svc.config.cors_origins:
            await ws.close(code=4403)
            return
        await ws.accept()
        lock = asyncio.Lock()

        async def send_json(msg: dict) -> None:
            async with lock:
                await ws.send_text(json.dumps(msg, ensure_ascii=False))

        async def send_audio(pcm: bytes) -> None:
            async with lock:
                await ws.send_bytes(pcm)

        session = svc.new_session(send_json, send_audio)
        reason = "disconnect"

        async def close_when_done() -> None:  # call limit reached / session ended server-side
            await session.closed.wait()
            with contextlib.suppress(Exception):
                await ws.close()

        closer = asyncio.create_task(close_when_done())
        try:
            while True:
                try:
                    msg = await ws.receive()
                except RuntimeError:
                    break
                if msg["type"] == "websocket.disconnect":
                    break
                if msg.get("bytes") is not None:
                    await session.handle_audio(msg["bytes"])
                    continue
                try:
                    data = json.loads(msg.get("text") or "")
                    kind = data["type"]
                except (ValueError, KeyError, TypeError):
                    await send_json({"type": "error", "code": "bad_message", "message": "expected a JSON object with a 'type'"})
                    continue
                if kind == "start_call":
                    if not await session.start(data):
                        break
                elif kind == "text_input":
                    await session.handle_text(str(data.get("text", "")))
                elif kind == "interrupt":
                    await session.interrupt("client")
                elif kind == "end_call":
                    reason = "client_end"
                    break
                else:
                    await send_json({"type": "error", "code": "unknown_type", "message": f"unknown message type '{kind}'"})
        except Exception:
            logger.exception("websocket handler failed (callId=%s)", session.call_id)
        finally:
            closer.cancel()
            await session.end(reason)
            with contextlib.suppress(Exception):
                await ws.close()

    app.include_router(build_twilio_router())
    return app


app = create_app()
