import 'server-only';

import { accountTransitionPolicy, type AccountStatus } from '@/lib/auth/account-status';
import { ApiError } from '@/server/api/errors';
import { createLogger, type Logger } from '@/server/logging/logger';
import { recordAuthEvent } from '@/server/auth/audit';
import {
  getSupabaseServiceClient,
  type SupabaseServiceClient,
} from '@/server/supabase/client-service';
import type { Database } from '@/types/database';

/**
 * The account-status service — the single writer of operator-driven status
 * transitions (design §8). `INVITED → ACTIVE` deliberately has no function
 * here: that transition belongs to `accept_invitation()` alone.
 *
 * Every transition:
 *   1. validates against the transition graph in `src/lib/auth/account-status`;
 *   2. updates `profiles.account_status` through the service client —
 *      JUSTIFIED call site: status administration must exceed the caller's
 *      own RLS visibility, and every write is audited;
 *   3. evicts: global session revocation + a GoTrue ban on suspension and
 *      deactivation (belt and braces — the application gate and the auth
 *      server refuse independently); reinstatement lifts the ban and issues
 *      NO resurrected sessions;
 *   4. deactivation additionally deactivates every live membership and revokes
 *      every live platform-role grant, while deliberately keeping the profile
 *      row (audit evidence needs a named actor);
 *   5. audits `STATUS_CHANGE` (before/after) and `SESSIONS_REVOKED`.
 *
 * Phase 3 authorization posture: the routes calling this service are gated on
 * a live platform role (ADMIN for suspend/reinstate/deactivate, SUPER_ADMIN
 * for reactivate) — the trivial check available before Phase 4's capability
 * matrix. Fine-grained authorization is Phase 4 by instruction.
 */

export interface AccountActor {
  readonly userId: string;
  readonly platformRole: 'SUPER_ADMIN' | 'ADMIN' | null;
}

export interface AccountTransitionInput {
  readonly actor: AccountActor;
  readonly targetUserId: string;
  /** Operator's justification; recorded on every audit row. */
  readonly reason: string;
  readonly requestId?: string;
  readonly request?: Request;
}

export interface AccountTransitionResult {
  readonly userId: string;
  readonly accountStatus: AccountStatus;
  /** Deactivation only: how many live memberships were deactivated. */
  readonly membershipsDeactivated: number;
  /** Deactivation only: how many live platform-role grants were revoked. */
  readonly grantsRevoked: number;
}

type ProfileRow = Database['public']['Tables']['profiles']['Row'];
type PlatformGrantRow = Database['public']['Tables']['platform_role_grants']['Row'];

/** GoTrue ban duration while an account is suspended or deactivated: 10 years.
 * Reinstatement/reactivation lifts it explicitly; the number is just "longer
 * than any suspension" — the ban is a backstop, not a calendar feature. */
const BAN_DURATION = '87600h';

export async function suspendAccount(
  input: AccountTransitionInput,
): Promise<AccountTransitionResult> {
  return transition(input, 'SUSPENDED', 'suspend');
}

export async function reinstateAccount(
  input: AccountTransitionInput,
): Promise<AccountTransitionResult> {
  return transition(input, 'ACTIVE', 'reinstate');
}

export async function deactivateAccount(
  input: AccountTransitionInput,
): Promise<AccountTransitionResult> {
  return transition(input, 'DEACTIVATED', 'deactivate');
}

export async function reactivateAccount(
  input: AccountTransitionInput,
): Promise<AccountTransitionResult> {
  return transition(input, 'ACTIVE', 'reactivate');
}

/* ───────────────────────────────── internals ───────────────────────────── */

type Via = 'suspend' | 'reinstate' | 'deactivate' | 'reactivate';

async function transition(
  input: AccountTransitionInput,
  to: AccountStatus,
  via: Via,
): Promise<AccountTransitionResult> {
  const log = createLogger({ scope: 'accounts', requestId: input.requestId });
  const service = getSupabaseServiceClient();

  const target = await loadProfile(service, input.targetUserId, input.actor.userId);
  const from = target.account_status;

  const policy = accountTransitionPolicy(from, to, input.actor.platformRole);
  if (!policy.allowed) {
    throw ApiError.forbidden(
      `This account status change is not permitted: ${from} → ${to}. ${policy.reason ?? ''}`.trim(),
    );
  }

  // `user:update` for ADMIN carries the [R] rule (§B.1): an ADMIN may change
  // any account EXCEPT a SUPER_ADMIN's. The target's live grant is resolved
  // from the database, never from the request, so a compromised ADMIN cannot
  // suspend or offboard the very accounts that supervise it.
  if (input.actor.platformRole === 'ADMIN' && target.holdsSuperAdmin) {
    throw ApiError.forbidden('Only SUPER_ADMIN may change the status of a SUPER_ADMIN account.');
  }

  // 1. The status write itself. Row is re-fetched under `single()` and the
  //    update guarded on the expected from-status, so two racing operators
  //    cannot double-apply a transition.
  const { data: updated, error: updateError } = await service
    .from('profiles')
    .update({ account_status: to, updated_by: input.actor.userId })
    .eq('id', input.targetUserId)
    .eq('account_status', from)
    .select('id, account_status')
    .single();

  if (updateError !== null || updated === null) {
    // The row moved between read and write: report the conflict honestly.
    throw ApiError.conflict(
      `The account status changed while the request was in flight; reload and retry.`,
      updateError ?? undefined,
    );
  }

  let membershipsDeactivated = 0;
  let grantsRevoked = 0;

  // 2. Deactivation offboards everywhere: live memberships go DEACTIVATED and
  //    live grants gain a revocation. `profiles.deleted_at` is deliberately
  //    NOT set — soft delete is the separate erasure path (§8).
  if (to === 'DEACTIVATED') {
    membershipsDeactivated = await deactivateMemberships(service, input, log);
    grantsRevoked = await revokeGrants(service, input, log);
  }

  // 3. Evictions. SUSPENDED and DEACTIVATED ban the identity so GoTrue itself
  //    refuses new logins AND refuses refresh-token use — which is how session
  //    death is enforced for ANOTHER user's sessions in the pinned auth-js
  //    (its admin.signOut authenticates with a JWT; there is no
  //    revoke-by-user-id). Access tokens live at most until their ≤1 h expiry
  //    — the same stateless-token residual the design records for ordinary
  //    logout (§4). ACTIVE (reinstate/reactivate) lifts the ban and issues NO
  //    resurrected sessions: the user signs in fresh.
  const banning = to === 'SUSPENDED' || to === 'DEACTIVATED';
  await applyBanState(service, input.targetUserId, banning, log);

  // 4. Audit. STATUS_CHANGE always; SESSIONS_REVOKED describes the eviction.
  await recordAuthEvent({
    action: 'STATUS_CHANGE',
    severity: to === 'DEACTIVATED' ? 'CRITICAL' : via === 'reactivate' ? 'CRITICAL' : 'NOTICE',
    entityId: input.targetUserId,
    actorUserId: input.actor.userId,
    actorRole: input.actor.platformRole ?? undefined,
    requestId: input.requestId,
    request: input.request,
    changedFields: ['account_status'],
    before: { accountStatus: from },
    after: { accountStatus: to },
    reason: input.reason,
  });

  if (banning || membershipsDeactivated > 0 || grantsRevoked > 0) {
    await recordAuthEvent({
      action: 'SESSIONS_REVOKED',
      severity: 'NOTICE',
      entityId: input.targetUserId,
      actorUserId: input.actor.userId,
      actorRole: input.actor.platformRole ?? undefined,
      requestId: input.requestId,
      request: input.request,
      after: {
        method: 'gotrue-ban',
        membershipsDeactivated,
        grantsRevoked,
      },
      reason: input.reason,
    });
  }

  log.info('account status transition', { from, to, via, target: input.targetUserId });

  return {
    userId: input.targetUserId,
    accountStatus: updated.account_status,
    membershipsDeactivated,
    grantsRevoked,
  };
}

type ProfileStatusRow = Pick<ProfileRow, 'id' | 'account_status' | 'deleted_at'> & {
  readonly holdsSuperAdmin: boolean;
};

async function loadProfile(
  service: SupabaseServiceClient,
  targetUserId: string,
  actorId: string,
): Promise<ProfileStatusRow> {
  const { data, error } = await service
    .from('profiles')
    .select('id, account_status, deleted_at')
    .eq('id', targetUserId)
    .maybeSingle();

  if (error !== null) {
    throw ApiError.serviceUnavailable('The account could not be loaded.');
  }
  if (data === null || data.deleted_at !== null) {
    // Not found and not visible are the same answer (ADR-0019).
    throw ApiError.notFound('No such account.');
  }
  if (data.id === actorId) {
    // Self-suspension would orphan the operator mid-session and produce an
    // unauditable "who suspended the suspender" row.
    throw ApiError.badRequest('Operators may not change their own account status.');
  }

  // The target's live SUPER_ADMIN grant, for the ADMIN ceiling above. Resolved
  // here (with the rest of the row) so the decision is one honest read rather
  // than a check bolted on after the fact.
  const { data: grants, error: grantsError } = await service
    .from('platform_role_grants')
    .select('role, expires_at')
    .eq('user_id', targetUserId)
    .is('revoked_at', null);

  if (grantsError !== null) {
    throw ApiError.serviceUnavailable('The account could not be loaded.');
  }

  const holdsSuperAdmin = (grants ?? []).some((grant) => {
    const row = grant as Pick<PlatformGrantRow, 'role' | 'expires_at'>;
    const live = row.expires_at === null || Date.parse(row.expires_at) > Date.now();
    return row.role === 'SUPER_ADMIN' && live;
  });

  return {
    id: data.id,
    account_status: data.account_status,
    deleted_at: data.deleted_at,
    holdsSuperAdmin,
  };
}

async function deactivateMemberships(
  service: SupabaseServiceClient,
  input: AccountTransitionInput,
  log: Logger,
): Promise<number> {
  const { data, error } = await service
    .from('organization_memberships')
    .update({ status: 'DEACTIVATED', updated_by: input.actor.userId })
    .eq('user_id', input.targetUserId)
    .neq('status', 'DEACTIVATED')
    .is('deleted_at', null)
    .select('id');

  if (error !== null) {
    log.warn('membership deactivation reported an error', { reason: error.message });
    return 0;
  }
  return data?.length ?? 0;
}

async function revokeGrants(
  service: SupabaseServiceClient,
  input: AccountTransitionInput,
  log: Logger,
): Promise<number> {
  const { data, error } = await service
    .from('platform_role_grants')
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by: input.actor.userId,
      revoke_reason: input.reason,
    })
    .eq('user_id', input.targetUserId)
    .is('revoked_at', null)
    .select('id');

  if (error !== null) {
    log.warn('grant revocation reported an error', { reason: error.message });
    return 0;
  }
  return data?.length ?? 0;
}

async function applyBanState(
  service: SupabaseServiceClient,
  userId: string,
  banned: boolean,
  log: Logger,
): Promise<void> {
  try {
    // JUSTIFIED service-role call site: bans are platform administration on
    // another identity, unreachable through the caller's own session.
    const { error } = await service.auth.admin.updateUserById(userId, {
      ban_duration: banned ? BAN_DURATION : 'none',
    });
    if (error !== null) {
      log.warn('ban state update reported an error', { reason: error.message, banned });
    }
  } catch (error) {
    log.warn('ban state update threw', {
      reason: error instanceof Error ? error.message : String(error),
      banned,
    });
  }
}
