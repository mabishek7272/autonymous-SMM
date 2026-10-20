---
name: daily-briefing
description: Synthesizes daily KPI briefing and WhatsApp summary to Founder at 8:00 AM
---

# Routine: daily-briefing

## Goal
Generate and deliver a concise, high-impact operational digest to the institute founder each morning.

## Prerequisites
- Target founder WhatsApp number configured (`FOUNDER_WHATSAPP_NUMBER`).
- Database and Redis operational.

## Execution Steps
1. Call `get_founder_kpis` tool to query:
   - Funnel totals (total leads, qualified leads, demos scheduled, enrolled).
   - Active student count and cohort health split (Green/Yellow/Red).
   - Total AI workforce actions in the last 24 hours.
   - Any unhandled exceptions or pending HITL items.
2. Format text using WhatsApp markdown standards (`*bold*`, `• bullets`, section dividers).
3. Call `send_whatsapp_message` to founder with the formatted text.
4. Log execution event in `ai_activity_log` with status `success`.
