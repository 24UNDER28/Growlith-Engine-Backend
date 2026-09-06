import { withRoute } from '@/server/api/with-route';
import { tenantFromParam } from '@/server/api/tenant';
import { createEngagement } from '@/server/services/engagements';
import { createEngagementBodySchema, organizationIdParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'engagement:create',
  tenant: tenantFromParam('organizationId'),
  rateLimit: { class: 'mutation' },
  idempotency: true,
  successStatus: 201,
  location: (data: { readonly id: string }) => `/api/v1/engagements/${data.id}`,
  summary: 'create an engagement',
  paramSchema: organizationIdParamSchema,
  bodySchema: createEngagementBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    createEngagement({
      body: { ...body, organizationId: params.organizationId },
      auth,
      request,
      requestId,
    }),
});

export { POST };
