import { withRoute } from '@/server/api/with-route';
import { listTotpFactors } from '@/server/auth/routes-mfa';

/**
 * GET /api/v1/auth/mfa/factors — list the caller's TOTP factors (§6c).
 *
 * Lets the Phase 9 settings UI show what is enrolled; verified factors are
 * what `mfaRequired` at login and the admin guard's enrollment redirect key
 * off.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  // `user:update` at the ◦ SELF cell — the subject is always the caller (no
  // path-named person), so `subjectUser` is omitted and SELF is satisfied by
  // construction; staff reach the same row through the ● cells.
  capability: 'user:update',
  rateLimit: { class: 'sensitive' },
  summary: 'list TOTP factors for the signed-in account',
  handler: async () => listTotpFactors(),
});

export { GET };
