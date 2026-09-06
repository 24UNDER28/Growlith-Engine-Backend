import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { assignService } from '@/server/services/catalog-services';
import { assignLeadBodySchema, idParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'service:assign',
  tenant: tenantFromRow('services', 'id'),
  rateLimit: { class: 'mutation' },
  idempotency: true,
  summary: 'assign a service lead or delivering team',
  paramSchema: idParamSchema,
  bodySchema: assignLeadBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    assignService({
      id: params.id,
      leadUserId: body.leadUserId,
      deliveringTeam: body.deliveringTeam,
      auth,
      request,
      requestId,
    }),
});

export { POST };
