import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { assignDeliverable } from '@/server/services/deliverables';
import { assignOwnerBodySchema, idParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'deliverable:assign',
  tenant: tenantFromRow('deliverables', 'id'),
  project: async ({ params }) => {
    const { loadLive } = await import('@/server/services/crud');
    const row = await loadLive<{ project_id: string }>('deliverables', params.id);
    return row.project_id;
  },
  rateLimit: { class: 'mutation' },
  summary: 'assign a deliverable owner',
  paramSchema: idParamSchema,
  bodySchema: assignOwnerBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    assignDeliverable({
      id: params.id,
      ownerUserId: body.ownerUserId,
      auth,
      request,
      requestId,
    }),
});

export { POST };
