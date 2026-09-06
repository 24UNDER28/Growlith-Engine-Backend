import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { changeEngagementStatus } from '@/server/services/engagements';
import { idParamSchema, statusChangeBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'engagement:update',
  tenant: tenantFromRow('engagements', 'id'),
  rateLimit: { class: 'mutation' },
  idempotency: true,
  summary: 'change engagement status',
  paramSchema: idParamSchema,
  bodySchema: statusChangeBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    changeEngagementStatus({
      id: params.id,
      status: body.status,
      reason: body.reason,
      auth,
      request,
      requestId,
    }),
});

export { POST };
