"""Persona and tool definitions come from Node (single source of truth). No local fallback."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Optional

from .node_client import NodeClient, NodeError


class PersonaUnavailable(Exception):
    """Node could not supply the persona; the call must not proceed with an invented one."""


@dataclass
class Persona:
    system_prompt: str
    greeting: str
    languages: list[str]
    tools: list[dict]


class PersonaProvider:
    def __init__(self, node: NodeClient, ttl: float = 60.0, clock=time.monotonic):
        self._node = node
        self._ttl = ttl
        self._clock = clock
        self._cached: Optional[Persona] = None
        self._fetched_at = 0.0
        self._lock = asyncio.Lock()

    async def get(self) -> Persona:
        async with self._lock:
            if self._cached and self._clock() - self._fetched_at < self._ttl:
                return self._cached
            try:
                p = await self._node.get_persona()
                tools = await self._node.get_tools()
            except NodeError as exc:
                # A stale persona is still Node's text, but past the TTL we refuse: fees/slots may have changed.
                raise PersonaUnavailable(str(exc)) from exc
            if not isinstance(p, dict) or not p.get("systemPrompt") or not p.get("greeting"):
                raise PersonaUnavailable("Node /agent-api/persona returned no systemPrompt/greeting")
            self._cached = Persona(
                system_prompt=p["systemPrompt"],
                greeting=p["greeting"],
                languages=list(p.get("languages") or []),
                tools=list(tools or []),
            )
            self._fetched_at = self._clock()
            return self._cached
