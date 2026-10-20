import { describe, expect, it } from 'vitest';
import { parseLinkImport } from './parseImport';

const URL1 = 'https://teams.microsoft.com/l/meetup-join/a';
const URL2 = 'https://teams.microsoft.com/l/meetup-join/b';

describe('parseLinkImport', () => {
  it('parses tab-separated rows pasted from a spreadsheet, with optional columns', () => {
    const r = parseLinkImport(`8th CBSE Science\t${URL1}\t8\tCBSE\tScience\n9th CBSE Maths\t${URL2}`);
    expect(r.errors).toEqual([]);
    expect(r.links).toEqual([
      { name: '8th CBSE Science', meetingUrl: URL1, grade: '8', board: 'CBSE', subject: 'Science' },
      { name: '9th CBSE Maths', meetingUrl: URL2, grade: null, board: null, subject: null },
    ]);
  });

  it('accepts pipe-separated rows, skips a header row and blank lines', () => {
    const r = parseLinkImport(`Name | Link\n\n8th CBSE Science | ${URL1}\n`);
    expect(r.errors).toEqual([]);
    expect(r.links.map((l) => l.name)).toEqual(['8th CBSE Science']);
  });

  it('reports bad rows with their line numbers instead of dropping them silently', () => {
    const r = parseLinkImport(`A\t${URL1}\nGood name\thttp://insecure.example\nGood name 2\tnot a url\n\t${URL2}\nDup\t${URL1}\ndup\t${URL2}`);
    expect(r.links.map((l) => l.name)).toEqual(['Dup']);
    expect(r.errors.map((e) => e.line)).toEqual([1, 2, 3, 4, 6]);
    expect(r.errors[1].message).toMatch(/https/);
    expect(r.errors[4].message).toMatch(/Duplicate/);
  });
});
