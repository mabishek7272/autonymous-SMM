export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  valid: boolean;
}

const LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'] as const;

/** Client-side hint only. The server rule is 8 to 128 characters. */
export function passwordStrength(pw: string): PasswordStrength {
  if (pw.length < 8) return { score: 0, label: LABELS[0], valid: false };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const raw = classes - 1 + (pw.length >= 12 ? 1 : 0);
  const score = Math.max(1, Math.min(4, raw)) as 1 | 2 | 3 | 4;
  return { score, label: LABELS[score], valid: pw.length <= 128 };
}
