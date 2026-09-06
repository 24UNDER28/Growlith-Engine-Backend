import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { changeDeliverableStatus } from '@/server/services/deliverables';
import { idParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'deliverable:publish',
  tenant: tenantFromRow('deliverables', 'id'),
  rateLimit: { class: 'mutation' },
  summary: 'publish an approved deliverable',
  paramSchema: idParamSchema,
  handler: async ({ params, auth, request, requestId }) =>
    changeDeliverableStatus({
      id: params.id,
      status: 'PUBLISHED',
      auth,
      request,
      requestId,
    }),
});

export { POST };
