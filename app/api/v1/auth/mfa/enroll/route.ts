import { withRoute } from '@/server/api/with-route';
import { enrollTotpFactor } from '@/server/auth/routes-mfa';

/**
 * POST /api/v1/auth/mfa/enroll — begin TOTP enrollment (§6c).
 *
 * Any authenticated session may enroll. Returns the QR/secret payload the
 * Phase 9 UI renders; the factor — and the account's aal2 — only become real
 * after /mfa/challenge verifies a code from it.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  // `user:update` at the ◦ SELF cell — the subject is always the caller (no
  // path-named person), so `subjectUser` is omitted and SELF is satisfied by
  // construction; staff reach the same row through the ● cells.
  capability: 'user:update',
  summary: 'begin TOTP enrollment for the signed-in account',
  handler: async ({ auth, request, requestId }) => enrollTotpFactor({ auth, request, requestId }),
});

export { POST };
