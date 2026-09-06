import { withRoute } from '@/server/api/with-route';
import { tenantFromParam } from '@/server/api/tenant';
import {
  archiveOrganization,
  getOrganization,
  patchOrganization,
} from '@/server/services/organizations';
import {
  archiveOrganizationBodySchema,
  organizationIdParamSchema,
  patchOrganizationBodySchema,
} from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'organization:read',
  tenant: tenantFromParam('organizationId'),
  rateLimit: { class: 'read' },
  summary: 'read one organization',
  paramSchema: organizationIdParamSchema,
  handler: async ({ params }) => getOrganization(params.organizationId),
});

const PATCH = withRoute({
  method: 'PATCH',
  auth: 'required',
  capability: 'organization:update',
  tenant: tenantFromParam('organizationId'),
  rateLimit: { class: 'mutation' },
  summary: 'update an organization',
  paramSchema: organizationIdParamSchema,
  bodySchema: patchOrganizationBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    patchOrganization({ id: params.organizationId, body, auth, request, requestId }),
});

const DELETE = withRoute({
  method: 'DELETE',
  auth: 'required',
  capability: 'organization:delete',
  minAal: 2,
  tenant: tenantFromParam('organizationId'),
  rateLimit: { class: 'sensitive' },
  successStatus: 204,
  summary: 'archive an organization (SUPER_ADMIN)',
  paramSchema: organizationIdParamSchema,
  bodySchema: archiveOrganizationBodySchema,
  handler: async ({ params, body }) => {
    await archiveOrganization({
      id: params.organizationId,
      reason: body.reason,
      confirmSlug: body.confirmSlug,
    });
  },
});

export { GET, PATCH, DELETE };
