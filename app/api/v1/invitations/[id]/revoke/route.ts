import { z } from 'zod';

import { optionalTextField, uuidField } from '@/lib/validation/common';
import { withRoute } from '@/server/api/with-route';
import { invitationOrganizationIdForGuard, revokeInvitation } from '@/server/auth/invitations';

/**
 * POST /api/v1/invitations/{id}/revoke — revoke a pending invitation (§2.3).
 *
 * A status flip the acceptance RPC honours. The GoTrue identity is untouched:
 * an unconfirmed, never-accepted identity is inert (no password, no session).
 * The optional justification rides the query string so the POST may be made
 * with no body at all.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  // The row knows its tenant, not the caller (§I.3 step 4): the organization
  // is read through the CALLER's RLS, invisibility is answered 404 log-only
  // before any capability is named, and the audit subject degrades to "actor
  // was denied" because `invitation` is not an `entity_kind` the audit enum
  // knows — never to a fabricated reference.
  capability: 'invitation:update',
  tenant: ({ params }) => invitationOrganizationIdForGuard(params.id),
  rateLimit: { class: 'sensitive' },
  summary: 'revoke a pending invitation',
  paramSchema: z.object({ id: uuidField('id') }).strict(),
  querySchema: z.object({ reason: optionalTextField('reason', 500).optional() }).strict(),
  handler: async ({ params, query, auth, request, requestId }) =>
    revokeInvitation({
      id: params.id,
      ...(query.reason === undefined ? {} : { reason: query.reason }),
      auth,
      request,
      requestId,
    }),
});

export { POST };
