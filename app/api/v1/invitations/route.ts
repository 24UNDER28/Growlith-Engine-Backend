import { withRoute } from '@/server/api/with-route';
import { tenantFromListQuery } from '@/server/api/tenant';
import { createInvitation, createInvitationBodySchema } from '@/server/auth/invitations';
import { listInvitations } from '@/server/services/invitations-query';
import { invitationsListQuerySchema } from '@/lib/validation/resources';

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

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'invitation:read',
  tenant: ({ query, auth }) => tenantFromListQuery({ query, auth }),
  rateLimit: { class: 'read' },
  pageResult: true,
  summary: 'list invitations',
  querySchema: invitationsListQuerySchema,
  handler: async ({ query }) => listInvitations({ query }),
});

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  // `invitation:create` is `● ● ◑ ✗`: GLOBAL for staff (the platform-role
  // branch names no tenant — `undefined` below means "the request does not
  // name one", which the GLOBAL cells answer and any TENANT cell cannot),
  // TENANT for CLIENT_ADMIN, who must name a reachable organization in the
  // body or be refused (§F.2).
  capability: 'invitation:create',
  tenant: ({ body }) => body.organizationId ?? undefined,
  rateLimit: { class: 'sensitive' },
  summary: 'invite a person to the platform',
  bodySchema: createInvitationBodySchema,
  successStatus: 201,
  handler: async ({ body, auth, request, requestId }) =>
    createInvitation({ body, auth, request, requestId }),
});

export { GET, POST };
