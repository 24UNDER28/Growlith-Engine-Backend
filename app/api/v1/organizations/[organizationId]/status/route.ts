import { withRoute } from '@/server/api/with-route';
import { tenantFromParam } from '@/server/api/tenant';
import { changeOrganizationStatus } from '@/server/services/organizations';
import { organizationIdParamSchema, statusChangeBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'organization:update',
  tenant: tenantFromParam('organizationId'),
  rateLimit: { class: 'mutation' },
  summary: 'change organization status',
  paramSchema: organizationIdParamSchema,
  bodySchema: statusChangeBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    changeOrganizationStatus({
      id: params.organizationId,
      status: body.status,
      reason: body.reason,
      auth,
      request,
      requestId,
    }),
});

export { POST };
