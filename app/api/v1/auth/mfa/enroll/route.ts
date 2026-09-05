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
  summary: 'begin TOTP enrollment for the signed-in account',
  handler: async ({ auth, request, requestId }) => enrollTotpFactor({ auth, request, requestId }),
});

export { POST };
