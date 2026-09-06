import { withRoute } from '@/server/api/with-route';
import { sharedOrgTenant } from '@/server/api/tenant';
import { getUser } from '@/server/services/users';
import { userIdParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'user:read',
  subjectUser: ({ params }) => params.userId,
  tenant: ({ params, auth }) => sharedOrgTenant(auth, params.userId),
  rateLimit: { class: 'read' },
  summary: 'read one user',
  paramSchema: userIdParamSchema,
  handler: async ({ params }) => getUser(params.userId),
});

export { GET };
