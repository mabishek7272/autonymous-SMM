import json

import httpx
import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from call_agent.server import create_app
from call_agent.services import Services

from .fakes import FakeBrain, FakeNode, FakePersonaProvider, FakeStt, FakeTts

KEY = "test-api-key"


class FakeLlm:
    model = "fake"
    provider = "fake"

    async def probe(self):
        return True

    async def aclose(self):
        pass


class NodeStub(FakeNode):
    spool = 0

    async def ping(self):
        return {"reachable": True, "status": 200, "authorized": True}

    def spool_pending(self):
        return 0

    async def flush_spool(self):
        return {}

    async def aclose(self):
        pass


@pytest.fixture
def client(cfg):
    brain = FakeBrain()
    node = NodeStub()
    svc = Services(cfg, node=node, persona=FakePersonaProvider(), llm=FakeLlm(), stt=FakeStt(), tts=FakeTts(enabled=False))
    svc.brain_factory = lambda *a: brain
    with TestClient(create_app(svc)) as c:
        c.node, c.brain = node, brain
        yield c


def test_health_unauthenticated_is_minimal(client):
    j = client.get("/health").json()
    assert set(j) == {"status", "stt", "llm", "tts", "version"}
    assert "details" not in j


def test_health_authenticated_has_details(client):
    j = client.get("/health", headers={"Authorization": f"Bearer {KEY}"}).json()
    assert j["node"] is True and "details" in j and j["status"] == "ok"


def test_chat_requires_auth(client):
    assert client.post("/api/call/chat", json={"message": "hi"}).status_code == 401
    assert client.post("/api/call/chat", json={"message": "hi"}, headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_chat_ok_text_only(client):
    r = client.post("/api/call/chat", json={"message": "hi"}, headers={"Authorization": f"Bearer {KEY}"})
    assert r.status_code == 200
    j = r.json()
    assert j["text"] == "Sure. Anything else?" and j["tts"] is False and "audio_base64" not in j


def test_chat_llm_failure_is_503(client):
    from call_agent.llm import LlmError
    client.brain.error = LlmError("down")
    r = client.post("/api/call/chat", json={"message": "hi"}, headers={"Authorization": f"Bearer {KEY}"})
    assert r.status_code == 503


def test_ws_rejects_unauthenticated(client):
    for url, headers in (("/ws/call", {}), ("/ws/call?token=wrong", {}), ("/ws/call", {"Authorization": "Bearer wrong"})):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(url, headers=headers) as ws:
                ws.receive_text()


def test_ws_full_text_call(client):
    with client.websocket_connect(f"/ws/call?token={KEY}") as ws:
        ws.send_json({"type": "start_call", "callerPhone": "+919876543210"})
        started = ws.receive_json()
        assert started["type"] == "call_started" and started["tts"] is False and started["sampleRate"] == 24000
        ws.send_json({"type": "text_input", "text": "hello"})
        got = []
        while not any(m.get("text") == "Anything else?" for m in got):
            got.append(ws.receive_json())
        assert {"type": "user_speech", "text": "hello"} in got
        ws.send_json({"type": "end_call"})
        while True:
            m = ws.receive_json()
            if m["type"] == "call_ended":
                break
    assert m["logged"] == "sent" and len(client.node.logs) == 1
    assert client.node.logs[0]["phone"] == "+919876543210"


def test_ws_bearer_header_and_bad_messages(client):
    with client.websocket_connect("/ws/call", headers={"Authorization": f"Bearer {KEY}"}) as ws:
        ws.send_text("not json")
        assert ws.receive_json()["code"] == "bad_message"
        ws.send_json({"type": "nope"})
        assert ws.receive_json()["code"] == "unknown_type"
        ws.send_json({"type": "text_input", "text": "hi"})
        assert ws.receive_json()["code"] == "not_started"
        ws.send_bytes(b"\x00\x00")  # audio before start is ignored, not a crash
        ws.send_json({"type": "end_call"})
    assert client.node.logs == []  # never started -> nothing logged


def test_ws_start_fails_clearly_when_node_down(cfg):
    svc = Services(cfg, node=NodeStub(), persona=FakePersonaProvider(fail=True), llm=FakeLlm(), stt=FakeStt(), tts=FakeTts(enabled=False))
    with TestClient(create_app(svc)) as c:
        with c.websocket_connect(f"/ws/call?token={KEY}") as ws:
            ws.send_json({"type": "start_call"})
            m = ws.receive_json()
            assert m["type"] == "error" and m["code"] == "persona_unavailable"


def test_twilio_disabled_by_default(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/twilio") as ws:
            ws.receive_text()


def test_twilio_bad_signature_rejected(cfg):
    cfg.twilio_stream_enabled, cfg.twilio_auth_token, cfg.twilio_stream_url = True, "tok", "wss://x.example/ws/twilio"
    svc = Services(cfg, node=NodeStub(), persona=FakePersonaProvider(), llm=FakeLlm(), stt=FakeStt(), tts=FakeTts(enabled=False))
    with TestClient(create_app(svc)) as c:
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect("/ws/twilio", headers={"x-twilio-signature": "bad"}) as ws:
                ws.receive_text()


def test_twilio_valid_signature_call(cfg):
    from call_agent.telephony_twilio import compute_signature
    url = "wss://x.example/ws/twilio"
    cfg.twilio_stream_enabled, cfg.twilio_auth_token, cfg.twilio_stream_url = True, "tok", url
    node = NodeStub()
    svc = Services(cfg, node=node, persona=FakePersonaProvider(), llm=FakeLlm(), stt=FakeStt(), tts=FakeTts(enabled=False))
    with TestClient(create_app(svc)) as c:
        with c.websocket_connect("/ws/twilio", headers={"x-twilio-signature": compute_signature(url, "tok")}) as ws:
            ws.send_text(json.dumps({"event": "start", "start": {"streamSid": "S", "callSid": "C", "customParameters": {"from": "+919876543210"}}}))
            ws.send_text(json.dumps({"event": "stop"}))
    assert node.identified == ["+919876543210"] and len(node.logs) == 1
