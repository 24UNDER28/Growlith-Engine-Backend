import { withRoute } from '@/server/api/with-route';
import { createGrant, listGrants } from '@/server/services/grants';
import { createGrantBodySchema, grantsListQuerySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'platform_grant:read',
  rateLimit: { class: 'read' },
  pageResult: true,
  summary: 'list platform role grants',
  querySchema: grantsListQuerySchema,
  handler: async ({ query, auth }) => listGrants({ query, auth }),
});

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'platform_grant:create',
  minAal: 2,
  rateLimit: { class: 'sensitive' },
  successStatus: 201,
  location: (_data: { readonly id: string }) => `/api/v1/admin/platform-grants`,
  summary: 'grant a platform role',
  bodySchema: createGrantBodySchema,
  handler: async ({ body }) =>
    createGrant({
      userId: body.userId,
      role: body.role,
      reason: body.reason,
      expiresAt: body.expiresAt,
    }),
});

export { GET, POST };
