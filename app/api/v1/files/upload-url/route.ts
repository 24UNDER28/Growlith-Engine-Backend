import { withRoute } from '@/server/api/with-route';
import { mintUploadUrl, resolveFileParentTenant } from '@/server/services/files';
import { uploadUrlBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'file:upload',
  tenant: ({ body }) => resolveFileParentTenant(body),
  rateLimit: { class: 'export' },
  idempotency: true,
  successStatus: 201,
  summary: 'mint a signed upload URL',
  bodySchema: uploadUrlBodySchema,
  handler: async ({ body }) => mintUploadUrl(body),
});

export { POST };
