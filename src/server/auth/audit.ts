import 'server-only';

import { z } from 'zod';

import type { EntityKind } from '@/lib/domain/entities';
import type { Json } from '@/types/database';
import { createLogger } from '@/server/logging/logger';
// JUSTIFIED service-role call site (client-service.ts rule): audit rows must
// be written even when (especially when) the actor's own RLS visibility would
// not permit it — audit_events has NO policies and NO self-service inserts by
// design (Phase 2 migration 21; ADR-0020). The append-only trigger on the
// table is what makes this safe: the service role can INSERT evidence and
// nothing else.
import { getSupabaseServiceClient } from '@/server/supabase/client-service';

/**
 * The Phase 3 authentication audit writer (design §J step 10).
 *
 * Two regimes, and the difference is the whole point (§12):
 *
 * - BEST-EFFORT events (LOGIN, LOGOUT, PASSWORD_RESET_REQUESTED, MFA_*): the
 *   audited outcome stands even if the audit write fails — the failure is
 *   logged with the request id and the world moves on. `recordAuthEvent()`
 *   therefore NEVER throws.
 * - TRANSACTIONAL events (INVITE_ACCEPTED, STATUS_CHANGE, ROLE_GRANT):
 *   written INSIDE the definer RPC by the database, so their failure aborts
 *   the operation. They do not pass through this module.
 *
 * `LOGIN_FAILED` for attempts with NO resolvable principal is a redacted
 * structured log, not an audit row: `audit_events.entity_id` is NOT NULL and a
 * synthetic subject would poison the actor review queries. The coarse reason
 * (`invalid_credentials` | `rate_limited`) never contains credentials.
 */

/** The audit actions this module may write. The DB enum is the superset. */
export const AUTH_AUDIT_ACTIONS = [
  'LOGIN',
  'LOGIN_FAILED',
  'LOGOUT',
  'PASSWORD_RESET_REQUESTED',
  'MFA_ENROLLED',
  'MFA_REMOVED',
  'SESSIONS_REVOKED',
  'INVITE_SENT',
  'ROLE_GRANT',
  'ROLE_REVOKE',
  'STATUS_CHANGE',
  'UPDATE',
  // Phase 4: capability-level denials are audited before the 403 goes out
  // (§11 — "a denied request is still an event"). Tenant-reach denials are
  // deliberately NOT audited: that would make the audit trail a per-tenant
  // probe log, which is the very enumeration side-channel the 404 rule
  // exists to close.
  'PERMISSION_DENIED',
] as const;
export type AuthAuditAction = (typeof AUTH_AUDIT_ACTIONS)[number];

export interface RecordAuthEventInput {
  readonly action: AuthAuditAction;
  readonly severity: 'INFO' | 'NOTICE' | 'WARNING' | 'CRITICAL';
  /** The auditable subject. Login/logout/status events are about a profile. */
  readonly entityId: string;
  readonly entityKind?: EntityKind | undefined;
  readonly actorUserId?: string | undefined;
  readonly actorRole?: string | undefined;
  readonly organizationId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly request?: Request | undefined;
  readonly changedFields?: readonly string[] | undefined;
  readonly before?: Record<string, unknown> | undefined;
  readonly after?: Record<string, unknown> | undefined;
  readonly reason?: string | undefined;
}

const entityIdSchema = z.uuid();

/**
 * Best-effort audit write. Returns `true` when the row landed. Callers that
 * need the write to gate the outcome must use a definer RPC instead — that is
 * what the RPCs are for.
 */
export async function recordAuthEvent(input: RecordAuthEventInput): Promise<boolean> {
  const log = createLogger({ scope: 'auth-audit', requestId: input.requestId });

  if (!entityIdSchema.safeParse(input.entityId).success) {
    // Never let a malformed subject produce a half-auditable row.
    log.warn('audit event rejected — entityId is not a UUID', { action: input.action });
    return false;
  }

  const row = {
    actor_user_id: input.actorUserId ?? null,
    actor_role: input.actorRole ?? null,
    actor_ip: extractActorIp(input.request),
    organization_id: input.organizationId ?? null,
    request_id: input.requestId ?? null,
    entity_kind: input.entityKind ?? ('profile' satisfies EntityKind),
    entity_id: input.entityId,
    action: input.action,
    severity: input.severity,
    changed_fields: input.changedFields === undefined ? null : [...input.changedFields],
    before: input.before === undefined ? null : (JSON.parse(JSON.stringify(input.before)) as Json),
    after: input.after === undefined ? null : (JSON.parse(JSON.stringify(input.after)) as Json),
    reason: input.reason ?? null,
  };

  try {
    const { error } = await getSupabaseServiceClient().from('audit_events').insert(row);
    if (error !== null) {
      log.warn('audit write failed — outcome stands (best-effort event)', {
        action: input.action,
        reason: error.message,
      });
      return false;
    }
    return true;
  } catch (error) {
    log.warn('audit write threw — outcome stands (best-effort event)', {
      action: input.action,
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * First hop of `x-forwarded-for`, when it looks like an IP. Recorded as
 * `actor_ip` (inet); a proxy-supplied junk value is dropped rather than
 * trusted into the column.
 */
function extractActorIp(request: Request | undefined): string | null {
  if (request === undefined) {
    return null;
  }
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded === null) {
    return null;
  }
  const first = forwarded.split(',')[0]?.trim() ?? '';
  return IP_LIKE.test(first) ? first : null;
}

const IP_LIKE = /^[0-9a-fA-F.:]{3,45}$/;
