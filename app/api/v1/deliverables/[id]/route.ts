import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import {
  deleteDeliverable,
  getDeliverable,
  patchDeliverable,
} from '@/server/services/deliverables';
import { idParamSchema, patchDeliverableBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'deliverable:read',
  tenant: tenantFromRow('deliverables', 'id'),
  rateLimit: { class: 'read' },
  summary: 'read one deliverable',
  paramSchema: idParamSchema,
  handler: async ({ params }) => getDeliverable(params.id),
});

const PATCH = withRoute({
  method: 'PATCH',
  auth: 'required',
  capability: 'deliverable:update',
  tenant: tenantFromRow('deliverables', 'id'),
  rateLimit: { class: 'mutation' },
  summary: 'update a deliverable',
  paramSchema: idParamSchema,
  bodySchema: patchDeliverableBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    patchDeliverable({ id: params.id, body, auth, request, requestId }),
});

const DELETE = withRoute({
  method: 'DELETE',
  auth: 'required',
  capability: 'deliverable:delete',
  tenant: tenantFromRow('deliverables', 'id'),
  rateLimit: { class: 'mutation' },
  successStatus: 204,
  summary: 'soft-delete a deliverable',
  paramSchema: idParamSchema,
  handler: async ({ params, auth, request, requestId }) => {
    await deleteDeliverable({ id: params.id, auth, request, requestId });
  },
});

export { GET, PATCH, DELETE };
