import { z } from 'zod';

import { uuidField } from '@/lib/validation/common';
import { withRoute } from '@/server/api/with-route';
import { invitationOrganizationIdForGuard, resendInvitation } from '@/server/auth/invitations';

/**
 * POST /api/v1/invitations/{id}/resend — re-send a pending invitation (§2.3).
 *
 * Rotates the app token (new token_hash on the same PENDING row; the frozen
 * terms stay frozen), re-runs the GoTrue invite with a fresh mailbox token,
 * bumps `resent_count`, re-audits `INVITE_SENT`.
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
  summary: 're-send a pending invitation with a fresh token',
  paramSchema: z.object({ id: uuidField('id') }).strict(),
  handler: async ({ params, auth, request, requestId }) =>
    resendInvitation({ id: params.id, auth, request, requestId }),
});

export { POST };
