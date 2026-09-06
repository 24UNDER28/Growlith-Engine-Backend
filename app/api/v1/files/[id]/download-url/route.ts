import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { downloadFile } from '@/server/services/files';
import { idParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'file:download',
  tenant: tenantFromRow('files', 'id'),
  rateLimit: { class: 'export' },
  summary: 'mint a signed download URL',
  paramSchema: idParamSchema,
  handler: async ({ params, auth, request, requestId }) =>
    downloadFile({ id: params.id, auth, request, requestId }),
});

export { POST };
