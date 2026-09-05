import { withRoute } from '@/server/api/with-route';
import { loginBodySchema, performLogin } from '@/server/auth/routes-login';

/**
 * POST /api/v1/auth/login — credential sign-in (design §3).
 *
 * PUBLIC at the `withRoute` level (unreachable otherwise); the handler runs
 * its own authoritative checks: strict body, `signInWithPassword` through the
 * request-scoped server client (cookies are written server-side only,
 * ADR-0026), the status gate against the just-issued session, MFA step-up
 * signalling, audit. Uniform `401 INVALID_CREDENTIALS` for unknown address and
 * wrong password — never an enumeration oracle.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'public',
  summary: 'sign in with email and password',
  bodySchema: loginBodySchema,
  handler: async ({ body, request, requestId }) => performLogin({ body, request, requestId }),
});

export { POST };
