---
name: funnel-analytics
description: Calculate conversion velocities, drop-offs, and channel ROI across admissions pipeline
---

# Routine: funnel-analytics

## Goal
Compute full admissions conversion funnel metrics and stage drop-offs.

## Execution Steps
1. Query counts of leads in each stage: `enquiry`, `qualified`, `demo_scheduled`, `converted`, `lost`.
2. Compute stage-to-stage transition conversion rates:
   - Enquiry to Qualified rate
   - Qualified to Demo Scheduled rate
   - Demo Scheduled to Converted (Enrolled) rate
   - Overall End-to-End conversion rate
3. Package metrics into an analytics object for dashboard visualization.
4. Record computation event in `ai_activity_log`.
