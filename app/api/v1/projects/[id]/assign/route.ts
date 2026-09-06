import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { assignProject } from '@/server/services/projects';
import { assignProjectBodySchema, idParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'project:assign',
  tenant: tenantFromRow('projects', 'id'),
  project: ({ params }) => params.id,
  rateLimit: { class: 'mutation' },
  idempotency: true,
  summary: 'assign a project lead or owning team',
  paramSchema: idParamSchema,
  bodySchema: assignProjectBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    assignProject({
      id: params.id,
      leadUserId: body.leadUserId,
      owningTeam: body.owningTeam,
      auth,
      request,
      requestId,
    }),
});

export { POST };
