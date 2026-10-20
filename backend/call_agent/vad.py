"""Per-call voice activity detection with hysteresis, barge-in and echo guard."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

SAMPLE_RATE = 16000
FRAME_MS = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000
FRAME_BYTES = FRAME_SAMPLES * 2


@dataclass
class VadEvent:
    kind: str  # 'speech_start' | 'barge_in' | 'utterance'
    audio: bytes = b""


def _make_webrtc(aggressiveness: int):
    try:
        import webrtcvad  # optional

        return webrtcvad.Vad(aggressiveness)
    except Exception:
        return None


class VoiceActivityDetector:
    """Feed 16 kHz int16 PCM of any length via process(); get events back.

    - Speech starts after `start_ms` of speech, ends after `silence_ms` of silence (hysteresis:
      the "stay in speech" threshold is lower than the "enter speech" threshold).
    - While the agent is speaking the enter threshold is multiplied by `echo_factor` (echo guard)
      and a `barge_in` event fires only after `barge_in_ms` of sustained speech.
    - Segments with less than `min_speech_ms` of speech are dropped (clicks, echo blips).
    """

    def __init__(
        self,
        energy_threshold: float = 0.015,
        silence_ms: int = 600,
        start_ms: int = 100,
        min_speech_ms: int = 250,
        barge_in_ms: int = 250,
        echo_factor: float = 2.0,
        preroll_ms: int = 200,
        max_utterance_s: int = 60,
        use_webrtc: bool = True,
    ):
        self.thr = energy_threshold
        self.silence_ms = silence_ms
        self.start_ms = start_ms
        self.min_speech_ms = min_speech_ms
        self.barge_in_ms = barge_in_ms
        self.echo_factor = echo_factor
        self.preroll_frames = preroll_ms // FRAME_MS
        self.max_frames = max_utterance_s * 1000 // FRAME_MS
        self._webrtc = _make_webrtc(2) if use_webrtc else None
        self.backend = "webrtcvad" if self._webrtc else "energy"
        self._carry = b""
        self.reset()

    def reset(self) -> None:
        self._carry = b""
        self._preroll: list[bytes] = []
        self._reset_segment()

    def _reset_segment(self) -> None:
        self.in_speech = False
        self._run_ms = 0  # consecutive speech before start
        self._speech_ms = 0
        self._silence_ms = 0
        self._barged = False
        self._frames: list[bytes] = []

    def _is_speech(self, frame: bytes, agent_speaking: bool) -> bool:
        x = np.frombuffer(frame, dtype="<i2").astype(np.float32) / 32768.0
        level = float(np.sqrt(np.mean(x * x)))
        if self.in_speech:
            thr = self.thr * 0.6  # hysteresis: easier to stay in speech than to enter it
        else:
            thr = self.thr
        if agent_speaking:
            thr *= self.echo_factor
        if level < thr:
            return False
        if self._webrtc is not None:
            try:
                return bool(self._webrtc.is_speech(frame, SAMPLE_RATE))
            except Exception:
                return True
        return True

    def process(self, pcm: bytes, agent_speaking: bool = False) -> list[VadEvent]:
        events: list[VadEvent] = []
        data = self._carry + pcm
        n = (len(data) // FRAME_BYTES) * FRAME_BYTES
        self._carry = data[n:]
        for off in range(0, n, FRAME_BYTES):
            frame = data[off : off + FRAME_BYTES]
            speech = self._is_speech(frame, agent_speaking)
            if not self.in_speech:
                self._preroll.append(frame)
                if len(self._preroll) > self.preroll_frames + self.start_ms // FRAME_MS:
                    self._preroll.pop(0)
                self._run_ms = self._run_ms + FRAME_MS if speech else 0
                if self._run_ms >= self.start_ms:
                    self.in_speech = True
                    self._frames = list(self._preroll)
                    self._preroll = []
                    self._speech_ms = self._run_ms
                    self._silence_ms = 0
                    events.append(VadEvent("speech_start"))
                continue
            self._frames.append(frame)
            if speech:
                self._speech_ms += FRAME_MS
                self._silence_ms = 0
            else:
                self._silence_ms += FRAME_MS
            if agent_speaking and not self._barged and self._speech_ms >= self.barge_in_ms:
                self._barged = True
                events.append(VadEvent("barge_in"))
            if self._silence_ms >= self.silence_ms or len(self._frames) >= self.max_frames:
                if self._speech_ms >= self.min_speech_ms:
                    events.append(VadEvent("utterance", b"".join(self._frames)))
                self._reset_segment()
        return events
