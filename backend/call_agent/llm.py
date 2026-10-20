"""OpenAI-compatible streaming chat client (Ollama, OpenAI, OpenRouter)."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Optional

import httpx

from .config import Config

logger = logging.getLogger("call_agent.llm")


class LlmError(Exception):
    """The LLM provider failed. Surfaced to the caller; there is no canned fallback."""


@dataclass
class LlmDelta:
    text: str = ""
    tool_calls: list[dict] = field(default_factory=list)  # filled only on the final delta
    finished: bool = False


class LlmClient:
    def __init__(self, config: Config, client: Optional[httpx.AsyncClient] = None):
        self.provider = config.llm_provider
        self.base, self._key, self.model = config.llm_settings()
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=5.0))
        self._owns = client is None

    async def aclose(self) -> None:
        if self._owns:
            await self._client.aclose()

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self._key:
            h["Authorization"] = f"Bearer {self._key}"
        return h

    async def probe(self) -> bool:
        """Cheap reachability check for /health."""
        try:
            if self.provider == "ollama":
                url = self.base[: -len("/v1")] + "/api/tags"
            else:
                url = self.base + "/models"
            r = await self._client.get(url, headers=self._headers(), timeout=3.0)
            return r.status_code < 400
        except httpx.HTTPError:
            return False

    async def stream(self, messages: list[dict], tools: Optional[list[dict]] = None) -> AsyncIterator[LlmDelta]:
        """Yield text deltas, then one final delta with any assembled tool calls."""
        body: dict[str, Any] = {"model": self.model, "messages": messages, "stream": True, "temperature": 0.4}
        if tools:
            body["tools"] = tools
        acc: dict[int, dict] = {}
        try:
            async with self._client.stream("POST", self.base + "/chat/completions", headers=self._headers(), json=body) as resp:
                if resp.status_code >= 400:
                    detail = (await resp.aread()).decode("utf-8", "replace")[:300]
                    raise LlmError(f"{self.provider} returned HTTP {resp.status_code}: {detail}")
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    if "error" in chunk:
                        raise LlmError(f"{self.provider} stream error: {chunk['error']}")
                    for choice in chunk.get("choices") or []:
                        delta = choice.get("delta") or {}
                        text = delta.get("content")
                        if text:
                            yield LlmDelta(text=text)
                        for tc in delta.get("tool_calls") or []:
                            slot = acc.setdefault(tc.get("index", 0), {"id": "", "name": "", "arguments": ""})
                            if tc.get("id"):
                                slot["id"] = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                slot["name"] += fn["name"]
                            if fn.get("arguments"):
                                slot["arguments"] += fn["arguments"]
        except httpx.HTTPError as exc:
            raise LlmError(f"{self.provider} unreachable or failed mid-stream: {exc.__class__.__name__}: {exc}") from exc
        calls = []
        for idx in sorted(acc):
            c = acc[idx]
            if c["name"]:
                calls.append({"id": c["id"] or f"call_{idx}", "name": c["name"], "arguments": c["arguments"] or "{}"})
        yield LlmDelta(tool_calls=calls, finished=True)
