import json

import httpx
import pytest

from call_agent.brain import Brain, ToolFailure
from call_agent.config import Config
from call_agent.llm import LlmClient, LlmError
from call_agent.node_client import NodeClient, NodeError
from call_agent.persona import Persona, PersonaProvider, PersonaUnavailable

TOOLS = [{"type": "function", "function": {"name": "check_calendar", "description": "d", "parameters": {"type": "object"}}}]


def sse(*chunks):
    body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    return httpx.Response(200, content=body.encode(), headers={"content-type": "text/event-stream"})


def text_chunk(t):
    return {"choices": [{"delta": {"content": t}}]}


def tool_chunks(name, args, id="c1"):
    half = len(args) // 2
    return [
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": id, "function": {"name": name, "arguments": args[:half]}}]}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": args[half:]}}]}}]},
    ]


def make_brain(cfg, llm_handler, node_handler, ctx=None):
    llm = LlmClient(cfg, httpx.AsyncClient(transport=httpx.MockTransport(llm_handler)))
    node = NodeClient(cfg, client=httpx.AsyncClient(transport=httpx.MockTransport(node_handler)), backoff=0)
    return Brain(llm, node, Persona("SYS", "hi", ["en"], TOOLS), "call1", None, ctx), node


async def collect(brain, text):
    return [s async for s in brain.reply(text)]


async def test_tool_loop_calls_node_and_streams_answer(cfg):
    llm_requests, node_requests = [], []

    def llm(req):
        body = json.loads(req.content)
        llm_requests.append(body)
        if len(llm_requests) == 1:
            return sse(*tool_chunks("check_calendar", '{"date": "2030-01-01"}'))
        return sse(text_chunk("We have a slot at ten. "), text_chunk("Shall I book it?"))

    def node(req):
        node_requests.append(req)
        return httpx.Response(200, json={"ok": True, "result": {"availableSlots": ["10:00"]}})

    brain, _ = make_brain(cfg, llm, node, {"lead": {"id": "L1", "status": "enquiry"}, "parent": {"fullName": "Asha"}})
    out = await collect(brain, "any slots?")
    assert out == ["We have a slot at ten.", "Shall I book it?"]
    r = node_requests[0]
    assert r.url.path == "/api/v1/agent-api/tools/check_calendar"
    assert r.headers["x-agent-key"] == "test-agent-key"
    assert json.loads(r.content) == {"args": {"date": "2030-01-01"}, "callId": "call1", "leadId": "L1"}
    second = llm_requests[1]["messages"]
    assert second[-1]["role"] == "tool" and second[-2]["tool_calls"][0]["id"] == "c1"
    assert "tools" in llm_requests[0] and "Asha" in llm_requests[0]["messages"][0]["content"]
    assert brain.tool_results[0].ok


async def test_tool_failure_returned_to_model_not_crash(cfg):
    n = {"i": 0}

    def llm(req):
        n["i"] += 1
        if n["i"] == 1:
            return sse(*tool_chunks("book_demo", "{}"))
        msgs = json.loads(req.content)["messages"]
        assert json.loads(msgs[-1]["content"]) == {"ok": False, "error": "slot taken"}
        return sse(text_chunk("Sorry, that slot is gone."))

    brain, _ = make_brain(cfg, llm, lambda r: httpx.Response(200, json={"ok": False, "error": "slot taken"}))
    assert await collect(brain, "book") == ["Sorry, that slot is gone."]
    assert not brain.tool_results[0].ok


async def test_tool_rounds_capped(cfg):
    calls = {"n": 0}

    def llm(req):
        calls["n"] += 1
        body = json.loads(req.content)
        if "tools" in body:
            return sse(*tool_chunks("check_calendar", "{}"))
        return sse(text_chunk("Final answer here."))

    brain, _ = make_brain(cfg, llm, lambda r: httpx.Response(200, json={"ok": True, "result": 1}))
    assert await collect(brain, "x") == ["Final answer here."]
    assert calls["n"] == 4  # 3 tool rounds + a tool-less final round


async def test_llm_errors_surface(cfg):
    brain, _ = make_brain(cfg, lambda r: httpx.Response(500, text="oops"), lambda r: httpx.Response(200, json={}))
    with pytest.raises(LlmError, match="500"):
        await collect(brain, "x")

    def boom(req):
        raise httpx.ConnectError("refused")

    brain, _ = make_brain(cfg, boom, lambda r: httpx.Response(200, json={}))
    with pytest.raises(LlmError):
        await collect(brain, "x")


async def test_node_down_during_tool_raises_toolfailure_and_history_repaired(cfg):
    def node(req):
        raise httpx.ConnectError("down")

    brain, _ = make_brain(cfg, lambda r: sse(*tool_chunks("check_calendar", "{}")), node)
    with pytest.raises(ToolFailure):
        await collect(brain, "x")
    assert not any(m.get("tool_calls") for m in brain.history)  # no dangling tool_calls message


async def test_bad_tool_arguments_reported_to_model(cfg):
    n = {"i": 0}

    def llm(req):
        n["i"] += 1
        if n["i"] == 1:
            return sse(*tool_chunks("check_calendar", "{not json"))
        return sse(text_chunk("Let me retry that."))

    brain, _ = make_brain(cfg, llm, lambda r: pytest.fail("Node must not be called"))
    await collect(brain, "x")
    assert "invalid tool arguments" in brain.tool_results[0].error


async def test_cancellation_keeps_spoken_text_in_history(cfg):
    import asyncio
    brain, _ = make_brain(cfg, lambda r: sse(text_chunk("First sentence is here. "), text_chunk("Second one follows.")), lambda r: None)
    gen = brain.reply("hello")
    first = await gen.__anext__()
    assert first == "First sentence is here."
    with pytest.raises(asyncio.CancelledError):
        await gen.athrow(asyncio.CancelledError())
    assert brain.history[-1]["role"] == "assistant" and "[interrupted]" in brain.history[-1]["content"]


# ---- node_client
def node_client(cfg, handler, **kw):
    return NodeClient(cfg, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), backoff=0, **kw)


async def test_contract_paths_and_shapes(cfg):
    seen = []

    def h(req):
        seen.append((req.method, req.url.path, req.headers.get("x-agent-key")))
        if req.url.path.endswith("/tools"):
            return httpx.Response(200, json={"tools": TOOLS})
        return httpx.Response(200, json={"ok": True})

    n = node_client(cfg, h)
    assert await n.get_tools() == TOOLS
    await n.get_persona()
    await n.identify("98765 43210")
    await n.post_call_log({"callId": "a"})
    assert [(m, p) for m, p, _ in seen] == [
        ("GET", "/api/v1/agent-api/tools"), ("GET", "/api/v1/agent-api/persona"),
        ("POST", "/api/v1/agent-api/calls/identify"), ("POST", "/api/v1/agent-api/call-log"),
    ]
    assert {k for _, _, k in seen} == {"test-agent-key"}


async def test_call_log_201_and_200_both_sent(cfg):
    for code in (201, 200):
        n = node_client(cfg, lambda r, c=code: httpx.Response(c, json={}))
        assert await n.post_call_log({"callId": "a"}) == "sent"
        assert n.spool_pending() == 0


async def test_call_log_spooled_when_node_down_then_flushed(cfg):
    up = {"v": False}
    seen = []

    def h(req):
        if not up["v"]:
            raise httpx.ConnectError("down")
        seen.append(json.loads(req.content)["callId"])
        return httpx.Response(201, json={})

    n = node_client(cfg, h)
    assert await n.post_call_log({"callId": "a", "transcript": [{"role": "caller", "text": "வணக்கம்"}]}) == "spooled"
    assert await n.post_call_log({"callId": "b"}) == "spooled"
    assert n.spool_pending() == 2
    assert await n.flush_spool() == {"sent": 0, "remaining": 2}  # still down: nothing lost
    up["v"] = True
    assert await n.flush_spool() == {"sent": 2, "remaining": 0}
    assert seen == ["a", "b"] and n.spool_pending() == 0


async def test_call_log_5xx_spools_and_retries(cfg):
    attempts = {"n": 0}

    def h(req):
        attempts["n"] += 1
        return httpx.Response(502, text="bad gateway")

    n = node_client(cfg, h, retries=2)
    assert await n.post_call_log({"callId": "a"}) == "spooled"
    assert attempts["n"] == 3


async def test_call_log_503_unconfigured_node_spools(cfg):
    n = node_client(cfg, lambda r: httpx.Response(503, json={"error": "unset"}))
    assert await n.post_call_log({"callId": "a"}) == "spooled"


async def test_call_log_400_parked_not_retried_forever(cfg):
    n = node_client(cfg, lambda r: httpx.Response(400, json={"error": "bad"}))
    assert await n.post_call_log({"callId": "a"}) == "rejected"
    assert n.spool_pending() == 0 and n.rejected_path.exists()


async def test_call_log_unknown_lead_resent_without_lead(cfg):
    bodies = []

    def h(req):
        b = json.loads(req.content)
        bodies.append(b)
        return httpx.Response(404, json={"error": "Lead not found"}) if "leadId" in b else httpx.Response(201, json={})

    n = node_client(cfg, h)
    assert await n.post_call_log({"callId": "a", "leadId": "x"}) == "sent"
    assert "leadId" not in bodies[-1]


async def test_run_tool_semantics(cfg):
    n = node_client(cfg, lambda r: httpx.Response(200, json={"ok": False, "error": "denied"}))
    assert await n.run_tool("x", {}, "c") == {"ok": False, "error": "denied"}
    n = node_client(cfg, lambda r: httpx.Response(404, json={"ok": False, "error": "Unknown tool"}))
    assert (await n.run_tool("x", {}, "c"))["ok"] is False
    n = node_client(cfg, lambda r: httpx.Response(503, json={"error": "unset"}))
    with pytest.raises(NodeError):
        await n.run_tool("x", {}, "c")


async def test_persona_cache_and_hard_failure(cfg):
    calls = {"n": 0}
    state = {"down": False}

    def h(req):
        if state["down"]:
            raise httpx.ConnectError("down")
        calls["n"] += 1
        if req.url.path.endswith("/persona"):
            return httpx.Response(200, json={"systemPrompt": "S", "greeting": "G", "languages": ["en"]})
        return httpx.Response(200, json={"tools": TOOLS})

    now = {"t": 0.0}
    p = PersonaProvider(node_client(cfg, h), ttl=60, clock=lambda: now["t"])
    a = await p.get()
    assert a.greeting == "G" and a.tools == TOOLS
    await p.get()
    assert calls["n"] == 2  # cached
    state["down"] = True
    assert (await p.get()) is a  # still within TTL
    now["t"] = 61
    with pytest.raises(PersonaUnavailable):
        await p.get()


async def test_persona_missing_fields_rejected(cfg):
    p = PersonaProvider(node_client(cfg, lambda r: httpx.Response(200, json={"tools": []} if r.url.path.endswith("tools") else {"systemPrompt": ""})))
    with pytest.raises(PersonaUnavailable):
        await p.get()
