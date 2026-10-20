import numpy as np
import pytest

from call_agent import audio
from call_agent.auth import extract_token, is_authorized, keys_match
from call_agent.chunker import SentenceChunker
from call_agent.config import ConfigError, from_env, load_config, load_dotenv
from call_agent.stt import split_chunks
from call_agent.tts import detect_language
from call_agent.vad import FRAME_BYTES, VoiceActivityDetector
from call_agent.telephony_twilio import (
    compute_signature, mulaw8k_to_pcm16k, parse_message, pcm_to_mulaw_frames, validate_signature,
)


# ---- auth
def test_auth():
    assert keys_match("abc", "abc")
    assert not keys_match("abd", "abc")
    assert not keys_match("", "")
    assert not keys_match("x", "")  # empty expected key is never open
    assert extract_token({"authorization": "Bearer tok"}) == "tok"
    assert extract_token({}, "q") == "q"
    assert extract_token({"authorization": "Basic zzz"}) is None
    assert is_authorized("k", {"Authorization": "Bearer k"})
    assert is_authorized("k", {}, "k")
    assert not is_authorized("k", {"authorization": "Bearer nope"}, None)
    assert not is_authorized("", {}, "")


# ---- config
def test_config_reports_all_problems():
    with pytest.raises(ConfigError) as e:
        load_config({"LLM_PROVIDER": "bogus", "TTS_PROVIDER": "google", "STT_LANGUAGE": "fr"})
    msg = str(e.value)
    for needle in ("CALL_AGENT_API_KEY", "EKALAVYA_AGENT_KEY", "LLM_PROVIDER", "GOOGLE_TTS_API_KEY", "STT_LANGUAGE"):
        assert needle in msg


def test_config_valid_and_bad_int():
    env = {"CALL_AGENT_API_KEY": "a", "EKALAVYA_AGENT_KEY": "b", "OLLAMA_MODEL": "m", "MAX_CALL_SECONDS": "60"}
    c = load_config(env)
    assert c.max_call_seconds == 60 and c.tts_provider == "none"
    with pytest.raises(ConfigError):
        from_env({"MAX_CALL_SECONDS": "abc"})


def test_config_twilio_needs_token():
    env = {"CALL_AGENT_API_KEY": "a", "EKALAVYA_AGENT_KEY": "b", "OLLAMA_MODEL": "m", "TWILIO_STREAM_ENABLED": "true"}
    with pytest.raises(ConfigError, match="TWILIO_AUTH_TOKEN"):
        load_config(env)


def test_dotenv_inline_comments(tmp_path):
    f = tmp_path / ".env"
    f.write_text('A=  # only a comment\nB=val # c\nC="q # not comment"\n')
    env = {"B": "preset"}
    load_dotenv(f, env)
    assert env["A"] == "" and env["B"] == "preset" and env["C"] == "q # not comment"


# ---- chunker
def test_chunker_sentences_and_decimals():
    c = SentenceChunker(min_len=10, first_min_len=5)
    out = []
    for piece in ["Hello the", "re. The fee is 3.5 lakh. And ", "more text here!", " tail"]:
        out += c.feed(piece)
    out += c.flush()
    assert out[0] == "Hello there."
    assert any("3.5 lakh." in s for s in out)
    assert out[-1] == "tail" or out[-1].endswith("tail")


def test_chunker_tamil_danda_and_min_len():
    c = SentenceChunker(min_len=10, first_min_len=5)
    out = c.feed("வணக்கம் நண்பரே। ok. ")
    assert out[0] == "வணக்கம் நண்பரே।"
    c2 = SentenceChunker(min_len=30, first_min_len=30)
    assert c2.feed("Hi. Yes. ") == []
    assert c2.flush() == ["Hi. Yes."]
    assert SentenceChunker().flush() == []


# ---- language detection
def test_detect_language():
    assert detect_language("வணக்கம்") == "ta"
    assert detect_language("hello vanakkam") == "en"
    assert detect_language("Hi வணக்கம்") == "ta"


# ---- VAD
def tone(ms, amp=0.3, sr=16000):
    t = np.arange(int(sr * ms / 1000)) / sr
    return audio.float_to_pcm16(amp * np.sin(2 * np.pi * 220 * t))


def quiet(ms):
    return b"\x00\x00" * int(16 * ms)


def vad():
    return VoiceActivityDetector(use_webrtc=False, silence_ms=200)


def test_vad_utterance():
    v = vad()
    ev = v.process(quiet(200) + tone(600) + quiet(400))
    kinds = [e.kind for e in ev]
    assert kinds == ["speech_start", "utterance"]
    assert len(ev[1].audio) >= 600 * 32


def test_vad_drops_blips():
    v = vad()
    assert [e.kind for e in v.process(tone(120) + quiet(500))] == ["speech_start"]  # too short -> no utterance


def test_vad_barge_in_needs_sustained_speech():
    v = vad()
    short = [e.kind for e in v.process(tone(160) + quiet(400), agent_speaking=True)]
    assert "barge_in" not in short
    v = vad()
    kinds = [e.kind for e in v.process(tone(500), agent_speaking=True)]
    assert "barge_in" in kinds
    assert "barge_in" not in [e.kind for e in vad().process(tone(500))]  # not while agent silent


def test_vad_echo_guard_raises_threshold():
    quietish = tone(600, amp=0.03)  # rms 0.021: above 0.015, below the guarded 0.03
    assert "speech_start" in [e.kind for e in vad().process(quietish)]
    assert "speech_start" not in [e.kind for e in vad().process(quietish, agent_speaking=True)]


def test_vad_odd_chunking():
    v = vad()
    data = quiet(100) + tone(600) + quiet(400)
    ev = []
    for i in range(0, len(data), 333 * 2):
        ev += v.process(data[i:i + 666])
    assert [e.kind for e in ev] == ["speech_start", "utterance"]


# ---- audio / twilio
def test_mulaw_roundtrip():
    x = (0.5 * np.sin(np.linspace(0, 60, 4000)) * 32767).astype("<i2")
    back = np.frombuffer(audio.mulaw_decode(audio.mulaw_encode(x.tobytes())), dtype="<i2").astype(float)
    err = np.abs(back - x) / (np.abs(x) + 200)
    assert np.median(err) < 0.05
    assert audio.mulaw_encode(b"\x00\x00") == b"\xff"
    assert len(audio.mulaw_encode(x.tobytes())) == x.size


def test_resample_lengths_and_tone():
    x = np.sin(2 * np.pi * 440 * np.arange(16000) / 16000).astype(np.float32)
    y = audio.resample(x, 16000, 24000)
    assert abs(y.size - 24000) <= 2
    assert audio.resample(x, 16000, 16000) is x or np.array_equal(audio.resample(x, 16000, 16000), x)
    spec = np.abs(np.fft.rfft(y))
    assert abs(np.argmax(spec) - 440) <= 2
    assert audio.resample_pcm16(b"", 8000, 16000) == b""


def test_pcm_odd_length_rejected():
    with pytest.raises(ValueError):
        audio.pcm16_to_float(b"\x00")


def test_wav_roundtrip():
    pcm = tone(100)
    w = audio.wav_bytes(pcm, 24000)
    assert w[:4] == b"RIFF"
    assert audio.wav_to_pcm(w) == (pcm, 24000)


def test_split_chunks():
    x = np.random.default_rng(0).normal(0, 0.1, 16000 * 70).astype(np.float32)
    parts = split_chunks(x)
    assert all(p.size <= 16000 * 30 for p in parts)
    assert sum(p.size for p in parts) == x.size
    assert len(split_chunks(x[:1000])) == 1


def test_twilio_parse_and_frames():
    import base64, json
    ev = parse_message(json.dumps({"event": "start", "start": {"streamSid": "S1", "callSid": "C1", "customParameters": {"from": "+919876543210"}}}))
    assert ev.event == "start" and ev.stream_sid == "S1" and ev.custom["from"] == "+919876543210"
    payload = base64.b64encode(b"\xff" * 160).decode()
    m = parse_message(json.dumps({"event": "media", "streamSid": "S1", "media": {"payload": payload}}))
    assert m.payload == b"\xff" * 160
    assert len(mulaw8k_to_pcm16k(m.payload)) == 640  # 20ms @16k int16
    assert parse_message('{"event":"stop"}').event == "stop"
    assert parse_message('{"event":"mark","mark":{"name":"x"}}').mark == "x"
    for bad in ("not json", "[]", '{"x":1}', '{"event":"media","media":{"payload":"@@@"}}'):
        with pytest.raises(ValueError):
            parse_message(bad)
    frames = pcm_to_mulaw_frames(tone(100, sr=16000) * 1, 16000)
    assert all(len(f) == 160 for f in frames[:-1]) and len(frames) == 5


def test_twilio_signature():
    url = "wss://example.com/ws/twilio"
    sig = compute_signature(url, "tok")
    assert validate_signature(url, sig, "tok")
    assert validate_signature("wss://example.com/ws/twilio", compute_signature("https://example.com/ws/twilio", "tok"), "tok")
    assert not validate_signature(url, sig, "other")
    assert not validate_signature(url, None, "tok")
    assert not validate_signature(url, sig, "")
