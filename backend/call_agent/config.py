"""Runtime configuration read from the environment (validated at startup)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Optional

PACKAGE_DIR = Path(__file__).resolve().parent

LLM_PROVIDERS = ("ollama", "openai", "openrouter")
TTS_PROVIDERS = ("google", "mms", "none")
STT_LANGUAGES = ("auto", "ta", "en")


class ConfigError(Exception):
    """Raised at startup when the environment is incomplete or invalid."""

    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("Invalid call agent configuration:\n  - " + "\n  - ".join(problems))


def load_dotenv(path: Path, environ: dict) -> None:
    """Tiny .env reader. Never overrides variables already set in the environment."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if value[:1] in ('"', "'") and value[-1:] == value[:1] and len(value) >= 2:
            value = value[1:-1]
        elif " #" in value or value.startswith("#"):
            value = value.split("#", 1)[0].strip()  # inline comment on an unquoted value
        key = key.strip()
        if key and key not in environ:
            environ[key] = value


@dataclass
class Config:
    api_key: str = ""
    ekalavya_api_url: str = "http://localhost:3001/api/v1"
    agent_key: str = ""
    llm_provider: str = "ollama"
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = ""
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    openrouter_api_key: str = ""
    openrouter_model: str = ""
    tts_provider: str = "none"
    google_tts_api_key: str = ""
    google_tts_voice_ta: str = "ta-IN-Wavenet-A"
    google_tts_voice_en: str = "en-IN-Wavenet-A"
    whisper_model_path: str = str((PACKAGE_DIR / ".." / "model" / "whisper-tamil-small").resolve())
    stt_language: str = "auto"
    stt_device: str = "cpu"
    max_call_seconds: int = 900
    max_frame_bytes: int = 64000
    tts_sample_rate: int = 24000
    cors_origins: list[str] = field(default_factory=list)
    twilio_auth_token: str = ""
    twilio_stream_enabled: bool = False
    twilio_stream_url: str = ""
    spool_dir: str = str(PACKAGE_DIR / "spool")
    vad_energy_threshold: float = 0.015
    vad_silence_ms: int = 600

    def validate(self) -> list[str]:
        p: list[str] = []
        if not self.api_key:
            p.append("CALL_AGENT_API_KEY is required (it authenticates every REST and WebSocket client)")
        if not self.agent_key:
            p.append("EKALAVYA_AGENT_KEY is required (shared secret for the Node /agent-api routes)")
        if not self.ekalavya_api_url.startswith(("http://", "https://")):
            p.append("EKALAVYA_API_URL must start with http:// or https://")
        if self.llm_provider not in LLM_PROVIDERS:
            p.append(f"LLM_PROVIDER must be one of {', '.join(LLM_PROVIDERS)} (got '{self.llm_provider}')")
        elif self.llm_provider == "ollama" and not self.ollama_model:
            p.append("OLLAMA_MODEL is required when LLM_PROVIDER=ollama")
        elif self.llm_provider == "openai" and not self.openai_api_key:
            p.append("OPENAI_API_KEY is required when LLM_PROVIDER=openai")
        elif self.llm_provider == "openrouter":
            if not self.openrouter_api_key:
                p.append("OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter")
            if not self.openrouter_model:
                p.append("OPENROUTER_MODEL is required when LLM_PROVIDER=openrouter")
        if self.tts_provider not in TTS_PROVIDERS:
            p.append(f"TTS_PROVIDER must be one of {', '.join(TTS_PROVIDERS)} (got '{self.tts_provider}')")
        elif self.tts_provider == "google" and not self.google_tts_api_key:
            p.append("GOOGLE_TTS_API_KEY is required when TTS_PROVIDER=google")
        if self.stt_language not in STT_LANGUAGES:
            p.append(f"STT_LANGUAGE must be one of {', '.join(STT_LANGUAGES)} (got '{self.stt_language}')")
        if self.max_call_seconds <= 0:
            p.append("MAX_CALL_SECONDS must be a positive integer")
        if self.twilio_stream_enabled and not self.twilio_auth_token:
            p.append("TWILIO_AUTH_TOKEN is required when TWILIO_STREAM_ENABLED=true")
        return p

    def require_valid(self) -> "Config":
        problems = self.validate()
        if problems:
            raise ConfigError(problems)
        return self

    # Convenience for the LLM client
    def llm_settings(self) -> tuple[str, str, str]:
        """(base_url, api_key, model) for the OpenAI-compatible endpoint."""
        if self.llm_provider == "openai":
            return "https://api.openai.com/v1", self.openai_api_key, self.openai_model
        if self.llm_provider == "openrouter":
            return "https://openrouter.ai/api/v1", self.openrouter_api_key, self.openrouter_model
        return self.ollama_base_url.rstrip("/") + "/v1", "", self.ollama_model


def _int(env: Mapping[str, str], key: str, default: int, problems: list[str]) -> int:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        problems.append(f"{key} must be an integer (got '{raw}')")
        return default


def _float(env: Mapping[str, str], key: str, default: float, problems: list[str]) -> float:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        problems.append(f"{key} must be a number (got '{raw}')")
        return default


def from_env(env: Optional[Mapping[str, str]] = None, *, dotenv: bool = True) -> Config:
    """Build a Config from the environment. Does not validate completeness (see require_valid)."""
    if env is None:
        merged = dict(os.environ)
        if dotenv:
            load_dotenv(PACKAGE_DIR / ".env", merged)
        env = merged
    problems: list[str] = []
    d = Config()
    cfg = Config(
        api_key=env.get("CALL_AGENT_API_KEY", ""),
        ekalavya_api_url=env.get("EKALAVYA_API_URL", d.ekalavya_api_url).rstrip("/"),
        agent_key=env.get("EKALAVYA_AGENT_KEY", ""),
        llm_provider=env.get("LLM_PROVIDER", d.llm_provider).strip().lower(),
        ollama_base_url=env.get("OLLAMA_BASE_URL", d.ollama_base_url),
        ollama_model=env.get("OLLAMA_MODEL", ""),
        openai_api_key=env.get("OPENAI_API_KEY", ""),
        openai_model=env.get("OPENAI_MODEL", d.openai_model),
        openrouter_api_key=env.get("OPENROUTER_API_KEY", ""),
        openrouter_model=env.get("OPENROUTER_MODEL", ""),
        tts_provider=env.get("TTS_PROVIDER", d.tts_provider).strip().lower(),
        google_tts_api_key=env.get("GOOGLE_TTS_API_KEY", ""),
        google_tts_voice_ta=env.get("GOOGLE_TTS_VOICE_TA", d.google_tts_voice_ta),
        google_tts_voice_en=env.get("GOOGLE_TTS_VOICE_EN", d.google_tts_voice_en),
        stt_language=env.get("STT_LANGUAGE", d.stt_language).strip().lower(),
        stt_device=env.get("STT_DEVICE", d.stt_device).strip().lower(),
        max_call_seconds=_int(env, "MAX_CALL_SECONDS", d.max_call_seconds, problems),
        max_frame_bytes=_int(env, "MAX_FRAME_BYTES", d.max_frame_bytes, problems),
        cors_origins=[o.strip() for o in env.get("CALL_AGENT_CORS_ORIGINS", "").split(",") if o.strip()],
        twilio_auth_token=env.get("TWILIO_AUTH_TOKEN", ""),
        twilio_stream_enabled=env.get("TWILIO_STREAM_ENABLED", "false").strip().lower() == "true",
        twilio_stream_url=env.get("TWILIO_STREAM_URL", ""),
        vad_energy_threshold=_float(env, "VAD_ENERGY_THRESHOLD", d.vad_energy_threshold, problems),
        vad_silence_ms=_int(env, "VAD_SILENCE_MS", d.vad_silence_ms, problems),
    )
    wp = env.get("WHISPER_MODEL_PATH")
    if wp:
        path = Path(wp)
        cfg.whisper_model_path = str(path if path.is_absolute() else (PACKAGE_DIR / path).resolve())
    sp = env.get("CALL_AGENT_SPOOL_DIR")
    if sp:
        cfg.spool_dir = sp
    if problems:
        raise ConfigError(problems)
    return cfg


def load_config(env: Optional[Mapping[str, str]] = None) -> Config:
    """from_env + full validation. Raises ConfigError with every problem listed."""
    return from_env(env).require_valid()
