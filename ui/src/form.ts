/**
 * Shared form helpers for the write surfaces (v0.3 review): tag parsing,
 * datetime-local <-> ISO conversion, and one error-message formatter.
 */

/** Comma-separated tag input -> lowercase list (empty input -> []). */
export function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);
}

/** datetime-local input value -> ISO string; '' means "clear" (null). */
export function localToIso(localValue: string): string | null {
  return localValue === '' ? null : new Date(localValue).toISOString();
}

/** ISO string -> datetime-local input value (local time); null -> ''. */
export function isoToLocal(iso: string | null): string {
  if (iso === null) {
    return '';
  }
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
