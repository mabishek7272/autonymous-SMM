---
name: book-demo
description: Reserves demo slot, creates appointment record in database, and issues WhatsApp confirmation.
---

# Routine: Book Demo

## Objective
Convert parent agreement into a confirmed demo appointment in the database and issue a clear calendar invite/message.

## Execution Steps
1. Call `check_calendar` for the desired date to confirm slot availability.
2. If slot is open, call `book_demo`:
   ```json
   {
     "tool": "book_demo",
     "arguments": {
       "leadId": "<leadId>",
       "scheduledAt": "2026-10-15T10:00:00.000Z",
       "durationMinutes": 30
     }
   }
   ```
3. Update lead status in PostgreSQL to `demo_scheduled`.
4. Send an immediate WhatsApp confirmation with time, date, platform link, and preparation tips.
5. Log activity as `actionType: 'tool_book_demo'` in `ai_activity_log`.
