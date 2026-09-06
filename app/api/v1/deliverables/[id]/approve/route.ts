import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { approveDeliverable } from '@/server/services/deliverables';
import { idParamSchema, reviewBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'deliverable:approve',
  tenant: tenantFromRow('deliverables', 'id'),
  rateLimit: { class: 'mutation' },
  summary: 'approve or reject a deliverable (client)',
  paramSchema: idParamSchema,
  bodySchema: reviewBodySchema,
  handler: async ({ params, body }) =>
    approveDeliverable({ id: params.id, outcome: body.outcome, notes: body.notes }),
});

export { POST };
