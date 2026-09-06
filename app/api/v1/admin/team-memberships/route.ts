import { withRoute } from '@/server/api/with-route';
import { createTeamMembership } from '@/server/services/teams';
import { createTeamMembershipBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'team_membership:create',
  rateLimit: { class: 'mutation' },
  successStatus: 201,
  location: (data: { readonly id: string }) => `/api/v1/admin/team-memberships/${data.id}`,
  summary: 'add a staff team membership',
  bodySchema: createTeamMembershipBodySchema,
  handler: async ({ body, auth, request, requestId }) =>
    createTeamMembership({ auth, request, requestId, body }),
});

export { POST };
