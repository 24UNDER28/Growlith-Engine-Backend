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
  // `user:update` at the ◦ SELF cell — the subject is always the caller (no
  // path-named person), so `subjectUser` is omitted and SELF is satisfied by
  // construction; staff reach the same row through the ● cells.
  capability: 'user:update',
  rateLimit: { class: 'sensitive' },
  summary: 'remove a TOTP factor under a fresh aal2 session',
  bodySchema: mfaUnenrollBodySchema,
  successStatus: 204,
  handler: async ({ body, auth, request, requestId }) => {
    await unenrollTotpFactor({ body, auth, request, requestId });
  },
});

export { POST };
