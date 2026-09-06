import { withRoute } from '@/server/api/with-route';
import { tenantFromListQuery } from '@/server/api/tenant';
import { listUsers } from '@/server/services/users';
import { usersListQuerySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'user:read',
  tenant: ({ query, auth }) => tenantFromListQuery({ query, auth }),
  rateLimit: { class: 'read' },
  pageResult: true,
  summary: 'list users',
  querySchema: usersListQuerySchema,
  handler: async ({ query, auth }) => listUsers({ auth, query }),
});

export { GET };
