import { withRoute } from '@/server/api/with-route';
import { tenantFromListQuery } from '@/server/api/tenant';
import { listDeliverables } from '@/server/services/deliverables';
import { deliverableListQuerySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'deliverable:read',
  tenant: ({ query, auth }) => tenantFromListQuery({ query, auth }),
  rateLimit: { class: 'read' },
  pageResult: true,
  summary: 'list deliverables',
  querySchema: deliverableListQuerySchema,
  handler: async ({ query }) => listDeliverables({ query }),
});

export { GET };
