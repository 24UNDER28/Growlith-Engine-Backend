import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { deleteEngagement, getEngagement, patchEngagement } from '@/server/services/engagements';
import { idParamSchema, patchEngagementBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'engagement:read',
  tenant: tenantFromRow('engagements', 'id'),
  rateLimit: { class: 'read' },
  summary: 'read one engagement',
  paramSchema: idParamSchema,
  handler: async ({ params, auth }) => getEngagement(params.id, auth),
});

const PATCH = withRoute({
  method: 'PATCH',
  auth: 'required',
  capability: 'engagement:update',
  tenant: tenantFromRow('engagements', 'id'),
  rateLimit: { class: 'mutation' },
  summary: 'update an engagement',
  paramSchema: idParamSchema,
  bodySchema: patchEngagementBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    patchEngagement({ id: params.id, body, auth, request, requestId }),
});

const DELETE = withRoute({
  method: 'DELETE',
  auth: 'required',
  capability: 'engagement:delete',
  tenant: tenantFromRow('engagements', 'id'),
  rateLimit: { class: 'mutation' },
  successStatus: 204,
  summary: 'soft-delete an engagement',
  paramSchema: idParamSchema,
  handler: async ({ params, auth, request, requestId }) => {
    await deleteEngagement({ id: params.id, auth, request, requestId });
  },
});

export { GET, PATCH, DELETE };
