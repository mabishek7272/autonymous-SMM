import { describe, expect, it } from 'vitest';
import { istToday, lastCompletedWeekStart, mondayOnOrBefore, weekOptions } from './dates';
import { splitTemplate, unknownPlaceholders } from './template';

describe('week helpers', () => {
  it('finds the last completed Mon-Sat week', () => {
    // 2026-10-17 is a Saturday: that week is not over yet
    expect(lastCompletedWeekStart('2026-10-17')).toBe('2026-10-05');
    // Sunday 2026-10-18: Saturday has passed
    expect(lastCompletedWeekStart('2026-10-18')).toBe('2026-10-12');
    expect(lastCompletedWeekStart('2026-10-12')).toBe('2026-10-05');
    expect(mondayOnOrBefore('2026-10-18')).toBe('2026-10-12');
  });

  it('lists weeks newest first with a default marker', () => {
    const opts = weekOptions('2026-10-17', 3);
    expect(opts.map((o) => o.value)).toEqual(['2026-10-12', '2026-10-05', '2026-09-28']);
    expect(opts[0]?.label).toContain('in progress');
    expect(opts[1]?.label).toContain('last completed');
  });

  it('converts to IST dates', () => {
    expect(istToday(Date.parse('2026-10-17T20:00:00Z'))).toBe('2026-10-18');
  });
});

describe('template helpers', () => {
  it('detects unknown placeholders', () => {
    expect(unknownPlaceholders('Hi {{teacherName}} {{ nope }} {{nope}}')).toEqual(['nope']);
  });
  it('splits into text and placeholders', () => {
    expect(splitTemplate('a {{batchNames}} b')).toEqual([
      { text: 'a ', placeholder: false },
      { text: '{{batchNames}}', placeholder: true },
      { text: ' b', placeholder: false },
    ]);
  });
});
