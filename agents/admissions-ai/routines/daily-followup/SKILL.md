---
name: daily-followup
description: Daily morning routine to re-engage stalled enquiry leads after 48 hours of silence.
---

# Routine: Daily Follow-up

## Schedule
- **Days**: Monday to Saturday
- **Time**: 10:00 AM IST (Window: 09:45 - 11:30 AM)
- **Max Execution Budget**: 20 minutes

## Execution Protocol
1. Scan for leads where:
   - `status == 'enquiry'`
   - `updatedAt <= NOW() - 48 hours`
   - Total follow-up messages sent < 3
2. Compose a personalized, zero-pressure re-engagement message.
3. Queue message through `whatsappQueue`.
4. Log activity as `actionType: 'daily_followup_sent'`.
5. Update lead `updatedAt` timestamp.
6. If 3 follow-ups have been sent without any reply, escalate lead to the Founder/Admin review queue.
