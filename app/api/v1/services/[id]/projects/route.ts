import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { createProject } from '@/server/services/projects';
import { createProjectBodySchema, idParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'project:create',
  tenant: tenantFromRow('services', 'id'),
  rateLimit: { class: 'mutation' },
  idempotency: true,
  successStatus: 201,
  location: (data: { readonly id: string }) => `/api/v1/projects/${data.id}`,
  summary: 'create a project under a service',
  paramSchema: idParamSchema,
  bodySchema: createProjectBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    createProject({
      body: { ...body, serviceId: params.id },
      auth,
      request,
      requestId,
    }),
});

export { POST };
