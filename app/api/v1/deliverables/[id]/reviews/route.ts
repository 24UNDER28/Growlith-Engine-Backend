import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { submitDeliverableReview } from '@/server/services/deliverables';
import { idParamSchema, reviewBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'deliverable:update',
  tenant: tenantFromRow('deliverables', 'id'),
  rateLimit: { class: 'mutation' },
  idempotency: true,
  successStatus: 201,
  summary: 'submit an internal deliverable review',
  paramSchema: idParamSchema,
  bodySchema: reviewBodySchema,
  handler: async ({ params, body }) =>
    submitDeliverableReview({
      id: params.id,
      outcome: body.outcome,
      notes: body.notes,
      summary: body.summary,
    }),
});

export { POST };
