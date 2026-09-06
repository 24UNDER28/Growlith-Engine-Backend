import 'server-only';

import type { EntityKind } from '@/lib/domain/entities';
import type { AuthContext } from '@/lib/auth/context';
import { ApiError } from '@/server/api/errors';
import { recordAuthEvent, type AuthAuditAction } from '@/server/auth/audit';

/**
 * Fail-closed mutation audit. A write that cannot be evidenced did not happen
 * as far as the API is concerned — we throw 503 so the caller retries rather
 * than silently producing an unaudited change.
 *
 * In-transaction RPC mutations (membership, grants, erase, purge, archive,
 * approve, publish) write their own audit row inside the definer body and
 * MUST NOT call this helper: a second write would be a second source of
 * truth, and the RPC's own failure already rolls the audit back.
 */
export async function recordMutation(input: {
  readonly action: AuthAuditAction;
  readonly severity?: 'INFO' | 'NOTICE' | 'WARNING' | 'CRITICAL' | undefined;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly entityKind: EntityKind;
  readonly entityId: string;
  readonly organizationId?: string | null | undefined;
  readonly changedFields?: readonly string[] | undefined;
  readonly before?: Record<string, unknown> | undefined;
  readonly after?: Record<string, unknown> | undefined;
  readonly reason?: string | undefined;
}): Promise<void> {
  const ok = await recordAuthEvent({
    action: input.action,
    severity: input.severity ?? (input.action === 'SOFT_DELETE' ? 'NOTICE' : 'INFO'),
    entityId: input.entityId,
    entityKind: input.entityKind,
    actorUserId: input.auth.userId,
    actorRole: input.auth.platformRole ?? undefined,
    organizationId: input.organizationId ?? undefined,
    requestId: input.requestId,
    request: input.request,
    changedFields: input.changedFields,
    before: input.before,
    after: input.after,
    reason: input.reason,
  });
  if (!ok) {
    throw ApiError.serviceUnavailable('The change could not be audited.');
  }
}
