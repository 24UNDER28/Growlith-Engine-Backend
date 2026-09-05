/**
 * Page-size policy.
 *
 * The maximum is enforced here and again in the query schema, because a client
 * must never be able to request an unbounded page: on a multi-tenant table an
 * oversized page is both a denial-of-service vector and a cross-tenant data
 * exfiltration amplifier.
 */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * Coerce an untrusted page size into the allowed range.
 *
 * Any non-finite, non-integer or out-of-range value falls back to the default
 * rather than throwing: page size is a tuning parameter, not a security
 * decision, and rejecting a request over `?limit=abc` would be hostile to
 * ordinary clients. The value is always clamped, never trusted.
 */
export function clampPageSize(raw: unknown): number {
  const parsed = typeof raw === 'string' ? Number(raw) : raw;

  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    return DEFAULT_PAGE_SIZE;
  }

  const integer = Math.trunc(parsed);
  if (integer < 1) {
    return DEFAULT_PAGE_SIZE;
  }

  return Math.min(integer, MAX_PAGE_SIZE);
}
