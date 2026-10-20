# Voice call agent. Build context is backend/call_agent (see docker-compose.yml, profile "voice").
# The Whisper weights are NOT baked in: compose mounts ./backend/model/whisper-tamil-small read-only
# at /models/whisper-tamil-small.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# libsndfile/ffmpeg are commonly needed by audio libraries; curl is handy for debugging only.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first for layer caching. CPU-only torch keeps the image far smaller than the CUDA default.
COPY requirements.txt /tmp/requirements.txt
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu -r /tmp/requirements.txt

# The package must live in a directory literally named `call_agent` so `call_agent.server:app` imports.
COPY . /app/call_agent

RUN useradd --system --uid 10001 appuser && chown -R appuser /app
USER appuser

EXPOSE 8085
CMD ["python", "-m", "uvicorn", "call_agent.server:app", "--host", "0.0.0.0", "--port", "8085"]
