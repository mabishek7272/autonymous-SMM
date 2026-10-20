---
name: parent-inquiry
description: Handle incoming parent WhatsApp queries regarding their enrolled child's progress, attendance, and schedules
---

# Routine: parent-inquiry

## Goal
Provide prompt, respectful, and accurate answers to incoming parent queries over WhatsApp regarding their child's academic journey.

## Execution Steps
1. Match the parent's phone number against existing `Parent` records to identify linked student(s).
2. Interpret the parent's intent:
   - Attendance check: Return attendance percentage and missed dates.
   - Test scores: Return latest test result and syllabus topic.
   - Schedule query: Return batch timing and assigned teacher.
   - Escalation/grievance: Acknowledge with empathy and flag for human institute coordinator.
3. Keep responses clear, warm, and within 100 words.
4. Record interaction in `ai_activity_log`.
