import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { changeTaskStatus } from '@/server/services/tasks';
import { idParamSchema, statusChangeBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'task:update',
  tenant: tenantFromRow('tasks', 'id'),
  rateLimit: { class: 'mutation' },
  idempotency: true,
  summary: 'change task status',
  paramSchema: idParamSchema,
  bodySchema: statusChangeBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    changeTaskStatus({
      id: params.id,
      status: body.status,
      reason: body.reason,
      auth,
      request,
      requestId,
    }),
});

export { POST };
