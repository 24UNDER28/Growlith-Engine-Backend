import { withRoute } from '@/server/api/with-route';
import { mfaUnenrollBodySchema, unenrollTotpFactor } from '@/server/auth/routes-mfa';

/**
 * POST /api/v1/auth/mfa/unenroll — remove a TOTP factor (§6c, §13 control 8).
 *
 * Requires a FRESH aal2 session: removing the second factor is exactly the
 * kind of sensitive change the second factor exists to authorize. The check
 * reads the verified session's assurance level from the resolved context.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  summary: 'remove a TOTP factor under a fresh aal2 session',
  bodySchema: mfaUnenrollBodySchema,
  successStatus: 204,
  handler: async ({ body, auth, request, requestId }) => {
    await unenrollTotpFactor({ body, auth, request, requestId });
  },
});

export { POST };
