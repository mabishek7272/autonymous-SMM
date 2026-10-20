import asyncio

import numpy as np

from call_agent import audio
from call_agent.brain import ToolFailure, ToolResult
from call_agent.call_session import CallSession, SessionDeps, State
from call_agent.llm import LlmError
from call_agent.stt import SttError
from call_agent.vad import VoiceActivityDetector

from .fakes import FakeBrain, FakeNode, FakePersonaProvider, FakeStt, FakeTts

LEAD = "11111111-1111-4111-8111-111111111111"


def make(cfg, brain=None, stt=None, tts=None, node=None, persona=None):
    brain = brain or FakeBrain()
    node = node or FakeNode()
    out = {"json": [], "audio": []}

    async def sj(m):
        out["json"].append(m)

    async def sa(b):
        out["audio"].append(b)

    deps = SessionDeps(
        config=cfg, node=node, persona=persona or FakePersonaProvider(), stt=stt or FakeStt(),
        tts=tts or FakeTts(enabled=False), brain_factory=lambda *a: brain,
        vad_factory=lambda: VoiceActivityDetector(use_webrtc=False, silence_ms=200),
    )
    s = CallSession(deps, sj, sa)
    return s, out, brain, node


def types(out):
    return [m["type"] for m in out["json"]]


def tone(ms, amp=0.3):
    t = np.arange(int(16 * ms)) / 16000
    return audio.float_to_pcm16(amp * np.sin(2 * np.pi * 220 * t * 1000 / 1000))


async def settle(s, t=0.05):
    await asyncio.sleep(t)
    if s._task:
        await asyncio.wait([s._task], timeout=2)


async def test_start_greeting_and_text_turn(cfg):
    s, out, brain, node = make(cfg)
    assert await s.start({"callerPhone": "+919876543210", "leadId": LEAD})
    await settle(s)
    started = out["json"][0]
    assert started["type"] == "call_started" and started["tts"] is False and "automated" in started["greeting"]
    assert started["sampleRate"] == 24000 and node.identified == ["+919876543210"]
    await s.handle_text("hello")
    await settle(s)
    assert brain.inputs == [("hello", "en")]  # text goes straight to the brain, no STT
    sentences = [m["text"] for m in out["json"] if m["type"] == "assistant_sentence"]
    assert sentences == ["Sure.", "Anything else?"]
    assert s.state == State.LISTENING and out["audio"] == []
    res = await s.end("client_end")
    assert res["type"] == "call_ended" and res["outcome"] == "info_only" and res["logged"] == "sent"
    log = node.logs[0]
    assert log["leadId"] == LEAD and log["phone"] == "+919876543210" and log["durationSec"] >= 0
    assert [t["role"] for t in log["transcript"]] == ["agent", "caller", "agent", "agent"]
    assert log["startedAt"].endswith("Z")
    assert (await s.end()) is res  # idempotent, one log only
    assert len(node.logs) == 1


async def test_bad_lead_id_ignored_and_reported(cfg):
    s, out, *_ = make(cfg)
    await s.start({"leadId": "not-a-uuid"})
    assert s.lead_id is None and "error" in types(out)
    await s.end()


async def test_persona_unavailable_is_error_not_call(cfg):
    s, out, brain, node = make(cfg, persona=FakePersonaProvider(fail=True))
    assert not await s.start({})
    assert out["json"][0]["code"] == "persona_unavailable" and "call_started" not in types(out)
    await s.end("disconnect")
    assert node.logs == []


async def test_end_without_start_logs_nothing(cfg):
    s, out, brain, node = make(cfg)
    assert await s.end("disconnect") == {}
    assert node.logs == [] and s.closed.is_set()


async def test_text_before_start(cfg):
    s, out, *_ = make(cfg)
    await s.handle_text("hi")
    assert out["json"][0]["code"] == "not_started"


async def test_interrupt_cancels_llm_and_bumps_turn(cfg):
    gate = asyncio.Event()
    brain = FakeBrain(gate=gate)
    s, out, brain, _ = make(cfg, brain=brain)
    await s.start({})
    await settle(s)
    await s.handle_text("question")
    await asyncio.sleep(0.05)
    assert s.state == State.THINKING
    turn = s.turn
    await s.interrupt()
    assert s.turn == turn + 1 and brain.cancelled and s.state == State.LISTENING
    assert "interrupted" in types(out)
    gate.set()
    await asyncio.sleep(0.05)
    assert not [m for m in out["json"] if m["type"] == "assistant_sentence"]  # nothing leaks after interrupt
    await s.end()


async def test_new_turn_supersedes_old_one(cfg):
    gate = asyncio.Event()
    brain = FakeBrain(gate=gate)
    s, out, brain, _ = make(cfg, brain=brain)
    await s.start({})
    await settle(s)
    await s.handle_text("one")
    await asyncio.sleep(0.02)
    t1 = s.turn
    await s.handle_text("two")
    assert s.turn == t1 + 1
    gate.set()
    await settle(s, 0.1)
    assert [i[0] for i in brain.inputs] == ["one", "two"]
    await s.end()


async def test_speaking_state_and_audio(cfg):
    s, out, brain, _ = make(cfg, tts=FakeTts(enabled=True))
    await s.start({})
    await settle(s, 0.3)
    assert out["audio"], "greeting should be spoken when TTS is on"
    assert any(m.get("state") == "SPEAKING" for m in out["json"] if m["type"] == "state_change")
    await s.end()


async def test_tts_failure_is_reported_once_and_call_continues(cfg):
    s, out, *_ = make(cfg, tts=FakeTts(enabled=True, fail=True))
    await s.start({})
    await settle(s, 0.1)
    await s.handle_text("hello")
    await settle(s, 0.1)
    errs = [m for m in out["json"] if m["type"] == "error" and m["code"] == "tts_failed"]
    assert len(errs) == 2  # once for the greeting turn, once for the reply turn
    assert [m for m in out["json"] if m["type"] == "assistant_sentence"]
    await s.end()


async def test_provider_errors_surface(cfg):
    for exc, code in ((LlmError("down"), "llm_failed"), (ToolFailure("x"), "tool_failed")):
        s, out, *_ = make(cfg, brain=FakeBrain(error=exc))
        await s.start({})
        await s.handle_text("hi")
        await settle(s, 0.1)
        assert any(m.get("code") == code for m in out["json"])
        assert not any(m["type"] == "assistant_sentence" for m in out["json"])  # no canned reply
        await s.end()


async def test_audio_path_stt_and_bad_frames(cfg):
    stt = FakeStt("book a demo")
    s, out, brain, _ = make(cfg, stt=stt)
    await s.start({})
    await settle(s)
    await s.handle_audio(b"\x00\x00\x00")  # odd length
    await s.handle_audio(b"\x00" * (cfg.max_frame_bytes + 2))
    await s.handle_audio(b"")
    assert sum(1 for m in out["json"] if m.get("code") == "bad_frame") == 3
    await s.handle_audio(b"\x00\x00" * 3200 + tone(600) + b"\x00\x00" * 6400)
    await settle(s, 0.2)
    assert stt.calls and brain.inputs[0][0] == "book a demo"
    assert {"transcribing", "user_speech"} <= set(types(out))
    await s.end()


async def test_stt_failure_surfaces(cfg):
    s, out, *_ = make(cfg, stt=FakeStt(error=SttError("no model")))
    await s.start({})
    await settle(s)
    await s.handle_audio(tone(600) + b"\x00\x00" * 6400)
    await settle(s, 0.2)
    assert any(m.get("code") == "stt_failed" for m in out["json"])
    assert s.state == State.LISTENING
    await s.end()


async def test_barge_in_while_agent_speaking(cfg):
    tts = FakeTts(enabled=True, rate=24000)
    s, out, brain, _ = make(cfg, tts=tts, brain=FakeBrain(sentences=["A long first sentence here."] * 3))
    await s.start({})
    await settle(s, 0.4)
    await s.handle_text("go")
    await asyncio.sleep(0.15)
    turn = s.turn
    assert s.agent_speaking
    await s.handle_audio(tone(500))
    assert "interrupted" in types(out) and s.turn > turn
    await s.end()


async def test_max_call_seconds_ends_call(cfg):
    cfg.max_call_seconds = 0.05
    s, out, brain, node = make(cfg)
    await s.start({})
    await asyncio.wait_for(s.closed.wait(), 2)
    assert any(m.get("code") == "max_call_duration" for m in out["json"])
    assert node.logs and node.logs[0]["outcome"] == "dropped"


async def test_outcome_from_tool_results(cfg):
    s, out, brain, node = make(cfg)
    await s.start({})
    brain.tool_results = [ToolResult("book_demo", {}, True, {})]
    assert (await s.end())["outcome"] == "demo_booked"
    s, out, brain, node = make(cfg)
    await s.start({})
    brain.tool_results = [ToolResult("book_demo", {}, False, error="slot taken")]
    assert (await s.end("client_end"))["outcome"] == "unknown"
    s, out, brain, node = make(cfg)
    await s.start({})
    brain.tool_results = [ToolResult("update_lead_status", {"status": "follow_up"}, True, {})]
    assert (await s.end())["outcome"] == "callback_requested"
