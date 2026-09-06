import { withRoute } from '@/server/api/with-route';
import { tenantFromListQuery } from '@/server/api/tenant';
import { listTasks } from '@/server/services/tasks';
import { taskListQuerySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'task:read',
  tenant: ({ query, auth }) => tenantFromListQuery({ query, auth }),
  rateLimit: { class: 'read' },
  pageResult: true,
  summary: 'list tasks',
  querySchema: taskListQuerySchema,
  handler: async ({ query }) => listTasks({ query }),
});

export { GET };
