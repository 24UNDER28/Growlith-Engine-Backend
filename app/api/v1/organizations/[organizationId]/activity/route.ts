import { withRoute } from '@/server/api/with-route';
import { tenantFromParam } from '@/server/api/tenant';
import { listClientActivity } from '@/server/services/activity';
import { orgActivityQuerySchema, organizationIdParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'organization:read',
  tenant: tenantFromParam('organizationId'),
  rateLimit: { class: 'read' },
  pageResult: true,
  summary: 'projected client activity feed',
  paramSchema: organizationIdParamSchema,
  querySchema: orgActivityQuerySchema,
  handler: async ({ params, query }) =>
    listClientActivity({
      organizationId: params.organizationId,
      limit: query.limit,
      before: query.before,
    }),
});

export { GET };
