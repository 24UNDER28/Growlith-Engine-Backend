import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { assignTask } from '@/server/services/tasks';
import { assignTaskBodySchema, idParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'task:assign',
  tenant: tenantFromRow('tasks', 'id'),
  project: async ({ params }) => {
    const { loadLive } = await import('@/server/services/crud');
    const row = await loadLive<{ project_id: string }>('tasks', params.id);
    return row.project_id;
  },
  rateLimit: { class: 'mutation' },
  idempotency: true,
  summary: 'assign a task',
  paramSchema: idParamSchema,
  bodySchema: assignTaskBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    assignTask({
      id: params.id,
      assigneeUserId: body.assigneeUserId,
      auth,
      request,
      requestId,
    }),
});

export { POST };
