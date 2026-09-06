import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { changeProjectStatus } from '@/server/services/projects';
import { idParamSchema, statusChangeBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'project:update',
  tenant: tenantFromRow('projects', 'id'),
  rateLimit: { class: 'mutation' },
  idempotency: true,
  summary: 'change project status',
  paramSchema: idParamSchema,
  bodySchema: statusChangeBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    changeProjectStatus({
      id: params.id,
      status: body.status,
      reason: body.reason,
      auth,
      request,
      requestId,
    }),
});

export { POST };
