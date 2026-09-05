/**
 * The authenticated-principal contract (design §5).
 *
 * `AuthContext` is what `requireAuthContext()` resolves per request and what
 * crosses the server → client boundary as a plain DTO. It lives in `src/lib`
 * because both sides consume it: server code resolves it, and the Phase 9
 * dashboards receive it as props from protected layouts. It is serializable by
 * construction — no class instances, no dates, no functions.
 *
 * NOTHING in here is ever read from a JWT claim (ADR-0011): every field is
 * resolved live from PostgreSQL through the `growlith`-convention definer
 * function `public.auth_context()`, anchored on the network-verified
 * `auth.uid()`. Suspending an account or revoking a role therefore takes effect
 * on the next resolution, with no token rewrite.
 */

import type { AccountStatus, MembershipStatus } from '@/lib/auth/account-status';
import type { OrganizationRole, PlatformRole, ProjectMemberRole } from '@/lib/domain/roles';
import type { InternalTeam } from '@/lib/domain/teams';

/** One organization membership, as seen by the resolved principal. */
export interface AuthContextMembership {
  readonly organizationId: string;
  readonly role: OrganizationRole;
  readonly status: MembershipStatus;
  readonly isPrimaryContact: boolean;
}

/**
 * The resolved principal. Field semantics:
 *
 * - `userId` — `auth.users.id === profiles.id`, verified per request.
 * - `accountStatus` — the platform-wide status axis; gates every surface.
 * - `platformRole` — the live platform role (honouring revocation and expiry),
 *   or `null` for client users. Never a JWT claim.
 * - `memberships` — the caller's live memberships (any non-deleted row). Only
 *   `status === 'ACTIVE'` rows count towards tenant access; the array keeps the
 *   others so callers can render honest "suspended in this organization" state.
 * - `aal` — authenticator assurance level of the *verified* session: `aal1`
 *   password-only, `aal2` after a TOTP step-up. Privileged (`/admin`) surfaces
 *   require `aal2`.
 * - `mfaEnrolled` — whether at least one verified TOTP factor exists. Mandatory
 *   for SUPER_ADMIN/ADMIN (enforced by the admin layout guard, Phase 9).
 */
export interface AuthContext {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly userType: 'INTERNAL' | 'CLIENT';
  readonly accountStatus: AccountStatus;
  readonly platformRole: PlatformRole | null;
  readonly memberships: readonly AuthContextMembership[];
  /**
   * Live staff-team memberships (`staff_team_memberships`). Resolved from the
   * database in the same call as everything else; team scope is advisory for
   * routing and never an authorization gate of its own (§1: the four roles are
   * the authorization axes).
   */
  readonly teams: readonly InternalTeam[];
  /**
   * Live `project_memberships` as `projectId → project role` (§2). Consumed
   * only where the capability matrix carries the `PROJECT_MEMBER` qualifier;
   * authoritative enforcement of object-side membership is the service layer,
   * the triggers and the definer RPCs — never a guess from this map (§D).
   * Capped at 500 entries; see `projectRolesOverflow`.
   */
  readonly projectRoles: Readonly<Record<string, ProjectMemberRole>>;
  /**
   * True when the actor holds more than 500 live project memberships, so
   * `projectRoles` is truncated. A caller must fall back to
   * `project_role_in()` per project instead of treating absence as denial —
   * or as permission. Truncation is flagged, never silently load-bearing.
   */
  readonly projectRolesOverflow: boolean;
  readonly aal: 'aal1' | 'aal2';
  readonly mfaEnrolled: boolean;
  /** RFC-invisible presence hint; null until the first throttled touch. */
  readonly lastSeenAt: string | null;
}

/** True when the context holds at least one ACTIVE membership. */
export function hasActiveMembership(context: AuthContext): boolean {
  return context.memberships.some((membership) => membership.status === 'ACTIVE');
}

/** True when the context's live platform role is SUPER_ADMIN or ADMIN. */
export function isPlatformStaff(context: AuthContext): boolean {
  return context.platformRole !== null;
}

/**
 * Reasons a login attempt failed, for auditing with a coarse vocabulary that
 * can never contain credentials (design §3 step 5). `invalid_credentials`
 * covers both unknown email and wrong password — the two are deliberately
 * indistinguishable everywhere, including here.
 */
export const LOGIN_FAILURE_REASONS = [
  'invalid_credentials',
  'rate_limited',
  'account_state',
] as const;
export type LoginFailureReason = (typeof LOGIN_FAILURE_REASONS)[number];
