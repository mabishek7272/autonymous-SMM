"""Audio helpers: PCM conversion, resampling, mu-law (numpy only, no audioop), WAV."""

from __future__ import annotations

import io
import math
import wave

import numpy as np

try:  # scipy gives a proper polyphase anti-aliased resampler
    from scipy.signal import resample_poly as _resample_poly
except Exception:  # pragma: no cover - exercised only without scipy
    _resample_poly = None


def pcm16_to_float(pcm: bytes) -> np.ndarray:
    if len(pcm) % 2:
        raise ValueError("PCM16 byte length must be even")
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def float_to_pcm16(x: np.ndarray) -> bytes:
    x = np.clip(np.asarray(x, dtype=np.float32), -1.0, 1.0)
    return (x * 32767.0).astype("<i2").tobytes()


def resample(x: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Resample a float array. Uses polyphase filtering (scipy) or linear interpolation."""
    x = np.asarray(x, dtype=np.float32)
    if src_rate == dst_rate or x.size == 0:
        return x
    if _resample_poly is not None:
        g = math.gcd(src_rate, dst_rate)
        return _resample_poly(x, dst_rate // g, src_rate // g).astype(np.float32)
    n_out = int(round(x.size * dst_rate / src_rate))
    t_out = np.linspace(0, x.size - 1, n_out)
    return np.interp(t_out, np.arange(x.size), x).astype(np.float32)


def resample_pcm16(pcm: bytes, src_rate: int, dst_rate: int) -> bytes:
    if src_rate == dst_rate:
        return pcm
    return float_to_pcm16(resample(pcm16_to_float(pcm), src_rate, dst_rate))


# --- G.711 mu-law -----------------------------------------------------------
_BIAS = 0x84
_CLIP = 32635


def mulaw_encode(pcm: bytes) -> bytes:
    """int16 LE PCM -> 8-bit mu-law bytes."""
    s = np.frombuffer(pcm, dtype="<i2").astype(np.int32)
    sign = (s < 0)
    mag = np.minimum(np.abs(s), _CLIP) + _BIAS
    exponent = np.floor(np.log2(mag)).astype(np.int32) - 7
    exponent = np.clip(exponent, 0, 7)
    mantissa = (mag >> (exponent + 3)) & 0x0F
    out = ~(sign.astype(np.int32) * 0x80 | (exponent << 4) | mantissa) & 0xFF
    return out.astype(np.uint8).tobytes()


def mulaw_decode(data: bytes) -> bytes:
    """8-bit mu-law bytes -> int16 LE PCM."""
    u = ~np.frombuffer(data, dtype=np.uint8).astype(np.int32) & 0xFF
    sign = u & 0x80
    exponent = (u >> 4) & 0x07
    mantissa = u & 0x0F
    mag = (((mantissa << 3) + _BIAS) << exponent) - _BIAS
    s = np.where(sign != 0, -mag, mag)
    return s.astype("<i2").tobytes()


def wav_bytes(pcm: bytes, sample_rate: int) -> bytes:
    """Wrap int16 LE mono PCM in a proper RIFF/WAVE container."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


def wav_to_pcm(data: bytes) -> tuple[bytes, int]:
    """Parse a mono 16-bit WAV, returning (pcm, sample_rate)."""
    with wave.open(io.BytesIO(data), "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise ValueError("expected mono 16-bit WAV")
        return w.readframes(w.getnframes()), w.getframerate()


def rms(x: np.ndarray) -> float:
    if x.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float32))))
