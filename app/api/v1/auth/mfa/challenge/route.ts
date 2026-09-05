import { withRoute } from '@/server/api/with-route';
import { challengeAndVerifyTotp, mfaVerifyBodySchema } from '@/server/auth/routes-mfa';

/**
 * POST /api/v1/auth/mfa/challenge — challenge + verify a TOTP code (§6c).
 *
 * One endpoint for both step-up moments: the login challenge (session at aal1
 * with verified factors) and the completion of a fresh enrollment. Success
 * promotes the session to aal2 and returns the server-derived landing path.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  summary: 'verify a TOTP code and step the session up to aal2',
  bodySchema: mfaVerifyBodySchema,
  handler: async ({ body, auth, request, requestId }) =>
    challengeAndVerifyTotp({ body, auth, request, requestId }),
});

export { POST };
