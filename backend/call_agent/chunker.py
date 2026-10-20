"""Streaming sentence chunker: turns LLM token deltas into natural phrases for TTS."""

from __future__ import annotations

import re

# Sentence terminators: . ! ? Tamil/Devanagari danda, newline.
_TERMINATORS = ".!?।\n"
_CLOSERS = "\"')]”’"


class SentenceChunker:
    """Feed text deltas; get complete sentences back.

    A boundary is only accepted once the pending text reaches `min_len` characters
    (`first_min_len` for the first sentence, to keep time-to-first-audio low). A '.'
    between digits (3.5) is not a boundary.
    """

    def __init__(self, min_len: int = 24, first_min_len: int = 12):
        self.min_len = min_len
        self.first_min_len = first_min_len
        self._buf = ""
        self._emitted = 0

    def _threshold(self) -> int:
        return self.first_min_len if self._emitted == 0 else self.min_len

    def feed(self, delta: str) -> list[str]:
        self._buf += delta
        out: list[str] = []
        i = 0
        start = 0
        buf = self._buf
        while i < len(buf):
            ch = buf[i]
            if ch in _TERMINATORS:
                # need lookahead for closers/decimal checks; if at end, wait for more text
                j = i + 1
                while j < len(buf) and buf[j] in _CLOSERS:
                    j += 1
                if j >= len(buf) and ch != "\n":
                    break
                if ch == "." and 0 < i < len(buf) - 1 and buf[i - 1].isdigit() and buf[i + 1].isdigit():
                    i += 1
                    continue
                cand = buf[start:j].strip()
                if len(cand) >= self._threshold() or (ch == "\n" and cand and len(cand) >= self._threshold()):
                    out.append(cand)
                    self._emitted += 1
                    start = j
                i = j
                continue
            i += 1
        self._buf = buf[start:]
        return out

    def flush(self) -> list[str]:
        rest = self._buf.strip()
        self._buf = ""
        if rest and re.search(r"\w", rest):
            self._emitted += 1
            return [rest]
        return []
