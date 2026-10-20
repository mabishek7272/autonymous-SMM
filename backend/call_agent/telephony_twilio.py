"""Twilio Media Streams adapter (WS /ws/twilio), enabled with TWILIO_STREAM_ENABLED=true.

Twilio sends 8 kHz mu-law in base64; the call session works in 16 kHz int16 PCM in and the
announced TTS rate out. Conversion is done in numpy (audioop is gone in Python 3.13).

Compliance: calls are AI-disclosed by the persona greeting (served by Node); recording/
transcription consent wording is part of that greeting.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .audio import mulaw_decode, mulaw_encode, resample_pcm16

logger = logging.getLogger("call_agent.twilio")

FRAME_BYTES = 160  # 20 ms of 8 kHz mu-law


@dataclass
class TwilioEvent:
    event: str
    stream_sid: str = ""
    call_sid: str = ""
    payload: bytes = b""
    custom: Optional[dict] = None
    mark: str = ""


def parse_message(raw: str) -> TwilioEvent:
    """Parse one Twilio Media Streams JSON frame. Raises ValueError on malformed input."""
    try:
        m = json.loads(raw)
    except ValueError as exc:
        raise ValueError("invalid JSON") from exc
    if not isinstance(m, dict) or "event" not in m:
        raise ValueError("missing event")
    ev = m["event"]
    sid = m.get("streamSid") or (m.get("start") or {}).get("streamSid") or ""
    if ev == "start":
        s = m.get("start") or {}
        return TwilioEvent("start", sid, s.get("callSid", ""), custom=s.get("customParameters") or {})
    if ev == "media":
        try:
            data = base64.b64decode((m.get("media") or {}).get("payload", ""), validate=True)
        except Exception as exc:
            raise ValueError("bad media payload") from exc
        return TwilioEvent("media", sid, payload=data)
    if ev == "mark":
        return TwilioEvent("mark", sid, mark=(m.get("mark") or {}).get("name", ""))
    return TwilioEvent(ev, sid)


def mulaw8k_to_pcm16k(data: bytes) -> bytes:
    return resample_pcm16(mulaw_decode(data), 8000, 16000)


def pcm_to_mulaw_frames(pcm: bytes, src_rate: int) -> list[bytes]:
    """int16 PCM at src_rate -> list of 20 ms (160 byte) mu-law frames at 8 kHz."""
    mu = mulaw_encode(resample_pcm16(pcm, src_rate, 8000))
    return [mu[i : i + FRAME_BYTES] for i in range(0, len(mu), FRAME_BYTES)]


def compute_signature(url: str, auth_token: str, params: Optional[dict] = None) -> str:
    data = url + "".join(f"{k}{v}" for k, v in sorted((params or {}).items()))
    digest = hmac.new(auth_token.encode(), data.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def validate_signature(url: str, signature: Optional[str], auth_token: str, params: Optional[dict] = None) -> bool:
    if not signature or not auth_token or not url:
        return False
    candidates = {url}
    parts = urlsplit(url)
    for scheme in ("wss", "https", "ws", "http"):
        candidates.add(urlunsplit((scheme, parts.netloc, parts.path, parts.query, "")))
    return any(hmac.compare_digest(compute_signature(u, auth_token, params), signature) for u in candidates)


def build_router() -> APIRouter:
    router = APIRouter()

    @router.websocket("/ws/twilio")
    async def twilio_ws(ws: WebSocket):
        services = ws.app.state.services
        cfg = services.config
        if not cfg.twilio_stream_enabled:
            await ws.close(code=4404)
            return
        url = cfg.twilio_stream_url
        if not url or not validate_signature(url, ws.headers.get("x-twilio-signature"), cfg.twilio_auth_token):
            logger.warning("rejected Twilio stream: bad or missing signature (is TWILIO_STREAM_URL set to the public wss URL?)")
            await ws.close(code=4401)
            return
        await ws.accept()
        state = {"sid": ""}
        send_lock = asyncio.Lock()

        async def send_json(msg: dict) -> None:
            if msg.get("type") == "interrupted" and state["sid"]:
                async with send_lock:
                    await ws.send_text(json.dumps({"event": "clear", "streamSid": state["sid"]}))
            elif msg.get("type") == "error":
                logger.warning("session error: %s", msg)

        async def send_audio(pcm: bytes) -> None:
            if not state["sid"]:
                return
            async with send_lock:
                for fr in pcm_to_mulaw_frames(pcm, session.sample_rate):
                    await ws.send_text(json.dumps({
                        "event": "media",
                        "streamSid": state["sid"],
                        "media": {"payload": base64.b64encode(fr).decode()},
                    }))
                await ws.send_text(json.dumps({"event": "mark", "streamSid": state["sid"], "mark": {"name": "tts"}}))

        session = services.new_session(send_json, send_audio)
        reason = "disconnect"

        async def close_when_done() -> None:
            await session.closed.wait()
            try:
                await ws.close()
            except Exception:
                pass

        closer = asyncio.create_task(close_when_done())
        try:
            while True:
                try:
                    raw = await ws.receive_text()
                except (WebSocketDisconnect, RuntimeError):
                    break
                try:
                    ev = parse_message(raw)
                except ValueError as exc:
                    logger.warning("bad Twilio frame: %s", exc)
                    continue
                if ev.event == "start":
                    state["sid"] = ev.stream_sid
                    caller = (ev.custom or {}).get("from")
                    ok = await session.start({"callerPhone": caller})
                    if not ok:
                        break
                elif ev.event == "media":
                    await session.handle_audio(mulaw8k_to_pcm16k(ev.payload))
                elif ev.event == "stop":
                    reason = "client_end"
                    break
                # 'mark' / 'connected' / 'dtmf' need no action
        finally:
            closer.cancel()
            await session.end(reason)
            try:
                await ws.close()
            except Exception:
                pass

    return router
