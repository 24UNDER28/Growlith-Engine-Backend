import { withRoute } from '@/server/api/with-route';
import { createOrganization, listOrganizations } from '@/server/services/organizations';
import { createOrganizationBodySchema, orgListQuerySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'organization:read',
  tenant: () => undefined,
  rateLimit: { class: 'read' },
  pageResult: true,
  summary: 'list organizations',
  querySchema: orgListQuerySchema,
  handler: async ({ query }) => listOrganizations({ query }),
});

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'organization:create',
  tenant: () => undefined,
  rateLimit: { class: 'mutation' },
  idempotency: true,
  successStatus: 201,
  location: (data: { readonly id: string }) => `/api/v1/organizations/${data.id}`,
  summary: 'create an organization',
  bodySchema: createOrganizationBodySchema,
  handler: async ({ body, auth, request, requestId }) =>
    createOrganization({ body, auth, request, requestId }),
});

export { GET, POST };
