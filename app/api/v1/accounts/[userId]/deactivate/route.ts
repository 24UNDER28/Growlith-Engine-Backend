import { z } from 'zod';

import { textField, uuidField } from '@/lib/validation/common';
import { ApiError } from '@/server/api/errors';
import { withRoute } from '@/server/api/with-route';
import { deactivateAccount } from '@/server/auth/accounts';

/**
 * POST /api/v1/accounts/{userId}/deactivate — offboarding (§8).
 *
 * ACTIVE or SUSPENDED → DEACTIVATED: memberships deactivated, platform-role
 * grants revoked, sessions revoked, identity banned — while the profile row
 * survives (audit evidence keeps a named actor; erasure is a separate,
 * later, privileged path). Platform-admin-gated pending Phase 4 capabilities.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  summary: 'deactivate an account (offboarding)',
  paramSchema: z.object({ userId: uuidField('userId') }).strict(),
  bodySchema: z.object({ reason: textField('reason', 500) }).strict(),
  handler: async ({ params, body, auth, request, requestId }) => {
    if (auth.platformRole === null) {
      throw ApiError.forbidden('A platform role is required to change account statuses.');
    }
    return deactivateAccount({
      actor: { userId: auth.userId, platformRole: auth.platformRole },
      targetUserId: params.userId,
      reason: body.reason,
      requestId,
      request,
    });
  },
});

export { POST };
