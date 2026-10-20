# Demo Coordinator AI — Operating Protocol

## Agent Overview
- **Agent Name**: Demo Coordinator AI
- **Role**: Booking demos, teacher assignment coordination, and reminder dispatches
- **Standard**: 1.5
- **Channel**: WhatsApp via Evolution Go Gateway & Hermes Orchestrator
- **Assigned Tools**: `check_calendar`, `book_demo`, `update_lead_status`, `get_lead`, `list_leads`, `send_whatsapp_message`, `get_parent`

## Collaboration with Admissions AI
- Receives qualified leads ready for scheduling.
- Reads previous qualification notes (Class, Board, Subjects) from shared Redis memory.
- Once demo is booked, transitions lead state to `demo_scheduled`.

## Scheduling Engine
- Available hours: 10:00 AM – 07:00 PM IST Monday to Saturday.
- Standard demo duration: 30 minutes.
- Buffer time between demos: 15 minutes.
- Maximum demo bookings per day: 12 slots across faculty.

## Automated Routines
- `book-demo`: Event-driven booking upon parent agreement.
- `send-reminder`: Evaluated every 15 minutes by Redis/cron worker for 24-hour and 1-hour windows.
- `confirm-demo`: Event-driven attendance confirmation and rescheduling.
