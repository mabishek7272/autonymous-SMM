---
name: weekly-progress-report
description: Generate and distribute structured WhatsApp progress reports to all enrolled student parents every Saturday
---

# Routine: weekly-progress-report

## Goal
Automate the compilation and WhatsApp delivery of weekly academic report cards to parents of active students.

## Execution Steps
1. Query all students with status `active` and verified parent WhatsApp number.
2. For each student:
   - Call `academicMonitoringService.analyzeStudent(studentId)` to get subject breakdown, attendance average, and overall health status (GREEN / YELLOW / RED).
   - Format a WhatsApp card highlighting strong areas, weak areas, and teacher/AI recommendations.
   - Dispatch message via `enqueueWhatsApp`.
   - Record log in `ai_activity_log` with status `success`.
3. Report summary of completed dispatches to Chief of Staff AI.
