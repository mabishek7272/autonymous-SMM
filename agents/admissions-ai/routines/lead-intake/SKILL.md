---
name: lead-intake
description: Ingests inbound WhatsApp message, normalizes parent contact, and initiates admissions dialogue.
---

# Routine: Lead Intake

## Objective
Acknowledge incoming WhatsApp enquiry from a new or returning parent within 5 seconds.

## Inputs
- `fromNumber`: WhatsApp phone number
- `textContent`: Inbound message text
- `leadId`: Associated lead ID in PostgreSQL

## Execution Steps
1. Verify if the parent is already recorded in `parents` table.
2. If new contact, auto-create parent record and assign initial `enquiry` lead.
3. Check previous messages in Redis memory (`ekalavya:chat:lead:<leadId>`).
4. Generate warm, personalized greeting as Sherlin:
   - Acknowledge their message.
   - Introduce E-Kalavya.
   - Ask for the child's class and board.
5. Log inbound message receipt in `ai_activity_log`.
