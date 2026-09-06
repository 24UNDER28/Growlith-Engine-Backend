import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { publishReport } from '@/server/services/reports';
import { idParamSchema, publishReportBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'report:publish',
  tenant: tenantFromRow('reports', 'id'),
  rateLimit: { class: 'mutation' },
  idempotency: true,
  summary: 'publish a report',
  paramSchema: idParamSchema,
  bodySchema: publishReportBodySchema,
  handler: async ({ params, body }) =>
    publishReport({ id: params.id, clientVisible: body.clientVisible }),
});

export { POST };
