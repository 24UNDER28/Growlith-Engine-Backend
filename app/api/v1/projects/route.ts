import { withRoute } from '@/server/api/with-route';
import { tenantFromListQuery } from '@/server/api/tenant';
import { listProjects } from '@/server/services/projects';
import { projectListQuerySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'project:read',
  tenant: ({ query, auth }) => tenantFromListQuery({ query, auth }),
  rateLimit: { class: 'read' },
  pageResult: true,
  summary: 'list projects',
  querySchema: projectListQuerySchema,
  handler: async ({ query }) => listProjects({ query }),
});

export { GET };
