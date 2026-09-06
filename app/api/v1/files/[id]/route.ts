import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { deleteFile, getFile, patchFile } from '@/server/services/files';
import { idParamSchema, patchFileBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'file:read',
  tenant: tenantFromRow('files', 'id'),
  rateLimit: { class: 'read' },
  summary: 'read one file',
  paramSchema: idParamSchema,
  handler: async ({ params }) => getFile(params.id),
});

const PATCH = withRoute({
  method: 'PATCH',
  auth: 'required',
  capability: 'file:update',
  tenant: tenantFromRow('files', 'id'),
  rateLimit: { class: 'mutation' },
  summary: 'update file metadata',
  paramSchema: idParamSchema,
  bodySchema: patchFileBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    patchFile({ id: params.id, body, auth, request, requestId }),
});

const DELETE = withRoute({
  method: 'DELETE',
  auth: 'required',
  capability: 'file:delete',
  tenant: tenantFromRow('files', 'id'),
  rateLimit: { class: 'mutation' },
  successStatus: 204,
  summary: 'soft-delete a file',
  paramSchema: idParamSchema,
  handler: async ({ params, auth, request, requestId }) => {
    await deleteFile({ id: params.id, auth, request, requestId });
  },
});

export { GET, PATCH, DELETE };
