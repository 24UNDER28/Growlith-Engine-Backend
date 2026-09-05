import { z } from 'zod';

import { textField, uuidField } from '@/lib/validation/common';
import { ApiError } from '@/server/api/errors';
import { withRoute } from '@/server/api/with-route';
import { suspendAccount } from '@/server/auth/accounts';

/**
 * POST /api/v1/accounts/{userId}/suspend — ACTIVE → SUSPENDED (design §8).
 *
 * Platform-admin-gated for now (the live platform role from the resolved
 * context — the trivial check available before Phase 4's capability matrix);
 * every write is audited and every suspension revokes sessions globally and
 * bans the identity at the auth server.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  summary: 'suspend an account and revoke its sessions',
  paramSchema: z.object({ userId: uuidField('userId') }).strict(),
  bodySchema: z.object({ reason: textField('reason', 500) }).strict(),
  handler: async ({ params, body, auth, request, requestId }) => {
    if (auth.platformRole === null) {
      throw ApiError.forbidden('A platform role is required to change account statuses.');
    }
    return suspendAccount({
      actor: { userId: auth.userId, platformRole: auth.platformRole },
      targetUserId: params.userId,
      reason: body.reason,
      requestId,
      request,
    });
  },
});

export { POST };
