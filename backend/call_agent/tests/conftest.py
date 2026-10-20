import pathlib
import sys

import pytest

# make `call_agent` importable when pytest is started from backend/ or backend/call_agent/
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from call_agent.config import Config  # noqa: E402
from call_agent.node_client import NodeClient  # noqa: E402


@pytest.fixture
def cfg(tmp_path):
    return Config(
        api_key="test-api-key",
        agent_key="test-agent-key",
        ekalavya_api_url="http://node.invalid/api/v1",
        ollama_model="fake",
        spool_dir=str(tmp_path / "spool"),
        max_call_seconds=30,
    )
