import { withRoute } from '@/server/api/with-route';
import { listStaffActivity } from '@/server/services/activity';
import { activityListQuerySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'activity:read',
  rateLimit: { class: 'read' },
  pageResult: true,
  summary: 'staff activity feed',
  querySchema: activityListQuerySchema,
  handler: async ({ query }) => listStaffActivity({ query }),
});

export { GET };
