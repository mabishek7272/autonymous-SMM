import { describe, expect, it } from 'vitest';
import { LEAD_STAGES, LEAD_STATUSES, isAdmissible, nextStageLabel, nextStatus, stageLabel, statusForLabel } from './lead-stages';

describe('lead stages', () => {
  it('maps the 7 UI labels to the 7 backend statuses one-to-one', () => {
    expect(LEAD_STAGES.map((s) => s.label)).toEqual(['New', 'Contacted', 'Interested', 'Demo Booked', 'Follow-up', 'Admission', 'Lost']);
    expect(LEAD_STAGES.map((s) => s.status)).toEqual([...LEAD_STATUSES]);
    expect(stageLabel('qualified')).toBe('Interested');
    expect(statusForLabel('Admission')).toBe('converted');
    expect(statusForLabel('Demo Booked')).toBe('demo_scheduled');
  });

  it('advances like the prototype: Lost re-opens, Admission ends the board', () => {
    expect(nextStatus('enquiry')).toBe('contacted');
    expect(nextStatus('follow_up')).toBe('converted');
    expect(nextStatus('converted')).toBeNull();
    expect(nextStatus('lost')).toBe('enquiry');
    expect(nextStageLabel('contacted')).toBe('Interested');
  });

  it('mirrors the backend admissible statuses', () => {
    expect(isAdmissible('enquiry')).toBe(false);
    expect(isAdmissible('contacted')).toBe(false);
    expect(isAdmissible('lost')).toBe(false);
    expect(isAdmissible('qualified')).toBe(true);
    expect(isAdmissible('converted')).toBe(true);
  });

  it('uses the prototype colours for follow-up, admission and lost', () => {
    const by = Object.fromEntries(LEAD_STAGES.map((s) => [s.status, s.dot]));
    expect(by.follow_up).toBe('#F97316');
    expect(by.converted).toBe('#059669');
    expect(by.lost).toBe('#CBD5E1');
    expect(by.enquiry).toBe('#7C3AED');
  });
});
