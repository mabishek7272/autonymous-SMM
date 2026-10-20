---
name: exception-monitor
description: Inspect agent activity log for failed tools or anomalies
---

# Routine: exception-monitor

## Goal
Audit system health periodically to catch any stuck processes, failed tool calls, or critical student drops before they impact institute operations.

## Execution Steps
1. Call `get_activity_logs` filtering for `status: failure` within the last 1-hour window.
2. For each failure:
   - Identify the source agent, failed tool, and error trace.
   - Record an operational exception item.
3. Check student academic records for any student dropping below 50% average.
4. If high-severity exceptions are found:
   - Surface in the Founder Dashboard Exception Monitor.
   - Dispatch immediate alert if threshold exceeded.
