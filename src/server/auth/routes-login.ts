import 'server-only';

import { AuthRetryableFetchError, isAuthApiError } from '@supabase/supabase-js';
import { z } from 'zod';

import type { AuthContext, LoginFailureReason } from '@/lib/auth/context';
import { hasActiveMembership } from '@/lib/auth/context';
import { landingPathFor } from '@/lib/auth/routes';
import { ApiError } from '@/server/api/errors';
import { createLogger, type Logger } from '@/server/logging/logger';
import { recordAuthEvent } from '@/server/auth/audit';
import { requireAuthContext, resolveAuthContext } from '@/server/auth/context';
import { clearSessionCookies } from '@/server/auth/session-cookies';
// JUSTIFIED service-role call sites in this module (client-service.ts rule):
// 1. resolveBannedStatus — the auth server refuses a banned identity BEFORE a
//    session exists, so no user-JWT client can look the profile up; the lookup
//    exists only to tell the ACCOUNT HOLDER which of the two states they are in
//    (423 vs 401), never to disclose anything about other addresses.
// 2. audit LOGIN/LOGIN_FAILED/LOGOUT — audit_events has no user inserts by
//    design (ADR-0020).
import { getSupabaseServiceClient } from '@/server/supabase/client-service';
import { createSupabaseServerClient } from '@/server/supabase/client-server';

/**
 * Login and logout (design §3, §14).
 *
 * The login route is `'public'` at the `withRoute` level — it must be reachable
 * without a session — so it performs its own status gate against the
 * just-issued session through `requireAuthContext()`. This is the one place
 * where the gate's rejection carries extra duties: the brand-new session must
 * be revoked and the cookies cleared before the error envelope is returned.
 */

export const loginBodySchema = z
  .object({
    email: z.email({ message: 'email must be a valid email address' }),
    password: z.string().min(1, 'password is required'),
  })
  .strict();

export type LoginBody = z.infer<typeof loginBodySchema>;

export interface LoginResult {
  readonly user: AuthContext;
  readonly mfaRequired: boolean;
  /** Derived server-side from the resolved context — never from the request. */
  readonly redirectTo: string;
}

export async function performLogin(input: {
  readonly body: LoginBody;
  readonly request: Request;
  readonly requestId: string;
}): Promise<LoginResult> {
  const log = createLogger({ scope: 'auth-login', requestId: input.requestId });
  const supabase = await createSupabaseServerClient();

  // 1. Credential verification through the request-scoped client. On success
  //    GoTrue issues the session and `@supabase/ssr` writes the HttpOnly
  //    cookies — the browser never sees a token (ADR-0026).
  const { data, error } = await supabase.auth.signInWithPassword({
    email: input.body.email,
    password: input.body.password,
  });

  if (error !== null || data.user === null) {
    throw await mapSignInError(error, input.body.email, log);
  }

  const authUserId = data.user.id;

  // 2. Status gate against the just-issued session. Rejections arrive as typed
  //    ApiErrors from requireAuthContext; the extra duty here is the audit row
  //    with the coarse `account_state` reason.
  let context: AuthContext;
  try {
    context = await requireAuthContext();
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      await recordAuthEvent({
        action: 'LOGIN_FAILED',
        severity: 'WARNING',
        entityId: authUserId,
        actorUserId: authUserId,
        requestId: input.requestId,
        request: input.request,
        after: { reason: 'account_state' as LoginFailureReason, status: error.status },
        reason: 'blocked by account status gate',
      });
    }
    throw error;
  }

  // 3. MFA step-up (§3 step 4, §6c): verified factors mean the session is aal1
  //    and every protected surface rejects it until the challenge completes.
  const mfaRequired = context.mfaEnrolled;

  // 4. Audit + response data.
  await recordAuthEvent({
    action: 'LOGIN',
    severity: 'NOTICE',
    entityId: context.userId,
    actorUserId: context.userId,
    requestId: input.requestId,
    request: input.request,
    after: { aal: context.aal, mfaRequired },
  });

  log.info('login succeeded', { userId: context.userId, mfaRequired });

  return {
    user: context,
    mfaRequired,
    redirectTo: landingPathFor({
      userType: context.userType,
      hasActiveMembership: hasActiveMembership(context),
    }),
  };
}

/**
 * Map a GoTrue sign-in error to the public contract.
 *
 * ENUMERATION RESISTANCE (§3, §12): unknown email and wrong password are the
 * same `401 INVALID_CREDENTIALS`, byte for byte. The states that differ
 * (`Email not confirmed`, banned) are states only the REAL account holder can
 * be in: reaching them requires an address that exists AND (for banned) is
 * matched in our profile store — never a password guess.
 */
async function mapSignInError(error: unknown, email: string, log: Logger): Promise<ApiError> {
  if (error === null || error === undefined) {
    return ApiError.invalidCredentials();
  }

  const message = error instanceof Error ? error.message : String(error);

  // Invited-but-never-accepted identities are unconfirmed at the auth server;
  // GoTrue refuses them before any session exists. This is precisely the
  // INVITED row of the §3 table.
  if (/email not confirmed/i.test(message)) {
    return ApiError.invitationPending('This account has not accepted its invitation yet.');
  }

  if (isAuthApiError(error) && error.status === 429) {
    return ApiError.tooManyRequests('Too many sign-in attempts. Please retry later.');
  }

  if (/banned/i.test(message)) {
    return await resolveBannedStatus(email, log);
  }

  if (error instanceof AuthRetryableFetchError || (isAuthApiError(error) && error.status >= 500)) {
    return ApiError.serviceUnavailable('The authentication service is temporarily unavailable.');
  }

  // Uniform failure for unknown address, wrong password and everything else a
  // caller should not be able to distinguish.
  return ApiError.invalidCredentials('The email address or password is incorrect.', error);
}

/**
 * A banned identity is either SUSPENDED (423) or DEACTIVATED (401 with the
 * named code). The profile row — not the auth server — says which (§8).
 */
async function resolveBannedStatus(email: string, log: Logger): Promise<ApiError> {
  try {
    const { data, error } = await getSupabaseServiceClient()
      .from('profiles')
      .select('id, account_status')
      .eq('email', email)
      .is('deleted_at', null)
      .maybeSingle();

    if (error === null && data !== null) {
      if (data.account_status === 'SUSPENDED') {
        return ApiError.accountSuspended();
      }
      if (data.account_status === 'DEACTIVATED') {
        return ApiError.accountDeactivated();
      }
    }
    if (error !== null) {
      log.warn('banned-sign-in status lookup failed', { reason: error.message });
    }
  } catch (cause) {
    log.warn('banned-sign-in status lookup threw', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return ApiError.invalidCredentials();
}

/* ────────────────────────────────── logout ─────────────────────────────── */

/**
 * Logout (§14): global revocation of every refresh token on every device,
 * cookie destruction, idempotent 204. Declared `'public'` at the route level
 * per the §15 taxonomy precisely because it must succeed for expired and
 * revoked sessions too — a logout that 401s creates an error loop, and
 * "idempotency beats error-loop fidelity".
 */
export async function performLogout(input: {
  readonly request: Request;
  readonly requestId: string;
}): Promise<void> {
  const log = createLogger({ scope: 'auth-logout', requestId: input.requestId });
  const supabase = await createSupabaseServerClient();

  // Identity for the audit row, resolved WITHOUT the status gate: a suspended
  // user must still be able to log out cleanly.
  let actorUserId: string | null = null;
  try {
    const context = await resolveAuthContext();
    actorUserId = context?.userId ?? null;
  } catch {
    // No session, or momentarily unresolvable — logout continues either way.
  }

  try {
    // scope 'global': ALL the user's refresh tokens, on every device.
    const { error } = await supabase.auth.signOut({ scope: 'global' });
    if (error !== null) {
      // Nothing to revoke, or GoTrue refused: the response is still 204.
      log.debug('signOut reported an error — treating as idempotent', {
        reason: error.message,
      });
    }
  } catch (error) {
    log.debug('signOut threw — treating as idempotent', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  await clearSessionCookies('auth-logout');

  if (actorUserId !== null) {
    await recordAuthEvent({
      action: 'LOGOUT',
      severity: 'NOTICE',
      entityId: actorUserId,
      actorUserId,
      requestId: input.requestId,
      request: input.request,
      reason: 'global sign-out requested',
    });
  }

  log.info('logout completed', { hadSession: actorUserId !== null });
}
