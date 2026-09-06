import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { listDeliverableVersions } from '@/server/services/deliverables';
import { idParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'deliverable:read',
  tenant: tenantFromRow('deliverables', 'id'),
  rateLimit: { class: 'read' },
  summary: 'list deliverable versions',
  paramSchema: idParamSchema,
  handler: async ({ params }) => listDeliverableVersions(params.id),
});

export { GET };
