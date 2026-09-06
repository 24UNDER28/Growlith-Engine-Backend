import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { deleteService, getService, patchService } from '@/server/services/catalog-services';
import { idParamSchema, patchServiceBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'service:read',
  tenant: tenantFromRow('services', 'id'),
  rateLimit: { class: 'read' },
  summary: 'read one service',
  paramSchema: idParamSchema,
  handler: async ({ params, auth }) => getService(params.id, auth),
});

const PATCH = withRoute({
  method: 'PATCH',
  auth: 'required',
  capability: 'service:update',
  tenant: tenantFromRow('services', 'id'),
  rateLimit: { class: 'mutation' },
  summary: 'update a service',
  paramSchema: idParamSchema,
  bodySchema: patchServiceBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    patchService({ id: params.id, body, auth, request, requestId }),
});

const DELETE = withRoute({
  method: 'DELETE',
  auth: 'required',
  capability: 'service:delete',
  tenant: tenantFromRow('services', 'id'),
  rateLimit: { class: 'mutation' },
  successStatus: 204,
  summary: 'soft-delete a service',
  paramSchema: idParamSchema,
  handler: async ({ params, auth, request, requestId }) => {
    await deleteService({ id: params.id, auth, request, requestId });
  },
});

export { GET, PATCH, DELETE };
