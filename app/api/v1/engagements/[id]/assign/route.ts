import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { assignEngagementManager } from '@/server/services/engagements';
import { assignManagerBodySchema, idParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'engagement:assign',
  tenant: tenantFromRow('engagements', 'id'),
  rateLimit: { class: 'mutation' },
  summary: 'assign an engagement account manager',
  paramSchema: idParamSchema,
  bodySchema: assignManagerBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    assignEngagementManager({
      id: params.id,
      accountManagerUserId: body.accountManagerUserId,
      auth,
      request,
      requestId,
    }),
});

export { POST };
