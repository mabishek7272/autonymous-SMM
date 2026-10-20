# Runbook

Commands assume the repo root and the Compose stack. Container names: `ekalavya_postgres`, `ekalavya_redis`, `ekalavya_backend`, `ekalavya_evolution_go`, `ekalavya_evolution_postgres`, `ekalavya_frontend`, `ekalavya_call_agent`.

## Health checks

```bash
curl -s localhost:3001/health            # postgres + redis; 503 when degraded
docker compose ps
curl -s -H "Authorization: Bearer $TOKEN" localhost:3001/api/v1/messages/status   # WhatsApp link state
curl -s -H "Authorization: Bearer $TOKEN" localhost:3001/api/v1/dev/voice/status  # superadmin only
```

## Backups (pg_dump)

Back up both application data and the WhatsApp session store. Losing the Evolution GO volumes means re-pairing the phone.

```bash
mkdir -p backups
docker compose exec -T postgres pg_dump -U ekalavya_user -d ekalavya_db -Fc > backups/ekalavya_$(date +%F).dump
docker compose exec -T evolution-postgres pg_dump -U evolution -d evogo_auth  -Fc > backups/evogo_auth_$(date +%F).dump
docker compose exec -T evolution-postgres pg_dump -U evolution -d evogo_users -Fc > backups/evogo_users_$(date +%F).dump
```

Schedule it with cron on the host, copy dumps off the machine, and test a restore periodically. Redis holds only queue state and locks (AOF is enabled); it is not a system of record.

## Restore

```bash
docker compose stop backend
docker compose exec -T postgres psql -U ekalavya_user -d postgres -c "DROP DATABASE IF EXISTS ekalavya_db;" -c "CREATE DATABASE ekalavya_db OWNER ekalavya_user;"
docker compose exec -T postgres pg_restore -U ekalavya_user -d ekalavya_db --no-owner < backups/ekalavya_YYYY-MM-DD.dump
docker compose start backend      # runs `prisma migrate deploy` on boot
```

Restore into a scratch database first if you are unsure. Restoring Evolution GO databases follows the same pattern; stop `evolution-go` first.

## Rotating the JWT secret

1. Generate: `openssl rand -base64 32`.
2. Set `JWT_SECRET` in `backend/.env`.
3. `docker compose up -d backend`.

All existing staff sessions become invalid immediately; everyone must log in again. There is no dual-key grace period.

## Rotating the agent key (voice)

`EKALAVYA_AGENT_KEY` must be identical in `backend/.env` and `backend/call_agent/.env`.

1. `openssl rand -hex 32`.
2. Update both files.
3. `docker compose up -d backend` then `docker compose --profile voice up -d call-agent`.

Between the two restarts voice tool calls fail with 401; do it between calls. To disable the internal API entirely, unset the variable: the routes then answer 503. Rotate `CALL_AGENT_API_KEY` the same way (clients of the call agent must be updated too).

## WhatsApp disconnected

1. `GET /api/v1/messages/status` shows `disconnected`, `unreachable` or `not_configured`.
2. `unreachable`: `docker compose ps evolution-go`, `docker compose logs --tail=100 evolution-go`; restart with `docker compose restart evolution-go`.
3. `not_configured`: `EVOLUTION_GO_API_KEY` is empty in `backend/.env`.
4. `disconnected` (phone logged out or session expired): open the Manager UI (`http://localhost:8081/manager` via the dev override, or an SSH tunnel in production), reconnect and scan the QR code. If the instance is gone, recreate it with the same token (see README, WhatsApp pairing).
5. Messages queued while disconnected retry (3 attempts, exponential backoff). Failed sends are recorded on the `Message` row as `failed:<reason>`; check `GET /api/v1/messages` and the queue before re-sending anything so parents do not receive duplicates.
6. **`connected: true` but nothing inbound ever arrives (no replies, no delivery receipts):** this means Evolution GO's webhook dispatch is broken, not the connection. Confirm with `docker compose logs evolution-go | grep "DISPATCHING WEBHOOK"` (events ARE being generated) vs `docker compose logs backend | grep webhooks/evolution-go` (nothing arrives). Two known causes, both already fixed in this stack's `docker-compose.yml` — only relevant if you rebuilt the gateway from scratch or restored an old instance:
   - **`evolution-rabbitmq` isn't running or `AMQP_URL` isn't set.** This build requires RabbitMQ to actually deliver webhook HTTP calls; without it every event is logged as dispatched and then silently dropped. `docker compose up -d evolution-rabbitmq` then `docker compose restart evolution-go`; confirm with `docker compose logs evolution-go | grep "RabbitMQ enabled"`.
   - **The instance's `webhook` column is empty**, usually because it was created through the Manager UI by hand rather than via `POST /instance/create`. Check with the global key: `curl -H "apikey: $EVOLUTION_GO_GLOBAL_API_KEY" localhost:8081/instance/all`. If `"webhook": ""`, fix it directly: `docker compose exec evolution-postgres psql -U evolution -d evogo_users -c "update instances set webhook='http://backend:3001/webhooks/evolution-go' where id='<id>'"`, then `docker compose restart evolution-go`. This does not require re-pairing the phone.

## Re-running a failed weekly report send

Reports go `draft -> approved -> sent`, or `failed` if enqueueing failed.

1. List: `GET /api/v1/reports?status=failed`.
2. Fix the cause (usually WhatsApp down or missing parent number).
3. Retry one: `POST /api/v1/reports/:id/send`. A `failed` report may be re-sent; `draft` (not approved) and `sent` (already delivered) are refused with 409.
4. The Saturday 17:00 job only sends `approved` reports and is claimed once per day, so it will not run again by itself. To send remaining approved reports now, call `POST /api/v1/reports/send-approved`.
5. Per-report sends are locked (`weekly-report:send-one:<id>`, 120 s) so double clicks cannot send twice.

If Saturday generation was missed (API down at 10:00 IST), run `POST /api/v1/reports/generate`.

## How the schedulers use Redis

- `withRedisLock(key, ttl, fn)`: `SET lock:<key> <token> EX ttl NX`; released only if the token still matches (Lua compare-and-delete). Used by the reminder-rule tick (`reminder-rules:tick`, 25 s), weekly send (`weekly-report:send`, 30 min) and per-report sends.
- `claimOnce(key, ttl)`: `SET once:<key> 1 EX ttl NX`, never released. Guarantees a Saturday job fires once per IST date across instances (`once:weekly-report:generate:<date>`, `once:weekly-report:send:<date>`, 6 h TTL).
- Class links use their own lock key plus `classlink:daily:<date>` (36 h) to announce the daily batch once, deleting the key if the run fails so the next tick retries.
- Consequence: if Redis is down, schedulers do not fire and the WhatsApp worker does not start. Restart the backend after Redis is back.
- To clear a stuck claim deliberately: `docker compose exec redis redis-cli DEL once:weekly-report:send:YYYY-MM-DD` (only if you are sure nothing was sent).

## Logs

| What | Where |
|---|---|
| Backend app logs | container stdout (`docker compose logs -f backend`); files `backend/logs/combined.log` and `backend/logs/error.log` (bind-mounted) |
| HTTP access log | morgan, into the same Winston stream |
| Evolution GO | `docker compose logs evolution-go`; volume `evolution_logs` |
| Call agent | container stdout (`docker compose logs call-agent`) |
| Agent actions | table `ai_activity_log`; `GET /api/v1/agents/activity-log` |

Rotate `backend/logs/*` with host logrotate; the app does not rotate them.

## Upgrades

`docker compose up -d --build backend frontend`. Migrations run on backend start. Back up first. Pin `EVOLUTION_GO_IMAGE` and test gateway upgrades against a spare number.

## Login OTP (email codes)

- **How it works:** `POST /auth/login` checks the password and emails a 6-digit code from `security@e-kalavya.com`; `POST /auth/verify-otp` redeems it for the real session JWT. The code expires in 10 minutes, locks after 5 wrong attempts, and `POST /auth/resend-otp` invalidates the previous code before issuing a new one.
- **Someone is locked out (too many attempts / expired code):** they just sign in again from the login page; a fresh code is emailed automatically.
- **A mailbox can't receive the code:** check `GET /api/v1/messages/status` → `email.enabled`; if email is down, WhatsApp-only features still work but nobody can log in (there is no bypass in production). Fix the Resend configuration, then have the user sign in again.
- **Dev/test accounts:** emails listed in `DEV_OTP_BYPASS_EMAILS` (comma-separated) get a fixed code — `DEV_OTP_CODE`, default `654321` — instead of a real email, and nothing is sent to Resend for them. This must be empty in production; it exists only so local dev and CI don't depend on a mailbox.
- **Old OTP rows:** `login_otps` accumulates one row per login attempt. `pruneExpiredOtps()` in `login-otp.service.ts` deletes rows older than 24h; wire it to a cron if the table grows large (it is small and harmless to leave unpruned).

## Email (Resend)

- **Where it is configured:** `RESEND_API_KEY` and `EMAIL_DOMAIN` in `backend/.env`. The sending domain (`e-kalavya.com`) must show *Verified* in the Resend dashboard; the four senders (`hello@`, `reports@`, `security@`, `no-reply@`) need no separate setup.
- **Is it working?** The header shows *Email on · e-kalavya.com*; `GET /api/v1/messages/status` returns an `email` block. Sent/failed state of every email is in the `messages` table (`channel = 'email'`, `status` = `queued` / `sent` / `failed:*`, `external_id = resend:<id>`); the Resend dashboard *Emails* page shows bounces and complaints.
- **Rotate the API key:** create a new key in Resend, put it in `backend/.env`, restart the backend, then delete the old key in Resend. Use a *sending access* key in production (the setup key can be full access).
- **Failed emails:** the worker retries 4 times with exponential back-off (rate limits and 5xx). A rejected address fails immediately with `failed:email_error`; fix the parent's email and re-send from the report/lead screen.
- **Pause email without code changes:** set `EMAIL_ENABLED=false` (or empty the key) and restart; WhatsApp is unaffected.
- **Replies:** `hello@`, `reports@` and `security@` set a Reply-To to the same address, so a mailbox for each must exist at your mail provider. `no-reply@` has none.
