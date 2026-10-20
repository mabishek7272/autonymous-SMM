import pathlib

import numpy as np
import pytest

from call_agent.audio import float_to_pcm16
from call_agent.stt import SttError, WhisperStt

MODEL = pathlib.Path(__file__).resolve().parents[2] / "model" / "whisper-tamil-small"


def test_missing_model_raises_sttError_not_canned_text(tmp_path):
    stt = WhisperStt(str(tmp_path / "nope"))
    with pytest.raises(SttError):
        stt.transcribe_sync(b"\x01\x00" * 16000)
    assert stt.status.startswith("error")


def test_silence_and_odd_length(tmp_path):
    stt = WhisperStt(str(tmp_path))
    with pytest.raises(SttError):
        stt.transcribe_sync(b"\x00")


@pytest.mark.slow
@pytest.mark.skipif(not MODEL.exists(), reason="local whisper weights not present")
def test_real_whisper_transcribes_5s_clip(capsys):
    rng = np.random.default_rng(1)
    t = np.arange(16000 * 5) / 16000
    # speech-like synthetic signal: harmonic stack with syllable-rate amplitude modulation + noise
    env = 0.5 * (1 + np.sin(2 * np.pi * 3.5 * t))
    x = sum(np.sin(2 * np.pi * f * t) / (i + 1) for i, f in enumerate((140, 280, 420, 560))) * env * 0.15
    x = x + rng.normal(0, 0.01, t.size)
    pcm = float_to_pcm16(x)
    stt = WhisperStt(str(MODEL), language="auto", device="cpu")
    stt.load()
    assert stt.status == "ready"
    res = stt.transcribe_sync(pcm)  # warm-up
    res = stt.transcribe_sync(pcm)
    assert isinstance(res.text, str) and res.language in ("ta", "en")
    assert abs(res.duration_s - 5.0) < 0.01
    forced = WhisperStt(str(MODEL), language="en", device="cpu")
    assert forced.transcribe_sync(pcm).language == "en"
    with capsys.disabled():
        print(f"\nSTT 5s clip: device=cpu latency={res.latency_s:.2f}s lang={res.language} text={res.text!r}")
