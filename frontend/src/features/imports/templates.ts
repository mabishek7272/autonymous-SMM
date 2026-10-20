import { buildCsv, downloadTextFile } from './csv';

export interface ImportTemplate {
  filename: string;
  header: readonly string[];
  examples: readonly (readonly string[])[];
}

/**
 * Downloadable CSV templates, one per import. Column order matches what the paste parsers expect.
 * Example rows are prefixed "EXAMPLE –" and are ignored on import.
 */
export const TEMPLATES = {
  teachers: {
    filename: 'teachers-template.csv',
    header: ['Full name', 'Email', 'Phone', 'Initials', 'Batches (separate with ;)', 'Password (optional)'],
    examples: [
      ['EXAMPLE – Priya Sharma', 'priya@example.com', '9876543210', 'PKS', 'XII Chem; XII Math', ''],
      ['EXAMPLE – Ravi Kumar', 'ravi@example.com', '9876500000', 'RVK', 'X Phy', ''],
    ],
  },
  students: {
    filename: 'students-template.csv',
    header: ['Student name', 'Parent name', 'Parent phone', 'Parent email', 'Class', 'Board', 'Date of birth (DD/MM/YYYY)', 'Admission date (DD/MM/YYYY)', 'Batches (separate with ;)'],
    examples: [
      ['EXAMPLE – Teja Sree', 'Suresh Kumar', '9876543210', 'suresh@example.com', '12', 'CBSE', '09/03/2008', '01/10/2026', 'XII Chem; XII Math'],
      ['EXAMPLE – Layana', 'Suresh Kumar', '9876543210', '', '12', 'CBSE', '', '', 'XII Chem'],
    ],
  },
  leads: {
    filename: 'leads-template.csv',
    header: ['Lead name', 'Class', 'Board', 'Contact no.', 'Timeline (Immediately / Within 1 Week / When Program Starts / Just Enquiring)', 'Notes / subject needed', 'Location / alt contact / remarks'],
    examples: [['EXAMPLE – Chithraa', '10', 'CBSE', '9876543210', 'Within 1 Week', 'Maths and Science; call again on Wednesday', 'Chennai']],
  },
  timetable: {
    filename: 'timetable-template.csv',
    header: ['Day', 'Time slot', 'Class & subject', 'Faculty', 'Meeting link'],
    examples: [
      ['EXAMPLE – Monday', '6:30 – 7:30 PM', 'XII Chem', 'HML', 'https://teams.microsoft.com/meet/123456789012'],
      ['EXAMPLE – Monday', '7:30 – 8:30 PM', 'XII Math', 'SRI', 'https://meet.google.com/abc-defg-hij'],
    ],
  },
  classLinks: {
    filename: 'class-links-template.csv',
    header: ['Name', 'Meeting link', 'Class', 'Board', 'Subject'],
    examples: [['EXAMPLE – 8th CBSE Science', 'https://teams.microsoft.com/meet/123456789012', '8', 'CBSE', 'Science']],
  },
} as const satisfies Record<string, ImportTemplate>;

export type TemplateKey = keyof typeof TEMPLATES;

export function downloadTemplate(key: TemplateKey): void {
  const t: ImportTemplate = TEMPLATES[key];
  downloadTextFile(t.filename, buildCsv(t.header, t.examples));
}
