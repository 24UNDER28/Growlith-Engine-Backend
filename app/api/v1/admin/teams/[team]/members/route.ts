import { withRoute } from '@/server/api/with-route';
import { listTeamMemberships } from '@/server/services/teams';
import { teamMembersParamSchema, teamMembersQuerySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'team_membership:read',
  rateLimit: { class: 'read' },
  pageResult: true,
  summary: 'list members of an internal team',
  paramSchema: teamMembersParamSchema,
  querySchema: teamMembersQuerySchema,
  handler: async ({ params, query }) =>
    listTeamMemberships({ query: { ...query, team: [params.team] } }),
});

export { GET };
