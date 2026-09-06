import { withRoute } from '@/server/api/with-route';
import { tenantFromParam } from '@/server/api/tenant';
import { assignOrganizationManager } from '@/server/services/organizations';
import { assignManagerBodySchema, organizationIdParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'organization:assign',
  tenant: tenantFromParam('organizationId'),
  rateLimit: { class: 'mutation' },
  summary: 'assign an organization account manager',
  paramSchema: organizationIdParamSchema,
  bodySchema: assignManagerBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    assignOrganizationManager({
      id: params.organizationId,
      accountManagerUserId: body.accountManagerUserId,
      auth,
      request,
      requestId,
    }),
});

export { POST };
