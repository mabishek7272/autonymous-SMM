import asyncio

from call_agent.persona import Persona, PersonaUnavailable
from call_agent.stt import SttResult
from call_agent.tts import TtsAudio, TtsError


class FakeNode:
    def __init__(self, ctx=None):
        self.ctx = ctx
        self.logs = []
        self.identified = []

    async def identify(self, phone):
        self.identified.append(phone)
        return self.ctx

    async def post_call_log(self, payload):
        self.logs.append(payload)
        return "sent"


class FakePersonaProvider:
    def __init__(self, fail=False):
        self.fail = fail

    async def get(self):
        if self.fail:
            raise PersonaUnavailable("node down")
        return Persona("SYSTEM", "Hello, I am an automated assistant; this call may be transcribed.", ["ta", "en"], [])


class FakeStt:
    def __init__(self, text="hi there", delay=0.0, error=None):
        self.text, self.delay, self.error = text, delay, error
        self.calls = []
        self.status = "ready"

    async def transcribe(self, pcm):
        self.calls.append(len(pcm))
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        return SttResult(self.text, "en", len(pcm) / 32000, 0.0)


class FakeTts:
    def __init__(self, enabled=True, fail=False, delay=0.0, rate=24000):
        self.enabled, self.fail, self.delay, self.rate = enabled, fail, delay, rate
        self.name, self.status = "fake", "ready"
        self.texts = []

    async def synthesize(self, text):
        self.texts.append(text)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            raise TtsError("boom")
        return TtsAudio(b"\x01\x00" * 2400, self.rate)  # 100 ms

    async def aclose(self):
        pass


class FakeBrain:
    """reply() yields scripted sentences; a gate can block it to simulate a slow LLM."""

    def __init__(self, sentences=("Sure.", "Anything else?"), gate=None, error=None):
        self.sentences, self.gate, self.error = list(sentences), gate, error
        self.tool_results = []
        self.added = []
        self.inputs = []
        self.cancelled = False

    def add_assistant(self, t):
        self.added.append(t)

    async def reply(self, text, language=None):
        self.inputs.append((text, language))
        try:
            if self.error:
                raise self.error
            for s in self.sentences:
                if self.gate is not None:
                    await self.gate.wait()
                yield s
        except asyncio.CancelledError:
            self.cancelled = True
            raise
