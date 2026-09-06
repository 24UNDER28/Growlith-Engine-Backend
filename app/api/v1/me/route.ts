import { withRoute } from '@/server/api/with-route';
import { firstActiveMembershipTenant } from '@/server/api/tenant';
import { getMe, patchMe } from '@/server/services/users';
import { patchMeBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'user:read',
  tenant: ({ auth }) =>
    auth.platformRole !== null ? undefined : firstActiveMembershipTenant(auth),
  rateLimit: { class: 'read' },
  summary: 'read the signed-in profile',
  handler: async ({ auth }) => getMe(auth),
});

const PATCH = withRoute({
  method: 'PATCH',
  auth: 'required',
  capability: 'user:update',
  subjectUser: ({ auth }) => auth.userId,
  tenant: ({ auth }) =>
    auth.platformRole !== null ? undefined : firstActiveMembershipTenant(auth),
  rateLimit: { class: 'mutation' },
  summary: 'update the signed-in profile',
  bodySchema: patchMeBodySchema,
  handler: async ({ body, auth, request, requestId }) =>
    patchMe({ auth, request, requestId, body }),
});

export { GET, PATCH };
