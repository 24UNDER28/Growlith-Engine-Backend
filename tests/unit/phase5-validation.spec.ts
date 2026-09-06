import { describe, expect, it } from 'vitest';

import {
  createReportBodySchema,
  orgListQuerySchema,
  usersListQuerySchema,
} from '@/lib/validation/resources';

/**
 * Phase 5 API audit — validation-regression tests for the audit fixes.
 *
 * 1. Free-text search terms (`q`) are interpolated into PostgREST `or(...)`
 *    filters; the grammar characters `, ( ) "` (and control characters) are
 *    now rejected at the schema so a search can never reach PostgREST as a
 *    filter rewrite or a parse error.
 * 2. `GET /api/v1/users` supports the documented `ids` csv lookup with a
 *    hard cap.
 * 3. `POST …/reports` enforces `periodEnd >= periodStart` (K-1 validation).
 */

describe('list search terms (`q`) are safe to interpolate into PostgREST filters', () => {
  it('users: rejects grammar-structural and control characters', () => {
    for (const bad of ['a,b', 'a(b', 'a)b', 'a"b', 'a\nb', 'a\u0007b']) {
      const result = usersListQuerySchema.safeParse({ q: bad });
      expect(result.success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('users: accepts printable terms including apostrophes and wildcards', () => {
    const result = usersListQuerySchema.safeParse({ q: "O'Brien 100%_done café" });
    expect(result.success).toBe(true);
  });

  it('organizations: rejects grammar-structural characters too', () => {
    const result = orgListQuerySchema.safeParse({ q: 'growlith,(x' });
    expect(result.success).toBe(false);
    expect(orgListQuerySchema.safeParse({ q: 'growlith GmbH' }).success).toBe(true);
  });

  it('users: `ids` csv accepts ≤50 uuids and rejects more and non-uuids', () => {
    const distinct = (n: number): string =>
      Array.from(
        { length: n },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      ).join(',');
    expect(usersListQuerySchema.safeParse({ ids: distinct(50) }).success).toBe(true);
    expect(usersListQuerySchema.safeParse({ ids: distinct(51) }).success).toBe(false);
    expect(usersListQuerySchema.safeParse({ ids: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('createReportBodySchema cross-field validation (K-1)', () => {
  const base = {
    title: 'QBR',
    reportType: 'QBR',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
  };

  it('accepts periodEnd == periodStart and periodEnd > periodStart', () => {
    expect(createReportBodySchema.safeParse(base).success).toBe(true);
    expect(
      createReportBodySchema.safeParse({ ...base, periodEnd: '2026-09-01' }).success,
    ).toBe(true);
  });

  it('rejects periodEnd < periodStart', () => {
    const result = createReportBodySchema.safeParse({
      ...base,
      periodEnd: '2026-08-31',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('periodEnd');
    }
  });
});
