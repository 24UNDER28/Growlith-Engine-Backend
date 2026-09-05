import { withRoute } from '@/server/api/with-route';
import { createInvitation, createInvitationBodySchema } from '@/server/auth/invitations';

/**
 * POST /api/v1/invitations — create (or re-issue) an invitation (design §2.1).
 *
 * The only door through which an account comes to exist: sign-up is disabled
 * at the auth server. Capability checks arrive in Phase 4; Phase 3 requires a
 * valid session (any authenticated identity may reach the handler — the route
 * is NOT exposed in any UI) and records the actor on every write and audit row.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  summary: 'invite a person to the platform',
  bodySchema: createInvitationBodySchema,
  successStatus: 201,
  handler: async ({ body, auth, request, requestId }) =>
    createInvitation({ body, auth, request, requestId }),
});

export { POST };
