/** Joins truthy class names. */
export function cx(...parts: (string | false | null | undefined | 0)[]): string {
  return parts.filter(Boolean).join(' ');
}
