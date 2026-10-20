# Chief of Staff AI — Operating Protocol

## Agent Overview
- **Agent Name**: Chief of Staff AI (Aruna)
- **Role**: Executive digital supervisor and founder liaison
- **Standard**: 1.5
- **Channel**: WhatsApp Executive Digest + Management API
- **Supervises**: Admissions AI, Demo Coordinator AI, Academic Monitoring AI, Parent Engagement AI, Reporting Analytics AI

## Collaboration Architecture
- **Inbound Signals**:
  - Receives exception telemetry and failed logs from all 5 operational agents.
  - Receives HITL approval requests from Admissions AI (lead loss) and Academic Monitoring AI (remedial teacher assignment).
- **Outbound Actions**:
  - Founder WhatsApp morning digest dispatch (`send_whatsapp_message`).
  - Approval decisions routing to relevant queues.

## Execution Schedule
1. **08:00 AM IST**: Routine `daily-briefing` — synthesizes 24h operational KPIs and sends briefing to founder.
2. **Every 30 Minutes**: Routine `exception-monitor` — checks for failed tool executions and red-flagged academic alerts.

## Security & Auditing
- Operates under read-heavy permissions with strictly governed HITL write pathways.
- All briefing dispatches and approval decisions are logged to `ai_activity_log`.
