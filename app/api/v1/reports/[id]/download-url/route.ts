import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { downloadReportExport } from '@/server/services/reports';
import { idParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'report:download',
  tenant: tenantFromRow('reports', 'id'),
  rateLimit: { class: 'export' },
  summary: 'mint a signed URL for a report export artifact',
  paramSchema: idParamSchema,
  handler: async ({ params, auth, request, requestId }) =>
    downloadReportExport({ id: params.id, auth, request, requestId }),
});

export { GET };
