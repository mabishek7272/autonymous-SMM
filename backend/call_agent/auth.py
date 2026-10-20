"""Constant-time API-key checks for REST and WebSocket clients."""

from __future__ import annotations

import hmac
from typing import Mapping, Optional


def keys_match(provided: Optional[str], expected: str) -> bool:
    """Timing-safe comparison. An empty expected key never matches (never open)."""
    if not expected or not provided:
        return False
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))


def extract_token(headers: Mapping[str, str], query_token: Optional[str] = None) -> Optional[str]:
    """Bearer header takes precedence; ?token= is the fallback (browsers cannot set WS headers)."""
    auth = headers.get("authorization") or headers.get("Authorization")
    if auth:
        scheme, _, value = auth.partition(" ")
        if scheme.lower() == "bearer" and value.strip():
            return value.strip()
    return query_token or None


def is_authorized(expected: str, headers: Mapping[str, str], query_token: Optional[str] = None) -> bool:
    return keys_match(extract_token(headers, query_token), expected)
