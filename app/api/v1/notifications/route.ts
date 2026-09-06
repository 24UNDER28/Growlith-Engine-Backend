import { withRoute } from '@/server/api/with-route';
import { listNotifications } from '@/server/services/notifications';
import { notificationListQuerySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'notification:read',
  rateLimit: { class: 'read' },
  pageResult: true,
  summary: 'list notifications for the signed-in user',
  querySchema: notificationListQuerySchema,
  handler: async ({ query, auth }) => listNotifications({ auth, query }),
});

export { GET };
