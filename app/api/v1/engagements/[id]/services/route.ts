import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { createService } from '@/server/services/catalog-services';
import { createServiceBodySchema, idParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'service:create',
  tenant: tenantFromRow('engagements', 'id'),
  rateLimit: { class: 'mutation' },
  idempotency: true,
  successStatus: 201,
  location: (data: { readonly id: string }) => `/api/v1/services/${data.id}`,
  summary: 'create a service under an engagement',
  paramSchema: idParamSchema,
  bodySchema: createServiceBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    createService({
      body: { ...body, engagementId: params.id },
      auth,
      request,
      requestId,
    }),
});

export { POST };
