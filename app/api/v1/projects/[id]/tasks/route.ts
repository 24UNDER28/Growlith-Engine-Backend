import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { createTask } from '@/server/services/tasks';
import { createTaskBodySchema, idParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'task:create',
  tenant: tenantFromRow('projects', 'id'),
  rateLimit: { class: 'mutation' },
  idempotency: true,
  successStatus: 201,
  location: (data: { readonly id: string }) => `/api/v1/tasks/${data.id}`,
  summary: 'create a task under a project',
  paramSchema: idParamSchema,
  bodySchema: createTaskBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    createTask({
      body: { ...body, projectId: params.id },
      auth,
      request,
      requestId,
    }),
});

export { POST };
