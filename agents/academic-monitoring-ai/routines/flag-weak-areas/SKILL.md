---
name: flag-weak-areas
description: Institution-wide Friday scan to identify RED and YELLOW students and formulate remedial guidance.
---

# Routine: Flag Weak Areas

## Schedule
- **Frequency**: Weekly on Friday at 18:00 IST
- **Scope**: All active enrolled students

## Execution Protocol
1. Execute `academicMonitoringService.scanAllStudents()`.
2. Segment active students into `GREEN`, `YELLOW`, and `RED` cohorts.
3. For all `RED` cohort students:
   - Extract primary problem subjects (scores < 50%).
   - Compile remedial action items.
   - Log entry in `ai_activity_log` with `actionType: 'student_health_flagged_red'`.
4. Provide summary count to `ChiefOfStaffAI` for the founder's academic health briefing.
