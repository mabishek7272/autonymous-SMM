---
name: send-reminder
description: Dispatches 24h and 1h proactive reminders to parents for upcoming scheduled demo sessions.
---

# Routine: Send Reminder

## Schedule & Trigger
- **Frequency**: Every 15 minutes
- **Trigger**: Cron job / Redis worker via `reminderService.processDemoReminders()`

## Execution Protocol
1. Scan `appointments` table where:
   - `status == 'scheduled'`
   - `scheduledAt` falls into the 24-hour window (23-25 hours from now) OR the 1-hour window (45-75 minutes from now).
2. Check `ai_activity_log` to verify that the respective reminder (`demo_reminder_24h` or `demo_reminder_1h`) has not already been sent.
3. If unsent, craft formatted WhatsApp reminder and dispatch via `whatsappQueue`.
4. Log record in `ai_activity_log` to prevent duplicate messaging.
