"""HTTP client for the E-Kalavya Node internal API (/agent-api).

All calls carry X-Agent-Key. Call logs are retried with backoff and spooled to a
local JSONL file if Node is unreachable, then re-sent later: a transcript is never
dropped silently.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import httpx

from .config import Config

logger = logging.getLogger("call_agent.node")


class NodeError(Exception):
    """Node was unreachable or answered with an error."""

    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.status = status


class NodeClient:
    def __init__(
        self,
        config: Config,
        *,
        client: Optional[httpx.AsyncClient] = None,
        retries: int = 3,
        backoff: float = 0.5,
        timeout: float = 8.0,
    ):
        self.base = config.ekalavya_api_url.rstrip("/")
        self._headers = {"X-Agent-Key": config.agent_key, "Accept": "application/json"}
        self._client = client or httpx.AsyncClient(timeout=timeout)
        self._owns_client = client is None
        self.retries = retries
        self.backoff = backoff
        self.spool_path = Path(config.spool_dir) / "call_logs.jsonl"
        self.rejected_path = Path(config.spool_dir) / "call_logs.rejected.jsonl"
        self._spool_lock = asyncio.Lock()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _request(self, method: str, path: str, *, json_body: Any = None, retries: int = 0, timeout: Optional[float] = None) -> Any:
        url = f"{self.base}/agent-api{path}"
        last: Optional[Exception] = None
        for attempt in range(retries + 1):
            try:
                resp = await self._client.request(method, url, headers=self._headers, json=json_body, timeout=timeout)
            except httpx.HTTPError as exc:
                last = NodeError(f"Node unreachable at {self.base}: {exc.__class__.__name__}: {exc}")
            else:
                if resp.status_code < 400:
                    try:
                        return resp.json()
                    except ValueError as exc:
                        raise NodeError(f"Node returned non-JSON for {path}", resp.status_code) from exc
                detail = resp.text[:300]
                err = NodeError(f"Node {method} {path} -> HTTP {resp.status_code}: {detail}", resp.status_code)
                if resp.status_code < 500 or resp.status_code == 503:
                    raise err  # client errors / unconfigured Node (503) will not fix themselves by retrying
                last = err
            if attempt < retries:
                await asyncio.sleep(self.backoff * (2 ** attempt))
        assert last is not None
        raise last

    # --- read APIs ---------------------------------------------------------
    async def get_persona(self) -> dict:
        return await self._request("GET", "/persona", retries=1)

    async def get_tools(self) -> list:
        data = await self._request("GET", "/tools", retries=1)
        return data["tools"] if isinstance(data, dict) and "tools" in data else data

    async def identify(self, phone: str) -> dict:
        return await self._request("POST", "/calls/identify", json_body={"phone": phone}, retries=1)

    async def run_tool(self, name: str, args: dict, call_id: str, lead_id: Optional[str] = None) -> dict:
        """Execute a tool on Node. Returns {ok, result?, error?}; transport failures raise NodeError."""
        body: dict[str, Any] = {"args": args, "callId": call_id}
        if lead_id:
            body["leadId"] = lead_id
        try:
            return await self._request("POST", f"/tools/{name}", json_body=body, retries=0, timeout=15.0)
        except NodeError as exc:
            if exc.status and exc.status < 500:
                return {"ok": False, "error": str(exc)}
            raise

    async def ping(self) -> dict:
        """Reachability probe. reachable=True means Node answered at all."""
        try:
            resp = await self._client.get(f"{self.base}/agent-api/persona", headers=self._headers, timeout=3.0)
        except httpx.HTTPError as exc:
            return {"reachable": False, "error": exc.__class__.__name__}
        return {"reachable": True, "status": resp.status_code, "authorized": resp.status_code == 200}

    # --- call log with spool ------------------------------------------------
    async def post_call_log(self, payload: dict) -> str:
        """POST the call log. Returns 'sent' or 'spooled'. Never raises for transport errors."""
        try:
            await self._request("POST", "/call-log", json_body=payload, retries=self.retries)
            return "sent"
        except NodeError as exc:
            if exc.status == 404 and payload.get("leadId"):
                # Lead unknown to Node: keep the transcript, drop only the link.
                retry = {k: v for k, v in payload.items() if k != "leadId"}
                logger.warning("call-log: lead %s not found; re-sending without leadId", payload["leadId"])
                return await self.post_call_log(retry)
            if exc.status and 400 <= exc.status < 500 and exc.status != 429:
                logger.error("call-log rejected by Node (callId=%s): %s; saved to %s", payload.get("callId"), exc, self.rejected_path)
                await self._spool(payload, self.rejected_path)
                return "rejected"
            logger.warning("Node down, spooling call log (callId=%s): %s", payload.get("callId"), exc)
            await self._spool(payload)
            return "spooled"

    async def _spool(self, payload: dict, path: Optional[Path] = None) -> None:
        async with self._spool_lock:
            await asyncio.to_thread(self._spool_sync, payload, path or self.spool_path)

    @staticmethod
    def _spool_sync(payload: dict, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
            f.flush()
            os.fsync(f.fileno())

    def spool_pending(self) -> int:
        try:
            with open(self.spool_path, encoding="utf-8") as f:
                return sum(1 for line in f if line.strip())
        except OSError:
            return 0

    async def flush_spool(self) -> dict:
        """Re-send spooled logs. Failed ones stay spooled. Safe to call repeatedly (Node upserts by callId)."""
        async with self._spool_lock:
            if not self.spool_path.exists():
                return {"sent": 0, "remaining": 0}
            lines = await asyncio.to_thread(lambda: self.spool_path.read_text(encoding="utf-8").splitlines())
            remaining: list[str] = []
            sent = 0
            node_down = False
            for line in lines:
                if not line.strip():
                    continue
                if node_down:
                    remaining.append(line)
                    continue
                try:
                    payload = json.loads(line)
                except ValueError:
                    remaining.append(line)  # keep corrupt lines for manual inspection
                    continue
                try:
                    await self._request("POST", "/call-log", json_body=payload, retries=0)
                    sent += 1
                except NodeError as exc:
                    if exc.status and exc.status < 500 and exc.status not in (429,):
                        # permanent rejection: park it so it is not retried forever
                        await asyncio.to_thread(self._spool_sync, payload, self.rejected_path)
                    else:
                        remaining.append(line)
                        node_down = True
            tmp = self.spool_path.with_suffix(f".{uuid.uuid4().hex}.tmp")
            await asyncio.to_thread(lambda: (tmp.write_text("".join(l + "\n" for l in remaining), encoding="utf-8"), os.replace(tmp, self.spool_path)))
            if sent:
                logger.info("flushed %d spooled call logs, %d remaining", sent, len(remaining))
            return {"sent": sent, "remaining": len(remaining)}
