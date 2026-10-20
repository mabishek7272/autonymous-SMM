"""Per-call Brain: LLM conversation with a bounded tool-calling loop against Node."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, AsyncIterator, Optional

from .chunker import SentenceChunker
from .llm import LlmClient, LlmError
from .node_client import NodeClient, NodeError
from .persona import Persona

logger = logging.getLogger("call_agent.brain")

MAX_TOOL_ROUNDS = 4
HISTORY_LIMIT = 30


class ToolFailure(Exception):
    """Node could not execute a tool (transport failure)."""


@dataclass
class ToolResult:
    name: str
    args: dict
    ok: bool
    result: Any = None
    error: Optional[str] = None


def format_caller_context(ctx: Optional[dict]) -> str:
    """Render Node's /calls/identify answer as prompt context. Only facts Node returned."""
    if not ctx:
        return "Caller identity: unknown phone number or lookup unavailable. Do not assume anything about the caller."
    parts = []
    parent = ctx.get("parent")
    if parent:
        parts.append(f"Known parent: {parent.get('fullName')}.")
    lead = ctx.get("lead")
    if lead:
        bits = [f"status {lead.get('status')}"]
        if lead.get("gradeInterested"):
            bits.append(f"grade {lead['gradeInterested']}")
        if lead.get("boardInterested"):
            bits.append(f"board {lead['boardInterested']}")
        if lead.get("subjectsInterested"):
            bits.append("subjects " + ", ".join(lead["subjectsInterested"]))
        parts.append(f"Lead {lead.get('id')}: " + ", ".join(bits) + ".")
    if ctx.get("openAppointment"):
        parts.append("Open appointment: " + json.dumps(ctx["openAppointment"], ensure_ascii=False))
    students = ctx.get("students") or []
    if students:
        parts.append("Students on file: " + ", ".join(s.get("fullName", "") for s in students) + ".")
    if not parts:
        return "Caller identity: this number is not in our records."
    return "Caller context from our records. " + " ".join(parts)


class Brain:
    def __init__(
        self,
        llm: LlmClient,
        node: NodeClient,
        persona: Persona,
        call_id: str,
        lead_id: Optional[str] = None,
        caller_context: Optional[dict] = None,
        min_chunk: int = 24,
    ):
        self.llm = llm
        self.node = node
        self.call_id = call_id
        self.lead_id = lead_id or ((caller_context or {}).get("lead") or {}).get("id")
        self.tools = persona.tools
        self.min_chunk = min_chunk
        self.system = persona.system_prompt + "\n\n" + format_caller_context(caller_context)
        self.history: list[dict] = []
        self.tool_results: list[ToolResult] = []

    def add_assistant(self, text: str) -> None:
        self.history.append({"role": "assistant", "content": text})

    def _window(self) -> list[dict]:
        """Last HISTORY_LIMIT messages, starting on a user turn so tool-call pairs are never split."""
        h = self.history
        if len(h) <= HISTORY_LIMIT:
            return list(h)
        h = h[-HISTORY_LIMIT:]
        for i, m in enumerate(h):
            if m["role"] == "user":
                return h[i:]
        return h

    def _repair(self) -> None:
        """Drop a trailing assistant tool_calls message whose tool replies are incomplete (would be rejected by the API)."""
        for i in range(len(self.history) - 1, -1, -1):
            m = self.history[i]
            if m["role"] == "assistant" and m.get("tool_calls"):
                replies = sum(1 for x in self.history[i + 1:] if x["role"] == "tool")
                if replies < len(m["tool_calls"]):
                    del self.history[i:]
                return
            if m["role"] == "user":
                return

    def _trim(self) -> None:
        self.history = self._window()

    async def _exec_tool(self, call: dict) -> ToolResult:
        try:
            args = json.loads(call["arguments"] or "{}")
            if not isinstance(args, dict):
                raise ValueError("arguments must be an object")
        except ValueError as exc:
            return ToolResult(call["name"], {}, False, error=f"invalid tool arguments: {exc}")
        try:
            res = await self.node.run_tool(call["name"], args, self.call_id, self.lead_id)
        except NodeError as exc:
            raise ToolFailure(str(exc)) from exc
        return ToolResult(call["name"], args, bool(res.get("ok")), res.get("result"), res.get("error"))

    async def reply(self, user_text: str, language: Optional[str] = None) -> AsyncIterator[str]:
        """Stream sentences for one caller turn. Cancel the consuming task to abort.

        Raises LlmError / ToolFailure on provider failure (no fallback reply is invented).
        """
        self.history.append({"role": "user", "content": user_text})
        system = self.system
        if language:
            system += f"\n\nThe caller is currently speaking {'Tamil' if language == 'ta' else 'English'}; reply in the same language."
        spoken: list[str] = []
        try:
            for round_no in range(MAX_TOOL_ROUNDS):
                tools = self.tools if (self.tools and round_no < MAX_TOOL_ROUNDS - 1) else None
                messages = [{"role": "system", "content": system}] + self._window()
                chunker = SentenceChunker(self.min_chunk)
                text_parts: list[str] = []
                calls: list[dict] = []
                async for d in self.llm.stream(messages, tools):
                    if d.text:
                        text_parts.append(d.text)
                        for s in chunker.feed(d.text):
                            spoken.append(s)
                            yield s
                    if d.finished:
                        calls = d.tool_calls
                for s in chunker.flush():
                    spoken.append(s)
                    yield s
                content = "".join(text_parts)
                if not calls:
                    self.history.append({"role": "assistant", "content": content})
                    return
                self.history.append({
                    "role": "assistant",
                    "content": content or None,
                    "tool_calls": [
                        {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}}
                        for c in calls
                    ],
                })
                for c in calls:
                    tr = await self._exec_tool(c)
                    self.tool_results.append(tr)
                    payload = {"ok": tr.ok, "result": tr.result} if tr.ok else {"ok": False, "error": tr.error}
                    self.history.append({
                        "role": "tool",
                        "tool_call_id": c["id"],
                        "content": json.dumps(payload, ensure_ascii=False, default=str),
                    })
            logger.warning("tool loop hit %d rounds without a final answer (callId=%s)", MAX_TOOL_ROUNDS, self.call_id)
        except BaseException:
            self._repair()
            # Interrupted (CancelledError) or failed: keep what was actually emitted so context stays truthful.
            if spoken and (not self.history or self.history[-1]["role"] != "assistant"):
                self.history.append({"role": "assistant", "content": " ".join(spoken) + " [interrupted]"})
            raise
        finally:
            self._trim()
