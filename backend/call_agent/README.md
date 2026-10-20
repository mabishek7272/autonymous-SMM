# E-Kalavya call agent

Voice/text call service for the admissions desk. It is a separate Python process; all business
knowledge (persona wording, tools, lead data, bookings, call logs) lives in the Node backend and is
reached through the internal `/api/v1/agent-api` routes with an `X-Agent-Key` header. Nothing about
fees, slots or the persona is hard-coded here: if Node is unreachable, a call is refused with an
`error` event (`persona_unavailable`), not answered with an invented persona.

## Pipeline

```
caller audio (16 kHz int16) -> VAD -> Whisper STT (local, Tamil/English) -> Brain (LLM + tool loop)
   -> sentence chunker -> TTS (google | mms | none) -> audio (24 kHz int16) back to the caller
                                         |
                                         +-> Node /agent-api/tools/:name (check_calendar, book_demo, ...)
call end -> Node /agent-api/call-log (spooled to spool/ and retried if Node is down)
```

One `CallSession` per connection owns its Brain, VAD and state machine
(`IDLE/LISTENING/THINKING/SPEAKING`). The turn id is bumped on every new user turn and every
interrupt; in-flight LLM/TTS tasks are cancelled. Barge-in needs 250 ms of sustained speech while the
agent is speaking, with a raised energy threshold as a basic echo guard (no real echo cancellation:
use headphones or a client with AEC).

When a stage fails the call reports it and degrades only to real behaviour: STT failure ->
`error stt_failed`; LLM/tool failure -> `llm_failed`/`tool_failed`; TTS failure or `TTS_PROVIDER=none`
-> text-only (`tts:false` in `call_started`, `tts_failed` error). There are no canned replies or fake audio.

## Run

```bash
cd backend
python3 -m venv call_agent/.venv && call_agent/.venv/bin/pip install -r call_agent/requirements-dev.txt
cp call_agent/.env.example call_agent/.env      # fill in CALL_AGENT_API_KEY, EKALAVYA_AGENT_KEY, LLM settings
python3 -m uvicorn call_agent.server:app --port 8085
python3 -m call_agent.cli_call --text            # terminal client (add sounddevice for mic/speaker)
```

The Node backend must be running with the same `EKALAVYA_AGENT_KEY`. Docker: compose profile `voice`.

## API

* `GET /health` - unauthenticated: `{status, stt, llm, tts, version}`; with the API key also details.
  STT loads lazily, so `stt` is `not_loaded` until the first utterance.
* `POST /api/call/chat` `{message, callId?}` -> `{callId, text, tts, audio_base64?}` (WAV). Bearer auth.
* `WS /ws/call` (Bearer header or `?token=`). Client: `start_call{callerPhone?,callerName?,leadId?}`,
  `text_input{text}`, `interrupt`, `end_call`, binary int16 LE mono 16 kHz PCM (frames <= `MAX_FRAME_BYTES`,
  even length). Server: `call_started{callId,greeting,sampleRate,tts}`, `transcribing`, `user_speech`,
  `assistant_sentence`, `state_change`, `interrupted`, `error{code,message}`, `call_ended{summary,outcome,logged}`,
  binary int16 LE PCM at `sampleRate`.
* `WS /ws/twilio` only when `TWILIO_STREAM_ENABLED=true`: Twilio Media Streams (mu-law 8 kHz), validates
  `X-Twilio-Signature` against `TWILIO_STREAM_URL`; caller from the `from` custom parameter.

Call outcome is derived from tool results (`book_demo` succeeded -> `demo_booked`; `update_lead_status`
follow_up/lost -> `callback_requested`/`not_interested`), otherwise `dropped`/`info_only`/`unknown`.
Note `update_lead_status lost` needs human approval on Node, so the lead may not actually change.

## Providers and licences

* STT: the fine-tuned Whisper small in `backend/model/whisper-tamil-small` (check its own README for licence).
* LLM: Ollama / OpenAI / OpenRouter via the OpenAI-compatible chat API; a tool-calling capable model is needed.
* TTS `google`: Google Cloud Text-to-Speech (ta-IN / en-IN), needs `GOOGLE_TTS_API_KEY`.
  TTS `mms`: Meta MMS-TTS, **CC-BY-NC 4.0, non-commercial only** (a warning is logged). `none`: text only.
* VibeVoice (`backend/model/model.safetensors`) is deliberately not used: English-only, research-only licence,
  and use over telephony is restricted.

## Latency (measured, not promised)

Whisper small on this Apple Silicon laptop, CPU, torch 2.11: about 1.2-1.3 s to transcribe a 5 s clip
(synthetic, non-speech signal, language auto-detect included). That is STT only. End-to-end time to first
audio adds the VAD end-of-speech silence (`VAD_SILENCE_MS`, default 600 ms), the LLM first sentence and the
TTS round trip, so expect a few seconds per turn, not sub-second. It has not been measured with a real
LLM or TTS provider here.

## Consent and security

The greeting comes from Node's persona and must state that this is an automated assistant and that the call
may be transcribed; transcripts are stored in Node `CallLog`. Every REST/WS endpoint requires
`CALL_AGENT_API_KEY` (constant-time compare; an unset key means nothing is authorised, and the server refuses to
start without it). CORS is an explicit allow-list (`CALL_AGENT_CORS_ORIGINS`). Contact details are not passed to the
LLM by Node. Call logs that Node rejects (HTTP 4xx) go to `spool/call_logs.rejected.jsonl`; logs sent while Node is
down go to `spool/call_logs.jsonl` and are re-sent every 60 s and at startup. `spool/` contains personal data and is git-ignored.

## Tests

```bash
cd backend && python3 -m pytest call_agent/tests -m 'not slow' -q   # no network, no downloads
python3 -m pytest call_agent/tests -m slow -s                       # loads the local Whisper weights
```

## Known gaps

No real echo cancellation; no concurrent-call limit; STT uses one lock so concurrent calls queue for inference;
webrtcvad and sounddevice are optional and untested on this machine (energy VAD is what was exercised);
Google TTS and MMS were not run (no key / no download); the Twilio path is covered by frame/signature tests only.
