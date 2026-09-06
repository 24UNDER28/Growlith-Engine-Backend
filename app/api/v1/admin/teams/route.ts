import { withRoute } from '@/server/api/with-route';
import { listTeams } from '@/server/services/teams';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'team_membership:read',
  rateLimit: { class: 'read' },
  summary: 'list internal teams',
  handler: async () => ({ teams: await listTeams() }),
});

export { GET };
