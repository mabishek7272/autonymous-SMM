"""Local CLI: talk to the real call pipeline from a terminal.

  cd backend && python3 -m call_agent.cli_call            # mic + speaker if sounddevice is present
  cd backend && python3 -m call_agent.cli_call --text     # type instead of speaking

Uses the same CallSession as the server over an in-process transport. Needs the same
environment as the server (see .env.example); Node must be running for persona and tools.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from .config import ConfigError, load_config
from .services import Services

try:  # optional
    import numpy as np
    import sounddevice as sd
except Exception:  # pragma: no cover - depends on host audio libs
    sd = None


async def run(text_only: bool, phone: str | None) -> int:
    try:
        cfg = load_config()
    except ConfigError as exc:
        print(exc, file=sys.stderr)
        return 2
    svc = Services(cfg)
    loop = asyncio.get_running_loop()
    use_audio = sd is not None and not text_only
    out_stream = None
    state = {"rate": cfg.tts_sample_rate}

    async def send_json(msg: dict) -> None:
        t = msg.get("type")
        if t == "call_started":
            state["rate"] = msg["sampleRate"]
            print(f"[call {msg['callId']}] AGENT: {msg['greeting']}  (tts={msg['tts']})")
        elif t == "user_speech":
            print(f"YOU: {msg['text']}")
        elif t == "assistant_sentence":
            print(f"AGENT: {msg['text']}")
        elif t == "interrupted" and out_stream is not None:
            out_stream.abort()
            out_stream.start()
        elif t == "error":
            print(f"[error {msg['code']}] {msg['message']}", file=sys.stderr)
        elif t == "call_ended":
            print(f"[call ended] {msg['summary']} (log: {msg['logged']})")
        elif t == "state_change":
            print(f"  ({msg['state']})")

    async def send_audio(pcm: bytes) -> None:
        if out_stream is not None:
            await loop.run_in_executor(None, out_stream.write, np.frombuffer(pcm, dtype="<i2"))

    session = svc.new_session(send_json, send_audio)
    await svc.start_background()
    try:
        if use_audio:
            out_stream = sd.OutputStream(samplerate=cfg.tts_sample_rate, channels=1, dtype="int16")
            out_stream.start()
        else:
            print("(text-only mode: no sounddevice or --text given)")
        if not await session.start({"callerPhone": phone} if phone else {}):
            return 1
        mic = None
        if use_audio:
            def on_audio(indata, frames, t, status):
                loop.call_soon_threadsafe(lambda b=bytes(indata): asyncio.ensure_future(session.handle_audio(b)))

            mic = sd.RawInputStream(samplerate=16000, channels=1, dtype="int16", blocksize=320, callback=on_audio)
            mic.start()
            print("Speak. Ctrl+C to hang up.")
            try:
                await session.closed.wait()
            except asyncio.CancelledError:
                pass
            mic.stop()
        else:
            print("Type a message, /interrupt, or /quit.")
            while not session.closed.is_set():
                line = await loop.run_in_executor(None, sys.stdin.readline)
                if not line or line.strip() == "/quit":
                    break
                if line.strip() == "/interrupt":
                    await session.interrupt("cli")
                else:
                    await session.handle_text(line)
    except KeyboardInterrupt:
        pass
    finally:
        await session.end("client_end")
        if out_stream is not None:
            out_stream.stop()
        await svc.aclose()
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--text", action="store_true", help="text-only (no mic/speaker)")
    ap.add_argument("--phone", help="caller phone to identify against Node")
    args = ap.parse_args()
    try:
        sys.exit(asyncio.run(run(args.text, args.phone)))
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
