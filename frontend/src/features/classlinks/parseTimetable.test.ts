import { describe, expect, it } from 'vitest';
import { parseTimetablePaste } from './parseTimetable';

const T1 = 'https://teams.microsoft.com/meet/414872941812354?p=Cy24ry0poKPfG23qOL';
const T2 = 'https://teams.microsoft.com/meet/489762756154393?p=wBNxdigF1tY3eZhu2Q';
const GM = 'https://meet.google.com/ofs-swtr-qem';

describe('parseTimetablePaste', () => {
  it("parses the client's tab-separated layout, carrying the day down and sharing AM/PM across the range", () => {
    const r = parseTimetablePaste(
      [
        'Day\tTime Slot\tClass & Subject\tFaculty / Student(s)\tMeeting Link',
        `Monday\t6:00 – 7:00 AM\tX 1-1 Bio\tBPY, Sai Sarvatha\t${T1}`,
        `\t6:30 – 7:30 PM\tXII Chem\tHML, Teja Sree, Layana\t${T1}`,
        `\t7:30 – 8:30 PM\tXII Math\tSRI, Layana\t${T2}`,
        `Friday\t7:30 – 8:30 PM\tXII Math\tSRI, Layana\t${GM}`,
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { batchName: 'X 1-1 Bio', day: 'Monday', startTime: '6:00 AM', endTime: '7:00 AM', meetingUrl: T1 },
      { batchName: 'XII Chem', day: 'Monday', startTime: '6:30 PM', endTime: '7:30 PM', meetingUrl: T1 },
      { batchName: 'XII Math', day: 'Monday', startTime: '7:30 PM', endTime: '8:30 PM', meetingUrl: T2 },
      { batchName: 'XII Math', day: 'Friday', startTime: '7:30 PM', endTime: '8:30 PM', meetingUrl: GM },
    ]);
  });

  it('parses a markdown table with bold text, link cells and separator rows', () => {
    const r = parseTimetablePaste(
      [
        '| Day | Time Slot | Class & Subject | Faculty / Student(s) | Meeting Link |',
        '| :--- | :--- | :--- | :--- | :--- |',
        `| **Tuesday** | 6:30 – 7:30 PM | **XI Chem** | HML, Tamil | [Join Teams](${T1}) |`,
        `| | 7:30 – 8:30 PM | **X Math** | SRI | [Join Google Meet](${GM}) |`,
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.batchName, x.day, x.startTime, x.meetingUrl])).toEqual([
      ['XI Chem', 'Tuesday', '6:30 PM', T1],
      ['X Math', 'Tuesday', '7:30 PM', GM],
    ]);
  });

  it('resolves a range that crosses noon', () => {
    const r = parseTimetablePaste(`Saturday\t11:30 – 12:30 PM\tX Bio\tBPY\t${T1}`);
    expect(r.rows[0]).toMatchObject({ startTime: '11:30 AM', endTime: '12:30 PM' });
  });

  it('reports unusable lines instead of dropping them', () => {
    const r = parseTimetablePaste(
      [
        `${'Monday'}\t6:30 – 7:30 PM\tXII Chem\tHML\t`, // no link
        `\t7:30 PM\tXII Math\tSRI\t${T2}`, // no range
        `\t7:30 – 8:30 PM\t\t\t${T2}`, // no class
        `\t7:30 – 8:30 PM\tX Phy\tDRI\thttp://insecure.example/x`, // http
      ].join('\n'),
    );
    expect(r.rows).toEqual([]);
    expect(r.errors.map((e) => e.line)).toEqual([1, 2, 3, 4]);
    expect(r.errors[0].message).toMatch(/link is missing/);
    expect(r.errors[1].message).toMatch(/time slot/);
    expect(r.errors[2].message).toMatch(/Class & subject/);
    expect(r.errors[3].message).toMatch(/https/);
  });

  it('asks for a day when none has been given yet', () => {
    const r = parseTimetablePaste(`6:30 – 7:30 PM\tXII Chem\tHML\t${T1}`);
    expect(r.errors[0].message).toMatch(/No day/);
  });
});
