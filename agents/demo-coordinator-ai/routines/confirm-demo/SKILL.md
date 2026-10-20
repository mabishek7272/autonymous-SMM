---
name: confirm-demo
description: Ingests parent reply to reminders to confirm attendance or facilitate slot rescheduling.
---

# Routine: Confirm Demo

## Objective
Process parent WhatsApp replies following a reminder message, confirming their commitment or adjusting the schedule.

## Execution Steps
1. Parse parent reply:
   - If affirmative ("YES", "CONFIRM", "Will be there", "Ok"):
     - Send acknowledgement and encouragement.
     - Note confirmation in audit log.
   - If requesting reschedule ("Can we change to 4pm?", "Not available tomorrow"):
     - Query new slots via `check_calendar`.
     - Propose alternative slots.
     - Update appointment upon parent agreement.
2. Log action in `ai_activity_log`.
