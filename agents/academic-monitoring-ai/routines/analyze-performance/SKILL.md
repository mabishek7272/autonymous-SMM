---
name: analyze-performance
description: Ingests new test results, updates subject averages, and checks for sudden performance drops.
---

# Routine: Analyze Performance

## Trigger
Event-driven trigger whenever a teacher submits new test records or attendance logs via the Teacher Portal.

## Inputs
- `studentId`: UUID of student
- `subject`: Subject name (e.g., Mathematics)
- `markObtained`: Marks scored
- `totalMarks`: Maximum marks possible
- `attendancePercentage`: Attendance recorded

## Execution Protocol
1. Retrieve historical marks in this subject for the student.
2. Calculate moving average and percentage change from previous assessment.
3. If new percentage is < 50%, flag subject as `WEAK`.
4. If attendance is < 75%, flag attendance warning.
5. Record update to student diagnostic cache.
