import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { changeDeliverableStatus } from '@/server/services/deliverables';
import { idParamSchema, statusChangeBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'deliverable:update',
  tenant: tenantFromRow('deliverables', 'id'),
  rateLimit: { class: 'mutation' },
  idempotency: true,
  summary: 'change deliverable status',
  paramSchema: idParamSchema,
  bodySchema: statusChangeBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    changeDeliverableStatus({
      id: params.id,
      status: body.status,
      reason: body.reason,
      auth,
      request,
      requestId,
    }),
});

export { POST };
