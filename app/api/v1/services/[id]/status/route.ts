import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { changeServiceStatus } from '@/server/services/catalog-services';
import { idParamSchema, statusChangeBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'service:update',
  tenant: tenantFromRow('services', 'id'),
  rateLimit: { class: 'mutation' },
  idempotency: true,
  summary: 'change service status',
  paramSchema: idParamSchema,
  bodySchema: statusChangeBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    changeServiceStatus({
      id: params.id,
      status: body.status,
      reason: body.reason,
      auth,
      request,
      requestId,
    }),
});

export { POST };
