import { z } from 'zod';

import { textField, uuidField } from '@/lib/validation/common';
import { ApiError } from '@/server/api/errors';
import { withRoute } from '@/server/api/with-route';
import { reinstateAccount } from '@/server/auth/accounts';

/**
 * POST /api/v1/accounts/{userId}/reinstate — SUSPENDED → ACTIVE (§8).
 *
 * Lifts the GoTrue ban and issues NO resurrected sessions: the user signs in
 * fresh. Platform-admin-gated pending Phase 4 capabilities.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  summary: 'reinstate a suspended account',
  paramSchema: z.object({ userId: uuidField('userId') }).strict(),
  bodySchema: z.object({ reason: textField('reason', 500) }).strict(),
  handler: async ({ params, body, auth, request, requestId }) => {
    if (auth.platformRole === null) {
      throw ApiError.forbidden('A platform role is required to change account statuses.');
    }
    return reinstateAccount({
      actor: { userId: auth.userId, platformRole: auth.platformRole },
      targetUserId: params.userId,
      reason: body.reason,
      requestId,
      request,
    });
  },
});

export { POST };
