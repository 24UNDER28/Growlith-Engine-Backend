import { withRoute } from '@/server/api/with-route';
import { eraseUser } from '@/server/services/users';
import { eraseUserBodySchema, userIdParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'user:delete',
  minAal: 2,
  subjectUser: ({ params }) => params.userId,
  rateLimit: { class: 'sensitive' },
  successStatus: 204,
  summary: 'erase a user (GDPR, SUPER_ADMIN)',
  paramSchema: userIdParamSchema,
  bodySchema: eraseUserBodySchema,
  handler: async ({ params, body }) => {
    await eraseUser({ userId: params.userId, reason: body.reason });
  },
});

export { POST };
