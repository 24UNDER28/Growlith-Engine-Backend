import { withRoute } from '@/server/api/with-route';
import { getNotification, patchNotification } from '@/server/services/notifications';
import { idParamSchema, patchNotificationBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'notification:read',
  rateLimit: { class: 'read' },
  summary: 'read one notification',
  paramSchema: idParamSchema,
  handler: async ({ params, auth }) => getNotification({ id: params.id, auth }),
});

const PATCH = withRoute({
  method: 'PATCH',
  auth: 'required',
  capability: 'notification:update',
  rateLimit: { class: 'mutation' },
  summary: 'mark a notification read or archived',
  paramSchema: idParamSchema,
  bodySchema: patchNotificationBodySchema,
  handler: async ({ params, body, auth }) => patchNotification({ id: params.id, auth, body }),
});

export { GET, PATCH };
