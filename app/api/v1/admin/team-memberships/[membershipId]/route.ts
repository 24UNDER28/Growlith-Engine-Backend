import { withRoute } from '@/server/api/with-route';
import { deleteTeamMembership, patchTeamMembership } from '@/server/services/teams';
import {
  membershipOnlyParamSchema,
  patchTeamMembershipBodySchema,
} from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PATCH = withRoute({
  method: 'PATCH',
  auth: 'required',
  capability: 'team_membership:update',
  rateLimit: { class: 'mutation' },
  summary: 'update a staff team membership',
  paramSchema: membershipOnlyParamSchema,
  bodySchema: patchTeamMembershipBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    patchTeamMembership({ id: params.membershipId, body, auth, request, requestId }),
});

const DELETE = withRoute({
  method: 'DELETE',
  auth: 'required',
  capability: 'team_membership:delete',
  rateLimit: { class: 'mutation' },
  successStatus: 204,
  summary: 'remove a staff team membership',
  paramSchema: membershipOnlyParamSchema,
  handler: async ({ params, auth, request, requestId }) => {
    await deleteTeamMembership({ id: params.membershipId, auth, request, requestId });
  },
});

export { PATCH, DELETE };
