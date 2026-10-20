---
name: qualify-lead
description: Conversational qualification to capture class, board, subjects, and study challenges.
---

# Routine: Qualify Lead

## Objective
Extract key educational details from the parent without overwhelming them, then transition the lead from `enquiry` to `qualified`.

## Required Fields to Gather
- **Class / Grade**: e.g., Class 10, Grade 9
- **Board**: CBSE, ICSE, State Board, IB
- **Subjects**: Mathematics, Science, Physics, Chemistry, etc.
- **Specific Needs**: Exam preparation, concept clarity, homework assistance

## Execution Protocol
1. Evaluate conversation context for missing fields.
2. Ask only ONE question at a time.
3. When class and board are identified, query for target subjects.
4. Once minimum viable qualification data is acquired, execute tool:
   ```json
   {
     "tool": "qualify_lead",
     "arguments": {
       "leadId": "<leadId>",
       "gradeInterested": "<grade>",
       "boardInterested": "<board>",
       "subjectsInterested": ["<subjects>"],
       "requirements": "<requirements>"
     }
   }
   ```
5. Follow up immediately by checking calendar availability via `check_calendar` and offering a complimentary 1-on-1 demo session.
