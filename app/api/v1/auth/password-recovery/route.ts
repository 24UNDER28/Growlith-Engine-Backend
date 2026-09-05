import { withRoute } from '@/server/api/with-route';
import { passwordRecoveryBodySchema, requestPasswordRecovery } from '@/server/auth/routes-password';

/**
 * POST /api/v1/auth/password-recovery — request a reset email (§9).
 *
 * ALWAYS 202: identical shape whether the address is unknown, INVITED,
 * SUSPENDED, DEACTIVATED or ACTIVE — non-disclosure (ADR-0025 philosophy).
 * Only ACTIVE accounts are sent mail; an INVITED account has nothing to
 * recover and a blocked account must not regain a session by proving mailbox
 * control.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'public',
  summary: 'request a password recovery email',
  bodySchema: passwordRecoveryBodySchema,
  successStatus: 202,
  handler: async ({ body, request, requestId }) => {
    await requestPasswordRecovery({ body, request, requestId });
    // The body is deliberately constant: nothing about the outcome varies.
    return { accepted: true as const };
  },
});

export { POST };
