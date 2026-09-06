import { withRoute } from '@/server/api/with-route';
import { performLogout } from '@/server/auth/routes-login';

/**
 * POST /api/v1/auth/logout — global sign-out (design §14).
 *
 * PUBLIC by the §15 taxonomy and deliberately idempotent: a session that is
 * already expired or revoked must still be able to log out without an error
 * loop. The handler revokes ALL of the user's refresh tokens on EVERY device,
 * destroys the local session cookies, audits best-effort, and answers 204
 * even when GoTrue reports nothing to revoke.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'public',
  rateLimit: { class: 'auth' },
  summary: 'sign out on every device',
  successStatus: 204,
  handler: async ({ request, requestId }) => {
    await performLogout({ request, requestId });
  },
});

export { POST };
