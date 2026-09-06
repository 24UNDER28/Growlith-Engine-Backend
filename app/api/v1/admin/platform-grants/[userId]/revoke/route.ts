import { withRoute } from '@/server/api/with-route';
import { revokeGrant } from '@/server/services/grants';
import { revokeGrantBodySchema, userIdParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'platform_grant:delete',
  minAal: 2,
  rateLimit: { class: 'sensitive' },
  successStatus: 204,
  summary: 'revoke a platform role grant',
  paramSchema: userIdParamSchema,
  bodySchema: revokeGrantBodySchema,
  handler: async ({ params, body }) => {
    await revokeGrant({ userId: params.userId, reason: body.reason });
  },
});

export { POST };
