import { z } from 'zod';

import { uuidField } from '@/lib/validation/common';
import { withRoute } from '@/server/api/with-route';
import { resendInvitation } from '@/server/auth/invitations';

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
  summary: 're-send a pending invitation with a fresh token',
  paramSchema: z.object({ id: uuidField('id') }).strict(),
  handler: async ({ params, auth, request, requestId }) =>
    resendInvitation({ id: params.id, auth, request, requestId }),
});

export { POST };
