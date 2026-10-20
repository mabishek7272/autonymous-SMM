/**
 * The single mapping between the 7 UI pipeline stages and the backend LeadStatus enum.
 * Views must import from here instead of re-declaring labels or colours.
 */
export const LEAD_STATUSES = [
  'enquiry',
  'contacted',
  'qualified',
  'demo_scheduled',
  'follow_up',
  'converted',
  'lost',
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export type LeadStageLabel =
  | 'New'
  | 'Contacted'
  | 'Interested'
  | 'Demo Booked'
  | 'Follow-up'
  | 'Admission'
  | 'Lost';

export interface LeadStage {
  status: LeadStatus;
  label: LeadStageLabel;
  /** Column dot colour (prototype: violet default, orange follow-up, green admission, slate lost). */
  dot: string;
  /** Column count pill colours. */
  countBg: string;
  countColor: string;
}

const VIOLET_DOT = '#7C3AED';

export const LEAD_STAGES: readonly LeadStage[] = [
  { status: 'enquiry', label: 'New', dot: VIOLET_DOT, countBg: '#FFFFFF', countColor: '#475569' },
  { status: 'contacted', label: 'Contacted', dot: VIOLET_DOT, countBg: '#FFFFFF', countColor: '#475569' },
  { status: 'qualified', label: 'Interested', dot: VIOLET_DOT, countBg: '#FFFFFF', countColor: '#475569' },
  { status: 'demo_scheduled', label: 'Demo Booked', dot: VIOLET_DOT, countBg: '#FFFFFF', countColor: '#475569' },
  { status: 'follow_up', label: 'Follow-up', dot: '#F97316', countBg: '#FFF7ED', countColor: '#C2410C' },
  { status: 'converted', label: 'Admission', dot: '#059669', countBg: '#FFFFFF', countColor: '#475569' },
  { status: 'lost', label: 'Lost', dot: '#CBD5E1', countBg: '#FFFFFF', countColor: '#475569' },
];

const BY_STATUS = new Map<LeadStatus, LeadStage>(LEAD_STAGES.map((s) => [s.status, s]));
const BY_LABEL = new Map<LeadStageLabel, LeadStage>(LEAD_STAGES.map((s) => [s.label, s]));

export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === 'string' && (LEAD_STATUSES as readonly string[]).includes(value);
}

export function stageForStatus(status: LeadStatus): LeadStage {
  // BY_STATUS is built from the exhaustive list, so the lookup cannot miss for a valid status.
  return BY_STATUS.get(status) ?? LEAD_STAGES[0];
}

export function stageForLabel(label: LeadStageLabel): LeadStage {
  return BY_LABEL.get(label) ?? LEAD_STAGES[0];
}

export function stageLabel(status: LeadStatus): LeadStageLabel {
  return stageForStatus(status).label;
}

export function statusForLabel(label: LeadStageLabel): LeadStatus {
  return stageForLabel(label).status;
}

/**
 * The status a card advances to with its "next" button (prototype nextStage):
 * Lost re-opens as New, each stage moves to the following one, and Admission is the end of
 * the board (returns null: the next step is the onboarding flow, not a status change).
 */
export function nextStatus(status: LeadStatus): LeadStatus | null {
  if (status === 'lost') return 'enquiry';
  if (status === 'converted') return null;
  const i = LEAD_STATUSES.indexOf(status);
  return LEAD_STATUSES[Math.min(i + 1, LEAD_STATUSES.indexOf('converted'))] ?? null;
}

/** Label for the advance button, e.g. "Contacted" for a New lead. */
export function nextStageLabel(status: LeadStatus): LeadStageLabel | null {
  const next = nextStatus(status);
  return next ? stageLabel(next) : null;
}

/** Statuses from which the backend allows onboarding (POST /students/onboard-lead). */
export const ADMISSIBLE_STATUSES: readonly LeadStatus[] = ['qualified', 'demo_scheduled', 'follow_up', 'converted'];

export function isAdmissible(status: LeadStatus): boolean {
  return ADMISSIBLE_STATUSES.includes(status);
}

/** Open pipeline = everything except the two terminal stages. */
export function isOpenStatus(status: LeadStatus): boolean {
  return status !== 'converted' && status !== 'lost';
}
