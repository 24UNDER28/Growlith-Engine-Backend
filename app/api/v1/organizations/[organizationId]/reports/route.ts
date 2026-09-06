import { withRoute } from '@/server/api/with-route';
import { tenantFromParam } from '@/server/api/tenant';
import { createReport } from '@/server/services/reports';
import { createReportBodySchema, organizationIdParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'report:create',
  tenant: tenantFromParam('organizationId'),
  rateLimit: { class: 'mutation' },
  idempotency: true,
  successStatus: 201,
  location: (data: { readonly id: string }) => `/api/v1/reports/${data.id}`,
  summary: 'create a report',
  paramSchema: organizationIdParamSchema,
  bodySchema: createReportBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    createReport({
      body: { ...body, organizationId: params.organizationId },
      auth,
      request,
      requestId,
    }),
});

export { POST };
