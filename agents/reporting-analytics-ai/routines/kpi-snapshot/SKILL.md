---
name: kpi-snapshot
description: Generate real-time executive dashboard dataset for founder analytics view
---

# Routine: kpi-snapshot

## Goal
Generate a unified analytics snapshot combining admissions throughput, academic distribution, and digital workforce efficiency.

## Execution Steps
1. Call `get_funnel_metrics` for current admissions pipeline numbers.
2. Call `get_academic_cohorts` for student grade percentiles and weak subject clusters.
3. Query `ai_activity_log` for daily workforce throughput and error rates.
4. Return consolidated JSON structure for frontend rendering.
