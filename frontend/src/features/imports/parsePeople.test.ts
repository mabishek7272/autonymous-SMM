import { describe, expect, it } from 'vitest';
import { parseStudentSheet, parseTeacherSheet } from './parsePeople';
import { TEMPLATES } from './templates';
import { buildCsv, csvToTsv } from './csv';

describe('parseTeacherSheet', () => {
  it('reads rows, skips the header, dashes and EXAMPLE rows', () => {
    const r = parseTeacherSheet(
      [
        'Full name\tEmail\tPhone\tInitials\tBatches (separate with ;)\tPassword (optional)',
        'EXAMPLE – Priya Sharma\tpriya@example.com\t9876543210\tPKS\tXII Chem; XII Math\t',
        'Hari M L\thml@example.com\t9876500001\tHML\tXII Chem; XI Chem\t',
        'Sri R\tsri@example.com\t9876500002\t—\t—\tChosen#1234',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { fullName: 'Hari M L', email: 'hml@example.com', phone: '9876500001', initials: 'HML', batches: 'XII Chem; XI Chem', password: undefined },
      { fullName: 'Sri R', email: 'sri@example.com', phone: '9876500002', initials: undefined, batches: undefined, password: 'Chosen#1234' },
    ]);
  });

  it('reports rows that cannot work', () => {
    const r = parseTeacherSheet('\ta@b.com\t9876543210\nNo Email\t\t9876543210\nBad Email\tnope\t9876543210\nNo Phone\tx@y.com\t');
    expect(r.rows).toEqual([]);
    expect(r.errors.map((e) => e.line)).toEqual([1, 2, 3, 4]);
    expect(r.errors[0].message).toMatch(/Full name/);
    expect(r.errors[1].message).toMatch(/email/);
    expect(r.errors[3].message).toMatch(/phone/);
  });
});

describe('parseStudentSheet', () => {
  it('reads all nine columns', () => {
    const r = parseStudentSheet('Teja Sree\tSuresh Kumar\t9876543210\ts@example.com\t12\tCBSE\t09/03/2008\t01/10/2026\tXII Chem; XII Math');
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { studentName: 'Teja Sree', parentName: 'Suresh Kumar', parentPhone: '9876543210', parentEmail: 's@example.com', grade: '12', board: 'CBSE', dateOfBirth: '09/03/2008', admissionDate: '01/10/2026', batches: 'XII Chem; XII Math' },
    ]);
  });

  it('keeps column positions when optional cells are empty', () => {
    const r = parseStudentSheet('Layana\t\t9876543210\t\t12\t\t\t\tXII Chem');
    expect(r.rows[0]).toMatchObject({ studentName: 'Layana', parentName: undefined, parentPhone: '9876543210', grade: '12', board: undefined, batches: 'XII Chem' });
  });

  it('flags a missing student name or parent phone', () => {
    const r = parseStudentSheet('\tParent\t9876543210\nKid\tParent\tabc');
    expect(r.rows).toEqual([]);
    expect(r.errors.map((e) => e.line)).toEqual([1, 2]);
  });
});

describe('downloadable templates', () => {
  it('every template round-trips through its own parser without importing the example rows', () => {
    const asText = (k: keyof typeof TEMPLATES) => csvToTsv(buildCsv(TEMPLATES[k].header, TEMPLATES[k].examples));
    const t = parseTeacherSheet(asText('teachers'));
    const s = parseStudentSheet(asText('students'));
    expect(t.rows).toEqual([]);
    expect(t.errors).toEqual([]);
    expect(s.rows).toEqual([]);
    expect(s.errors).toEqual([]);
  });
});
