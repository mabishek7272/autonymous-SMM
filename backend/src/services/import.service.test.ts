import { describe, it, expect } from 'vitest';
import { courseNameFromBatch, inferLeadStatus, linkNameFromUrl, mapTimeline, minutesBetween, parseDay, parseTime, splitPhones } from './import.service';

describe('parseDay / parseTime', () => {
  it('reads day names, abbreviations and numbers', () => {
    expect(parseDay('Monday')).toBe(1);
    expect(parseDay(' sat ')).toBe(6);
    expect(parseDay('Wednesday')).toBe(3);
    expect(parseDay(0)).toBe(0);
    expect(parseDay('Funday')).toBeNull();
  });

  it('reads the times used in the timetable', () => {
    expect(parseTime('6:00 AM')).toBe('06:00');
    expect(parseTime('6:30 PM')).toBe('18:30');
    expect(parseTime('7:30pm')).toBe('19:30');
    expect(parseTime('12:00 AM')).toBe('00:00');
    expect(parseTime('12:15 PM')).toBe('12:15');
    expect(parseTime('18:30')).toBe('18:30');
    expect(parseTime('6.30 PM')).toBe('18:30');
    expect(parseTime('25:00')).toBeNull();
    expect(parseTime('13 PM')).toBeNull();
    expect(parseTime('soon')).toBeNull();
    expect(minutesBetween('18:30', '19:30')).toBe(60);
  });
});

describe('batch and link naming', () => {
  it('derives the course from the class in the batch name', () => {
    expect(courseNameFromBatch('XII Chem')).toBe('Class XII');
    expect(courseNameFromBatch('X 1-1 Bio')).toBe('Class X');
    expect(courseNameFromBatch('XI Math')).toBe('Class XI');
    expect(courseNameFromBatch('8th CBSE Science')).toBe('Class 8');
    expect(courseNameFromBatch('Foundation batch')).toBe('General');
  });

  it('names links from their URL', () => {
    expect(linkNameFromUrl('https://teams.microsoft.com/meet/485543179174254?p=DYjHEp0W0ovJLp4UeR')).toBe('Teams …79174254');
    expect(linkNameFromUrl('https://meet.google.com/ofs-swtr-qem')).toBe('Google Meet ofs-swtr-qem');
    expect(linkNameFromUrl('not a url')).toBe('Class link');
  });
});

describe('lead sheet helpers', () => {
  it('maps the timeline column', () => {
    expect(mapTimeline('Immediately')).toBe('immediately');
    expect(mapTimeline('Within 1 Week')).toBe('within_week');
    expect(mapTimeline('When Program Starts')).toBe('when_program_starts');
    expect(mapTimeline('Just Enquiring')).toBe('just_enquiring');
    expect(mapTimeline('')).toBeNull();
    expect(mapTimeline('whenever')).toBeNull();
  });

  it('infers a stage from the counsellor notes without over-claiming', () => {
    expect(inferLeadStatus('Demo at 6:30 PM', 'Enrolled Successfully')).toBe('converted');
    expect(inferLeadStatus('Not interested')).toBe('lost');
    expect(inferLeadStatus("Can't afford")).toBe('lost');
    expect(inferLeadStatus('Demo at 7:30 on 01/09/2026')).toBe('demo_scheduled');
    expect(inferLeadStatus('Tmrw demo session at 6:30 PM')).toBe('demo_scheduled');
    expect(inferLeadStatus('Call again on Wednesday')).toBe('follow_up');
    expect(inferLeadStatus('Discuss and tell')).toBe('follow_up');
    expect(inferLeadStatus('Arguing for high fees')).toBe('follow_up');
    expect(inferLeadStatus('Price high')).toBe('follow_up');
    expect(inferLeadStatus('No response')).toBe('enquiry');
    expect(inferLeadStatus('Line busy')).toBe('enquiry');
    expect(inferLeadStatus('', undefined, null)).toBe('enquiry');
  });

  it('splits several numbers in one cell', () => {
    expect(splitPhones('9445244497 / 7845606422')).toEqual(['9445244497', '7845606422']);
    expect(splitPhones('9894320907')).toEqual(['9894320907']);
    expect(splitPhones(9894320907)).toEqual(['9894320907']);
    expect(splitPhones(undefined)).toEqual([]);
  });
});
