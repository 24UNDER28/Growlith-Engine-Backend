import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { deleteTask, getTask, patchTask } from '@/server/services/tasks';
import { idParamSchema, patchTaskBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'task:read',
  tenant: tenantFromRow('tasks', 'id'),
  rateLimit: { class: 'read' },
  summary: 'read one task',
  paramSchema: idParamSchema,
  handler: async ({ params }) => getTask(params.id),
});

const PATCH = withRoute({
  method: 'PATCH',
  auth: 'required',
  capability: 'task:update',
  tenant: tenantFromRow('tasks', 'id'),
  rateLimit: { class: 'mutation' },
  summary: 'update a task',
  paramSchema: idParamSchema,
  bodySchema: patchTaskBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    patchTask({ id: params.id, body, auth, request, requestId }),
});

const DELETE = withRoute({
  method: 'DELETE',
  auth: 'required',
  capability: 'task:delete',
  tenant: tenantFromRow('tasks', 'id'),
  rateLimit: { class: 'mutation' },
  successStatus: 204,
  summary: 'soft-delete a task',
  paramSchema: idParamSchema,
  handler: async ({ params, auth, request, requestId }) => {
    await deleteTask({ id: params.id, auth, request, requestId });
  },
});

export { GET, PATCH, DELETE };
