# autonymous-SMM

Autonomous admissions & academic-operations automation engine for a coaching institute: a staff
dashboard plus a team of AI agents that run WhatsApp conversations, qualify leads, book demos, and
keep teachers/parents on top of attendance, reports, and class schedules — without a human needing
to be at the keyboard for routine work.

This repo intentionally ships the **automation + dashboard** half of the larger E-Kalavya platform.
The public marketing website/parent portal is a separate project and is not included here.

## What's in here

- **`backend/`** — Express + Prisma API: the AI agent orchestration layer (Hermes), WhatsApp
  gateway adapter, admissions/academics/approvals routes, BullMQ workers, and an optional voice
  call agent (`backend/call_agent/`, Python/FastAPI + Whisper STT).
- **`frontend/`** — The staff dashboard (React/Vite): admissions Kanban, student health, teacher
  portal, reports, approvals queue, activity stream, and a dev console for system configuration.
- **`agents/`** — Role definitions for each AI agent (Admissions, Demo Coordinator, Parent
  Engagement, Academic Monitoring, Reporting & Analytics, Chief of Staff).
- **`docs/`** — Architecture notes, the ops runbook, and voice-agent notes.
- **`docker-compose.yml`** — Full local/production stack (Postgres, Redis, the WhatsApp gateway,
  backend, frontend, and the optional voice agent profile).

## Not in here

- The public Next.js website / parent-student portal frontend.
- Prisma migration history and seed data (schema is present; generate your own migrations with
  `npx prisma migrate dev`).
- Any `.env` files, API keys, or other secrets — copy the `.env.example` files and fill in your own.
- Large model weights (`backend/model/`) — the voice call agent needs Whisper weights placed there
  locally; they're intentionally excluded from version control.

## Getting started

```bash
cp .env.example .env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# edit the .env files with your own database, Redis, LLM provider, and WhatsApp gateway credentials

cd backend && npx prisma migrate dev --name init && cd ..
docker compose up -d
```

See `docs/ARCHITECTURE.md` and `docs/RUNBOOK.md` for the fuller picture, and `docs/VOICE.md` for the
optional voice call agent.
