import { withRoute } from '@/server/api/with-route';
import { tenantFromParam } from '@/server/api/tenant';
import { getOrganizationSettings, putOrganizationSettings } from '@/server/services/organizations';
import {
  organizationIdParamSchema,
  putOrganizationSettingsBodySchema,
} from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'organization:read',
  tenant: tenantFromParam('organizationId'),
  rateLimit: { class: 'read' },
  summary: 'read organization settings',
  paramSchema: organizationIdParamSchema,
  handler: async ({ params }) => getOrganizationSettings(params.organizationId),
});

const PUT = withRoute({
  method: 'PUT',
  auth: 'required',
  capability: 'organization:manage_settings',
  tenant: tenantFromParam('organizationId'),
  rateLimit: { class: 'mutation' },
  summary: 'replace organization settings',
  paramSchema: organizationIdParamSchema,
  bodySchema: putOrganizationSettingsBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    putOrganizationSettings({ organizationId: params.organizationId, body, auth, request, requestId }),
});

export { GET, PUT };
