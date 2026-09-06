import { withRoute } from '@/server/api/with-route';
import { passwordSetBodySchema, setPassword } from '@/server/auth/routes-password';

/**
 * POST /api/v1/auth/password — set or change the caller's password (§9).
 *
 * REQUIRED session: the credential here is the session itself — a recovery
 * session (mailbox control proved at /auth/confirm) or the post-invitation
 * session. GoTrue owns the password policy (§H); its violations map to 422.
 * On success other devices are evicted; the current flow survives.
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
  summary: 'set or change the password of the signed-in account',
  bodySchema: passwordSetBodySchema,
  successStatus: 204,
  handler: async ({ body, auth, request, requestId }) => {
    await setPassword({ body, auth, request, requestId });
  },
});

export { POST };
