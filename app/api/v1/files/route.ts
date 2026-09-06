import { withRoute } from '@/server/api/with-route';
import { tenantFromListQuery } from '@/server/api/tenant';
import { listFiles, registerFile, resolveFileParentTenant } from '@/server/services/files';
import { fileListQuerySchema, registerFileBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'file:read',
  tenant: ({ query, auth }) => tenantFromListQuery({ query, auth }),
  rateLimit: { class: 'read' },
  pageResult: true,
  summary: 'list files',
  querySchema: fileListQuerySchema,
  handler: async ({ query }) => listFiles({ query }),
});

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'file:upload',
  tenant: ({ body }) => resolveFileParentTenant(body),
  rateLimit: { class: 'mutation' },
  idempotency: true,
  successStatus: 201,
  location: (data: { readonly id: string }) => `/api/v1/files/${data.id}`,
  summary: 'register an uploaded file',
  bodySchema: registerFileBodySchema,
  handler: async ({ body, auth, request, requestId }) =>
    registerFile({ body, auth, request, requestId }),
});

export { GET, POST };
