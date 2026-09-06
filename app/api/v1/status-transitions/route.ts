import { withRoute } from '@/server/api/with-route';
import { listStatusTransitions } from '@/server/services/activity';
import { statusTransitionsQuerySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'status_transition:read',
  rateLimit: { class: 'read' },
  summary: 'list allowed status transitions',
  querySchema: statusTransitionsQuerySchema,
  handler: async ({ query }) => listStatusTransitions(query.entityKind),
});

export { GET };
