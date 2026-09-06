import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { createDeliverable } from '@/server/services/deliverables';
import { createDeliverableBodySchema, idParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'deliverable:create',
  tenant: tenantFromRow('projects', 'id'),
  rateLimit: { class: 'mutation' },
  idempotency: true,
  successStatus: 201,
  location: (data: { readonly id: string }) => `/api/v1/deliverables/${data.id}`,
  summary: 'create a deliverable under a project',
  paramSchema: idParamSchema,
  bodySchema: createDeliverableBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    createDeliverable({
      body: { ...body, projectId: params.id },
      auth,
      request,
      requestId,
    }),
});

export { POST };
