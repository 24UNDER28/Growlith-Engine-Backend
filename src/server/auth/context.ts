import 'server-only';

import { cache } from 'react';
import { after } from 'next/server';
import {
  AuthRetryableFetchError,
  isAuthApiError,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';

import { z } from 'zod';
import type { AuthContext } from '@/lib/auth/context';
import { ErrorCode } from '@/lib/types/error-codes';
import { ApiError } from '@/server/api/errors';
import { createLogger, type Logger } from '@/server/logging/logger';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
// JUSTIFIED service-role call sites (client-service.ts rule): the status gate
// belts-and-braces the eviction with a GoTrue BAN on the identity — an
// operation that must exceed the caller's own rights by definition, and one
// the pinned auth-js cannot express through the user session (its
// admin.signOut authenticates with a JWT; there is no revoke-by-user-id).
// See enforceAccountStatus for the full eviction semantics.
import { getSupabaseServiceClient } from '@/server/supabase/client-service';
import { clearSessionCookies } from '@/server/auth/session-cookies';

/**
 * requireAuthContext() — the ONLY function that decides "who is this request"
 * (design §5). Everything else — middleware, layout guards, handlers — asks
 * here. It is the single authority, and it never trusts a locally decoded
 * token: identity is verified by a network `getUser()` against Supabase, and
 * every authorization-relevant fact (status, platform role, memberships) is
 * resolved by the database through the `SECURITY DEFINER` function
 * `public.auth_context()` — the same predicates Phase 4's RLS policies will
 * use (ADR-0011: the database is the only authority on roles and status).
 *
 * Steps, in order (§5):
 *   1. request-scoped user client (anon key + the caller's cookies);
 *   2. `getUser()` — network verification: signature, expiry, identity exists;
 *   3. one round trip: `auth_context()` through the user-JWT client;
 *   4. status gate (§8): SUSPENDED → 423, DEACTIVATED → 401, INVITED → 403,
 *      each with best-effort global revocation + cookie clearing;
 *   5. per-request memoisation via React `cache()`;
 *   6. presence: a throttled `touch_last_seen()` scheduled with `after()`.
 *
 * `getSession()` is BANNED for decisions (architecture test): it trusts the
 * locally stored token without verification. The assurance level is read with
 * `getAuthenticatorAssuranceLevel()`, which reads the `aal` claim of the same
 * access token that `getUser()` just verified against the server — a signed,
 * server-issued claim, not a client assertion.
 */

/** Options for {@link requireAuthContext}. */
export interface RequireAuthContextOptions {
  /**
   * Minimum authenticator assurance level. `2` requires a completed TOTP
   * step-up; used by the admin layout guard and privileged MFA routes (§6c).
   */
  readonly minAal?: 1 | 2;
}

/** Options for {@link resolveAuthContext}. */
export interface ResolveAuthContextOptions {
  /**
   * Skip the account-status gate. Used by surfaces that REPORT state rather
   * than gate on it (`GET /api/v1/auth/session`, §6) and by the invitation
   * flow, whose whole job is to move an INVITED identity to ACTIVE.
   */
  readonly skipStatusGate?: boolean;
}

/* ───────────────────────── wire shape of auth_context() ────────────────── */

const authContextSchema = z.object({
  userId: z.string().min(1),
  email: z.string().min(1),
  fullName: z.string().min(1),
  userType: z.enum(['INTERNAL', 'CLIENT']),
  accountStatus: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED']),
  lastSeenAt: z.string().min(1).nullable(),
  mfaEnrolledAt: z.string().min(1).nullable(),
  platformRole: z.enum(['SUPER_ADMIN', 'ADMIN']).nullable(),
  memberships: z
    .array(
      z.object({
        organizationId: z.string().min(1),
        role: z.enum(['CLIENT_ADMIN', 'CLIENT_MEMBER']),
        status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED']),
        isPrimaryContact: z.boolean(),
      }),
    )
    .max(50),
});

/** The throttled presence window; mirrors `touch_last_seen()`'s SQL. */
const PRESENCE_THRESHOLD_MS = 5 * 60 * 1000;

/* ─────────────────────────────────── core ──────────────────────────────── */

async function resolveAuthContextUncached(
  options: ResolveAuthContextOptions = {},
): Promise<AuthContext> {
  const log = createLogger({ scope: 'auth-context' });
  const supabase = await createSupabaseServerClient();

  // Step 2 — network verification. A decision is never made from a locally
  // stored token.
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError !== null || user === null) {
    // Never null: this helper always throws (unauthenticated or unavailable).
    return throwUnauthenticatedOrUnavailable(userError, log);
  }

  // Step 3 — one round trip: the database resolves identity + state.
  const context = await resolveDatabaseContext(supabase, user, log);

  // Step 4 — the status gate, unless the caller explicitly reports state.
  if (options.skipStatusGate !== true) {
    await enforceAccountStatus(supabase, context, log);
  }

  // Step 6 — presence, throttled app-side AND in SQL, never blocking the
  // response (`after()`); outside a request scope (tests, tooling) it is
  // skipped at debug level.
  schedulePresenceTouch(supabase, context, log);

  return context;
}

/**
 * Resolve and validate the database context. `null` means "verified identity,
 * no live profile row" — an integrity violation the trigger makes nearly
 * impossible — treated as unauthenticated with a loud log, because an
 * authenticated principal invisible to policy is the worst possible state.
 */
async function resolveDatabaseContext(
  supabase: SupabaseClient,
  user: User,
  log: Logger,
): Promise<AuthContext> {
  let raw: unknown;
  try {
    const { data, error } = await supabase.rpc('auth_context', {});
    if (error !== null) {
      // PostgREST refused the call: definer grants or availability problem.
      // Fail CLOSED but distinguishably (503, not 401).
      throw ApiError.serviceUnavailable('The session could not be verified against the database.');
    }
    raw = data;
  } catch (error) {
    if (isApiError(error)) {
      throw error;
    }
    throw ApiError.serviceUnavailable('The session could not be verified against the database.');
  }

  if (raw === null || raw === undefined) {
    log.error('verified user has no live profile row — treating as unauthenticated', {
      userId: user.id,
    });
    throw ApiError.unauthenticated();
  }

  const parsed = authContextSchema.safeParse(raw);
  if (!parsed.success) {
    log.error('auth_context() returned an unexpected shape', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
      })),
    });
    throw ApiError.internal(parsed.error);
  }

  // The assurance level of the SAME token getUser() just verified. `null`
  // (no session claim) is treated as aal1: unknown never satisfies a minAal 2
  // requirement.
  const { data: aalData, error: aalError } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel();

  if (aalError !== null) {
    throwUnauthenticatedOrUnavailable(aalError, log);
  }

  const aal: 'aal1' | 'aal2' = aalData?.currentLevel === 'aal2' ? 'aal2' : 'aal1';

  return {
    userId: parsed.data.userId,
    email: parsed.data.email,
    fullName: parsed.data.fullName,
    userType: parsed.data.userType,
    accountStatus: parsed.data.accountStatus,
    platformRole: parsed.data.platformRole,
    memberships: parsed.data.memberships.map((membership) => ({
      organizationId: membership.organizationId,
      role: membership.role,
      status: membership.status,
      isPrimaryContact: membership.isPrimaryContact,
    })),
    aal,
    mfaEnrolled: user.factors?.some((factor) => factor.status === 'verified') ?? false,
    lastSeenAt: parsed.data.lastSeenAt,
  };
}

/**
 * The status gate (§8 behaviour matrix). Each rejection performs the same
 * eviction: a GLOBAL sign-out through the request-scoped client — the session
 * being rejected is the caller's own, so the user-scoped `signOut` revokes
 * every refresh token for that identity on every device — plus a best-effort
 * GoTrue ban (belt and braces: the status service already bans at the write,
 * this covers statuses changed out-of-band), plus local cookie clearing.
 *
 * Residual risk, stated (§4): the already-issued ACCESS token of the device
 * in flight remains valid until expiry (GoTrue access tokens are stateless,
 * ≤1 h). The refresh tokens are dead and the cookie is destroyed, so the
 * eviction completes at latest at access-token expiry.
 */
async function enforceAccountStatus(
  supabase: SupabaseClient,
  context: AuthContext,
  log: Logger,
): Promise<void> {
  switch (context.accountStatus) {
    case 'ACTIVE':
      return;

    case 'SUSPENDED':
    case 'DEACTIVATED':
    case 'INVITED': {
      // INVITED may complete the invitation flow — and ONLY that. The
      // confirmation callback does not route through this gate; every other
      // surface sees "pending, not yet a member", and the session it holds
      // cannot be used anywhere else, so it is evicted like the others.
      await evictOwnSessions(supabase, context.userId, log);
      await banIdentity(context.userId, log);
      await clearSessionCookies('auth-status-gate');

      if (context.accountStatus === 'SUSPENDED') {
        throw ApiError.accountSuspended();
      }
      if (context.accountStatus === 'DEACTIVATED') {
        throw ApiError.accountDeactivated();
      }
      throw ApiError.invitationPending();
    }

    default: {
      // Exhaustiveness guard: a new status value must acquire a policy here
      // before it can compile, not after it ships.
      const exhausted: never = context.accountStatus;
      throw ApiError.internal(new Error(`unhandled account status: ${String(exhausted)}`));
    }
  }
}

/** Global refresh-token revocation for the caller's OWN identity. */
async function evictOwnSessions(
  supabase: SupabaseClient,
  userId: string,
  log: Logger,
): Promise<void> {
  try {
    const { error } = await supabase.auth.signOut({ scope: 'global' });
    if (error !== null) {
      log.warn('own-session global revocation reported an error', {
        userId,
        reason: error.message,
      });
    }
  } catch (error) {
    log.warn('own-session global revocation failed', {
      userId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Best-effort GoTrue ban. The pinned auth-js `admin.signOut` authenticates
 * with a JWT rather than revoking by user id, so a ban — which makes GoTrue
 * refuse new logins AND refresh-token use — is the platform's by-identity
 * kill switch, independent of holding the user's session.
 */
async function banIdentity(userId: string, log: Logger): Promise<void> {
  try {
    // JUSTIFIED service-role call site: banning is administration of another
    // identity's ability to authenticate, unreachable through the caller's
    // own session.
    const { error } = await getSupabaseServiceClient().auth.admin.updateUserById(userId, {
      ban_duration: '87600h',
    });
    if (error !== null) {
      log.debug('status-gate ban reported an error', { reason: error.message });
    }
  } catch (error) {
    log.debug('status-gate ban threw', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function schedulePresenceTouch(supabase: SupabaseClient, context: AuthContext, log: Logger): void {
  const stale =
    context.lastSeenAt === null ||
    Date.now() - Date.parse(context.lastSeenAt) > PRESENCE_THRESHOLD_MS;

  if (!stale) {
    return;
  }

  try {
    after(async () => {
      try {
        await supabase.rpc('touch_last_seen', {});
      } catch (error) {
        log.debug('presence touch failed', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    });
  } catch {
    // Outside a request scope (tests, scripts) — nothing to defer into.
    log.debug('presence touch skipped — no request scope');
  }
}

/**
 * Map a Supabase auth error to the correct failure class.
 *
 * Supabase being UNREACHABLE is unavailability, not anonymity (§7): the caller
 * gets 503, never a silent 401 that would look like "please log in" while the
 * real problem is an outage. Everything else — missing session, expired and
 * unrefreshable token, revoked token family — is a plain 401.
 */
function throwUnauthenticatedOrUnavailable(error: unknown, log: Logger): never {
  if (error instanceof AuthRetryableFetchError || (isAuthApiError(error) && error.status >= 500)) {
    log.warn('auth verification unavailable', {
      reason: error instanceof Error ? error.message : String(error),
    });
    throw ApiError.serviceUnavailable('The authentication service is temporarily unavailable.');
  }
  log.debug('no verified session', {
    reason: error instanceof Error ? error.message : String(error),
  });
  throw ApiError.unauthenticated();
}

function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/* ─────────────────────────────── public API ────────────────────────────── */

/**
 * Resolve the caller's context WITHOUT the status gate: `null` when
 * unauthenticated. For state-reporting surfaces (`/api/v1/auth/session`) that
 * must return 200 with data rather than 401, and for the invitation flow.
 *
 * Unavailability still throws (503) — a reporting endpoint must not report
 * "logged out" during an outage. Memoised per request via `cache()`.
 */
export const resolveAuthContext = cache(async (): Promise<AuthContext | null> => {
  try {
    return await resolveAuthContextUncached({ skipStatusGate: true });
  } catch (error) {
    // "No session" is DATA (null), not an error, for reporting surfaces; the
    // auth endpoints' own failures (401 UNAUTHENTICATED from the gate) never
    // reach here because the gate is skipped.
    if (error instanceof ApiError && error.code === ErrorCode.Unauthenticated) {
      return null;
    }
    throw error;
  }
});

/**
 * The authoritative check for every protected surface (API via `withRoute`,
 * pages via the layout guards). Throws the §8 matrix as typed `ApiError`s:
 * 401 `UNAUTHENTICATED`, 403 `INVITATION_PENDING`, 423 `ACCOUNT_SUSPENDED`,
 * 401 `ACCOUNT_DEACTIVATED`, 401 `MFA_REQUIRED`, 503 `SERVICE_UNAVAILABLE`.
 *
 * Memoised per request keyed on the `minAal` primitive, so a handler and a
 * guard in the same request that agree on the level resolve once.
 */
const resolveGated = cache(async (minAal: 1 | 2 | undefined): Promise<AuthContext> => {
  const context = await resolveAuthContextUncached({ skipStatusGate: false });
  if (minAal === 2 && context.aal !== 'aal2') {
    throw ApiError.mfaRequired();
  }
  return context;
});

export async function requireAuthContext(
  options: RequireAuthContextOptions = {},
): Promise<AuthContext> {
  return resolveGated(options.minAal);
}
