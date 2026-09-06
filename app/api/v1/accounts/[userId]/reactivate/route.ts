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
  // `user:update` — the matrix row is `● ●[R] ◦ ◦`: GLOBAL for the platform
  // roles (ADMIN's [R] rule against touching a SUPER_ADMIN's account is
  // evaluated by the guard), SELF for client roles, so a CLIENT_ADMIN may run
  // it on their own account and NOTHING on anyone else's (§I.3 step 6). The
  // tenant resolver is legitimately absent: the winning cell is GLOBAL.
  capability: 'user:update',
  subjectUser: ({ params }) => params.userId,
  denialSubject: { entityKind: 'profile', id: ({ params }) => params.userId },
  minAal: 2,
  rateLimit: { class: 'sensitive' },
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
