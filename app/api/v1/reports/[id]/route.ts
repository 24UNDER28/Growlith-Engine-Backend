import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { deleteReport, getReportWithMetrics, patchReport } from '@/server/services/reports';
import { idParamSchema, patchReportBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'report:read',
  tenant: tenantFromRow('reports', 'id'),
  rateLimit: { class: 'read' },
  summary: 'read one report with frozen metrics',
  paramSchema: idParamSchema,
  handler: async ({ params }) => getReportWithMetrics(params.id),
});

const PATCH = withRoute({
  method: 'PATCH',
  auth: 'required',
  capability: 'report:update',
  tenant: tenantFromRow('reports', 'id'),
  rateLimit: { class: 'mutation' },
  summary: 'update a report',
  paramSchema: idParamSchema,
  bodySchema: patchReportBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    patchReport({ id: params.id, body, auth, request, requestId }),
});

const DELETE = withRoute({
  method: 'DELETE',
  auth: 'required',
  capability: 'report:delete',
  tenant: tenantFromRow('reports', 'id'),
  rateLimit: { class: 'mutation' },
  successStatus: 204,
  summary: 'soft-delete a report',
  paramSchema: idParamSchema,
  handler: async ({ params, auth, request, requestId }) => {
    await deleteReport({ id: params.id, auth, request, requestId });
  },
});

export { GET, PATCH, DELETE };
