import { z } from 'zod';

import { textField, uuidField } from '@/lib/validation/common';
import { ApiError } from '@/server/api/errors';
import { withRoute } from '@/server/api/with-route';
import { reactivateAccount } from '@/server/auth/accounts';

/**
 * POST /api/v1/accounts/{userId}/reactivate — DEACTIVATED → ACTIVE (§8).
 *
 * The most privileged status write in the system: SUPER_ADMIN only, audited at
 * CRITICAL. Memberships and grants are NOT resurrected — they are re-granted
 * deliberately through their own flows.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  summary: 'reactivate a deactivated account (SUPER_ADMIN only)',
  paramSchema: z.object({ userId: uuidField('userId') }).strict(),
  bodySchema: z.object({ reason: textField('reason', 500) }).strict(),
  handler: async ({ params, body, auth, request, requestId }) => {
    if (auth.platformRole !== 'SUPER_ADMIN') {
      throw ApiError.forbidden('Only SUPER_ADMIN may reactivate a deactivated account.');
    }
    return reactivateAccount({
      actor: { userId: auth.userId, platformRole: auth.platformRole },
      targetUserId: params.userId,
      reason: body.reason,
      requestId,
      request,
    });
  },
});

export { POST };
