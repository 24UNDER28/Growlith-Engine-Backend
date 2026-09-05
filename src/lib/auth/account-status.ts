/**
 * Account-status vocabulary and its legal transitions, as data.
 *
 * SCOPE (Phase 3): statuses describe *who may hold a session and reach the
 * application*. They are deliberately not permissions — fine-grained
 * authorization (capabilities, RLS policies) is Phase 4. This module is the
 * single statement of the status axis that login, every protected surface and
 * the Phase 3 account-status service all consult, so the three cannot disagree.
 *
 * Two axes exist and must never be conflated (Phase 2 schema):
 * - `profiles.account_status` — platform-wide, one value per person.
 * - `organization_memberships.status` — per organization, same value set but a
 *   genuinely different axis: a globally ACTIVE person may be SUSPENDED in one
 *   organization and ACTIVE in another.
 *
 * Mirrors the PostgreSQL enums `public.account_status` and
 * `public.membership_status` from migration 02. A unit test reads the migration
 * SQL and asserts parity, so drift fails CI instead of surfacing in production.
 */

/** Platform-wide lifecycle of a login identity (`profiles.account_status`). */
export const ACCOUNT_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** Per-organization lifecycle (`organization_memberships.status`). */
export const MEMBERSHIP_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/**
 * How each account status is treated by every authenticated surface.
 *
 * The single policy statement behind the behaviour matrix in
 * `docs/architecture/authentication.md` §8:
 *
 * | Status        | Login                   | Authenticated request |
 * | ------------- | ----------------------- | --------------------- |
 * | INVITED       | 403 `INVITATION_PENDING` | 403                   |
 * | ACTIVE        | allowed                 | allowed               |
 * | SUSPENDED     | 423 `ACCOUNT_SUSPENDED`  | 423                   |
 * | DEACTIVATED   | 401 `ACCOUNT_DEACTIVATED`| 401                   |
 *
 * `INVITED` is not "blocked" in the same sense as the other two: the person may
 * complete the invitation flow, whose acceptance endpoint is the one surface
 * that *expects* an INVITED identity. Every other authenticated surface treats
 * INVITED as "pending, not yet a member".
 */
export const ACCOUNT_STATUS_ACCESS = {
  /** May complete invitation acceptance only; all other surfaces reject. */
  INVITED: 'invitation-pending',
  /** Normal authenticated access. */
  ACTIVE: 'allowed',
  /** Authentication may succeed at the auth server, but application access is blocked. */
  SUSPENDED: 'suspended',
  /** Access blocked; the identity is offboarded. */
  DEACTIVATED: 'blocked',
} as const satisfies Record<
  AccountStatus,
  'invitation-pending' | 'allowed' | 'suspended' | 'blocked'
>;

export type AccountAccess = (typeof ACCOUNT_STATUS_ACCESS)[AccountStatus];

/** True only for the status that permits normal authenticated access. */
export function isActiveStatus(status: AccountStatus): boolean {
  return status === 'ACTIVE';
}

/**
 * The legal account-status transition graph, as data.
 *
 * ```
 * INVITED ──accept──▶ ACTIVE ──suspend──▶ SUSPENDED ──reinstate──▶ ACTIVE
 *                        │                     │
 *                        └──deactivate──▶ DEACTIVATED
 * DEACTIVATED ──reactivate (SUPER_ADMIN only)──▶ ACTIVE
 * ```
 *
 * `INVITED → ACTIVE` is *not* listed as an operator-driven transition: it may
 * be performed only by the `accept_invitation` database RPC, never by the
 * account-status service. It is present in the graph because the graph is the
 * truth about the database's state machine, and the RPC is one of its writers.
 *
 * There is deliberately no database trigger enforcing this graph in Phase 3:
 * the transition table belongs beside the Phase 4 definer RPCs that will own
 * all privileged status writes (design §8). Until then this module is the
 * enforcement point the service layer consults.
 */
export const ACCOUNT_STATUS_TRANSITIONS = [
  { from: 'INVITED', to: 'ACTIVE', via: 'accept-invitation', operatorDriven: false },
  { from: 'ACTIVE', to: 'SUSPENDED', via: 'suspend', operatorDriven: true },
  { from: 'SUSPENDED', to: 'ACTIVE', via: 'reinstate', operatorDriven: true },
  { from: 'ACTIVE', to: 'DEACTIVATED', via: 'deactivate', operatorDriven: true },
  { from: 'SUSPENDED', to: 'DEACTIVATED', via: 'deactivate', operatorDriven: true },
  {
    from: 'DEACTIVATED',
    to: 'ACTIVE',
    via: 'reactivate',
    operatorDriven: true,
    /** Restoring an offboarded account is the most privileged status write. */
    requiresSuperAdmin: true,
  },
] as const satisfies readonly AccountStatusTransitionSpec[];

export interface AccountStatusTransitionSpec {
  readonly from: AccountStatus;
  readonly to: AccountStatus;
  readonly via: string;
  readonly operatorDriven: boolean;
  readonly requiresSuperAdmin?: boolean | undefined;
}

export type AccountStatusTransition = (typeof ACCOUNT_STATUS_TRANSITIONS)[number];

/**
 * Whether `from → to` is a legal account-status transition, and (for the
 * operator-driven subset) whether the actor's role is allowed to perform it.
 *
 * @param actorRole the actor's live platform role, already resolved by the
 *   caller (never a JWT claim). `null` for client users.
 */
export function accountTransitionPolicy(
  from: AccountStatus,
  to: AccountStatus,
  actorRole: 'SUPER_ADMIN' | 'ADMIN' | null,
): { allowed: boolean; reason?: string } {
  const transition = ACCOUNT_STATUS_TRANSITIONS.find((t) => t.from === from && t.to === to);

  if (transition === undefined) {
    return { allowed: false, reason: `illegal transition ${from} → ${to}` };
  }

  if (!transition.operatorDriven) {
    return {
      allowed: false,
      reason: `${from} → ${to} is performed only by invitation acceptance`,
    };
  }

  // Phase 3 posture (design §8): until the Phase 4 capability system exists,
  // status writes are gated behind a live platform role. CLIENT_ADMIN's
  // own-org membership writes arrive with capabilities in Phase 4.
  if (actorRole === null) {
    return { allowed: false, reason: 'a platform role is required' };
  }

  if (
    'requiresSuperAdmin' in transition &&
    transition.requiresSuperAdmin &&
    actorRole !== 'SUPER_ADMIN'
  ) {
    return { allowed: false, reason: 'only SUPER_ADMIN may reactivate a deactivated account' };
  }

  return { allowed: true };
}
