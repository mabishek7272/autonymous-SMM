import { describe, expect, it } from 'vitest';
import { parseLeadSheet } from './parseLeadSheet';

describe('parseLeadSheet', () => {
  it('reads the enquiry sheet layout, skipping the header and treating dashes as blank', () => {
    const r = parseLeadSheet(
      [
        'Lead Name\tClass\tBoard\tContact No#\tTimeline / Start Plan\tNotes / Subject Needed\tLocation / Alt Contact / Remarks',
        'Chithraa\t10\tCBSE\t7299989912\tWithin 1 Week\tCall again on Wednesday\t—',
        '**Dayana Jober**\t12\tMatric\t9597909703\tJust Enquiring\tDemo at 7:30 on 01/09/2026\tAlt: 9894320907',
        'Sudha Bhaskaran\t10\tCBSE\t9445244497 / 7845606422\tWithin 1 Week\tDiscuss and tell\t—',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { name: 'Chithraa', grade: '10', board: 'CBSE', phone: '7299989912', timeline: 'Within 1 Week', notes: 'Call again on Wednesday', remarks: undefined },
      { name: 'Dayana Jober', grade: '12', board: 'Matric', phone: '9597909703', timeline: 'Just Enquiring', notes: 'Demo at 7:30 on 01/09/2026', remarks: 'Alt: 9894320907' },
      { name: 'Sudha Bhaskaran', grade: '10', board: 'CBSE', phone: '9445244497 / 7845606422', timeline: 'Within 1 Week', notes: 'Discuss and tell', remarks: undefined },
    ]);
  });

  it('parses a markdown table and ignores its separator row', () => {
    const r = parseLeadSheet(['| Lead Name | Class | Board | Contact No# |', '| :--- | :---: | :---: | :--- |', '| **Anushka** | 12 | CBSE | 9043012405 |'].join('\n'));
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ name: 'Anushka', phone: '9043012405' });
  });

  it('reports rows without a name or a usable number', () => {
    const r = parseLeadSheet('\t10\tCBSE\t7299989912\nNo Phone\t10\tCBSE\t—\nLetters\t10\tCBSE\tabc');
    expect(r.rows).toEqual([]);
    expect(r.errors.map((e) => e.line)).toEqual([1, 2, 3]);
    expect(r.errors[0].message).toMatch(/name is missing/i);
    expect(r.errors[1].message).toMatch(/number/);
  });
});
