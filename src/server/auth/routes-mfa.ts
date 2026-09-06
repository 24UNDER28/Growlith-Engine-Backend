import 'server-only';

import { z } from 'zod';

import type { AuthContext } from '@/lib/auth/context';
import { hasActiveMembership } from '@/lib/auth/context';
import { landingPathFor } from '@/lib/auth/routes';
import { ApiError } from '@/server/api/errors';
import { createLogger, type Logger } from '@/server/logging/logger';
import { recordAuthEvent } from '@/server/auth/audit';
// JUSTIFIED service-role call site (client-service.ts rule): stamping
// profiles.mfa_enrolled_at mirrors an enrollment performed against the user's
// own session; profiles has no self-service write path until Phase 4 policies
// exist, so the stamp is written here, once, guarded on "never stamped".
import { getSupabaseServiceClient } from '@/server/supabase/client-service';
import { createSupabaseServerClient } from '@/server/supabase/client-server';

/**
 * TOTP MFA flows (design §6c).
 *
 * Three endpoints back three distinct moments:
 *   - ENROLL (any authenticated session): `mfa.enroll` returns the QR/secret
 *     payload the Phase 9 UI renders; no UI ships in this phase.
 *   - CHALLENGE + VERIFY in one call (`{ factorId, code }`): serves BOTH the
 *     login step-up (session at aal1 with verified factors) and the
 *     completion of a fresh enrollment — GoTrue promotes the session to aal2
 *     on success, which is what `requireAuthContext({ minAal: 2 })` checks.
 *   - UNENROLL (fresh aal2 only): removing a factor is exactly the kind of
 *     sensitive change §13 control 8 wants a second factor for.
 *
 * Mandatory enrollment for SUPER_ADMIN/ADMIN is enforced by the ADMIN LAYOUT
 * GUARD (Phase 9 renders it; the guard module exists and is tested in this
 * phase) — enrollment, not denial, because the alternative locks staff out
 * before they can act.
 */

export const mfaVerifyBodySchema = z
  .object({
    factorId: z.uuid({ message: 'factorId must be a valid UUID' }),
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'code must be the 6-digit TOTP code'),
  })
  .strict();

export type MfaVerifyBody = z.infer<typeof mfaVerifyBodySchema>;

export const mfaEnrollBodySchema = z
  .object({
    // For INTERNAL accounts, fresh password re-auth is required before enrollment (H-1).
    // CLIENT accounts may omit it.
    password: z.string().min(1, 'password is required').optional(),
  })
  .strict();

export type MfaEnrollBody = z.infer<typeof mfaEnrollBodySchema>;

export const mfaUnenrollBodySchema = z
  .object({
    factorId: z.uuid({ message: 'factorId must be a valid UUID' }),
  })
  .strict();

export type MfaUnenrollBody = z.infer<typeof mfaUnenrollBodySchema>;

/* ───────────────────────────────── enroll ─────────────────────────────── */

export interface MfaEnrollment {
  readonly factorId: string;
  /** OTPAuth URI the Phase 9 UI turns into a QR code. */
  readonly totpUri: string;
  /** Base32 secret, shown for manual entry when the QR cannot be scanned. */
  readonly secret: string;
  /** The factor is not verified — and the account not aal2 — until verify. */
  readonly qr: string;
}

export async function enrollTotpFactor(input: {
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body?: MfaEnrollBody | undefined;
}): Promise<MfaEnrollment> {
  const log = createLogger({ scope: 'auth-mfa', requestId: input.requestId });
  const supabase = await createSupabaseServerClient();

  // H-1 hardening: INTERNAL accounts must re-authenticate before enrollment.
  // A stolen aal1 cookie alone must not escalate to aal2 via self-enrollment.
  if (input.auth.userType === 'INTERNAL') {
    // If already aal2, no need for password — second factor already proven.
    // Otherwise require fresh password verification.
    if (input.auth.aal !== 'aal2') {
      const password = input.body?.password;
      if (password === undefined || password.length === 0) {
        // Audit the attempted enrollment without re-auth
        await recordAuthEvent({
          action: 'MFA_ENROLLED',
          severity: 'WARNING',
          entityId: input.auth.userId,
          actorUserId: input.auth.userId,
          requestId: input.requestId,
          request: input.request,
          reason: 'INTERNAL enrollment attempted without re-auth — denied',
        });
        log.warn('INTERNAL MFA enroll denied — re-auth required', { userId: input.auth.userId });
        throw ApiError.mfaRequired(
          'Password re-authentication is required to enroll a second factor.',
        );
      }
      // Verify password via re-auth (C-1 audit: failed re-auth is logged)
      const { error: reauthError } = await supabase.auth.signInWithPassword({
        email: input.auth.email,
        password,
      });
      if (reauthError !== null) {
        await recordAuthEvent({
          action: 'LOGIN_FAILED',
          severity: 'WARNING',
          entityId: input.auth.userId,
          actorUserId: input.auth.userId,
          requestId: input.requestId,
          request: input.request,
          after: { reason: 'mfa_enroll_reauth_failed' },
          reason: 'MFA enroll re-auth failed',
        });
        log.warn('INTERNAL MFA enroll re-auth failed', { userId: input.auth.userId });
        throw ApiError.invalidCredentials('Re-authentication failed.');
      }
      log.info('INTERNAL MFA enroll re-auth succeeded', { userId: input.auth.userId });
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Growlith Engine',
  });

  if (error !== null || data === null) {
    throw mapMfaError(error, 'enroll', log, input.auth, input.request, input.requestId);
  }

  if (data.totp === undefined) {
    log.error('mfa.enroll returned no TOTP payload');
    throw ApiError.internal(new Error('mfa.enroll returned no TOTP payload'));
  }

  log.info('TOTP factor enrolled (unverified)', { userId: input.auth.userId });

  // H-1: Notify owner of enrollment (audit + security log for staff factor changes)
  await recordAuthEvent({
    action: 'MFA_ENROLLED',
    severity: 'NOTICE',
    entityId: input.auth.userId,
    actorUserId: input.auth.userId,
    requestId: input.requestId,
    request: input.request,
    after: { factorId: data.id, step: 'enroll' },
    reason: 'TOTP factor enrollment initiated — verify to complete',
  });
  if (input.auth.userType === 'INTERNAL') {
    log.warn('INTERNAL MFA factor enrollment initiated', {
      userId: input.auth.userId,
      factorId: data.id,
    });
    // In production, send email notification with revocation link here.
    // For now, audit + warn covers detection; email wiring is infra concern.
  }

  return {
    factorId: data.id,
    totpUri: data.totp.uri,
    secret: data.totp.secret,
    qr: data.totp.qr_code,
  };
}

/* ──────────────────────────── challenge + verify ───────────────────────── */

export interface MfaVerificationResult {
  /** The session's assurance level after a successful verification. */
  readonly aal: 'aal1' | 'aal2';
  /** Server-derived landing path — the login step-up answers with it (§3). */
  readonly redirectTo: string;
}

export async function challengeAndVerifyTotp(input: {
  readonly body: MfaVerifyBody;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<MfaVerificationResult> {
  const log = createLogger({ scope: 'auth-mfa', requestId: input.requestId });
  const supabase = await createSupabaseServerClient();
  const { factorId, code } = input.body;

  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
    factorId,
  });

  if (challengeError !== null || challenge === null) {
    await auditMfaFailure(
      input.auth,
      input.request,
      input.requestId,
      'challenge',
      challengeError,
      log,
    );
    throw mapMfaError(challengeError, 'challenge', log, input.auth, input.request, input.requestId);
  }

  const { data: verification, error: verifyError } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code,
  });

  if (verifyError !== null || verification === null) {
    // GoTrue enforces per-factor attempt limits; repeated failures are the
    // same envelope, and the client may retry (§12). Audit every failure (C-1).
    await auditMfaFailure(input.auth, input.request, input.requestId, 'verify', verifyError, log);
    throw mapMfaError(verifyError, 'verify', log, input.auth, input.request, input.requestId);
  }

  // The verified session's NEW assurance level — read after the promotion,
  // from the session the promotion just rewrote (never a client assertion).
  const { data: aalData, error: aalError } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel();

  if (aalError !== null) {
    throw mapMfaError(aalError, 'verify', log, input.auth, input.request, input.requestId);
  }
  const aal: 'aal1' | 'aal2' = aalData?.currentLevel === 'aal2' ? 'aal2' : 'aal1';

  // Stamp the enrollment mirror once. `verification` succeeding means the
  // factor is verified from now on.
  await stampEnrollmentMirror(input.auth.userId, log);
  await recordAuthEvent({
    action: 'MFA_ENROLLED',
    severity: 'NOTICE',
    entityId: input.auth.userId,
    actorUserId: input.auth.userId,
    requestId: input.requestId,
    request: input.request,
    after: { factorId, aal },
    reason: 'TOTP factor verified',
  });

  return {
    aal,
    redirectTo: landingPathFor({
      userType: input.auth.userType,
      hasActiveMembership: hasActiveMembership(input.auth),
    }),
  };
}

/* ───────────────────────────────── factors ────────────────────────────── */

export interface MfaFactorSummary {
  readonly factorId: string;
  readonly status: 'verified' | 'unverified';
  readonly friendlyName: string | null;
  readonly createdAt: string | null;
}

export async function listTotpFactors(): Promise<MfaFactorSummary[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.auth.mfa.listFactors();

  if (error !== null || data === null) {
    throw mapMfaError(
      error,
      'listFactors',
      createLogger({ scope: 'auth-mfa' }),
      null as unknown as AuthContext,
      undefined as unknown as Request,
      'unknown',
    );
  }

  return data.totp.map((factor) => ({
    factorId: factor.id,
    status: factor.status,
    friendlyName: factor.friendly_name ?? null,
    createdAt: factor.created_at,
  }));
}

/* ──────────────────────────────── unenroll ─────────────────────────────── */

export async function unenrollTotpFactor(input: {
  readonly body: MfaUnenrollBody;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<void> {
  const log = createLogger({ scope: 'auth-mfa', requestId: input.requestId });

  // A fresh aal2 session is required to remove a factor (§6c, §13 control 8):
  // the context's aal comes from the verified session, not a client assertion.
  if (input.auth.aal !== 'aal2') {
    throw ApiError.mfaRequired('A fresh two-factor session is required to remove a factor.');
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.mfa.unenroll({ factorId: input.body.factorId });

  if (error !== null) {
    throw mapMfaError(error, 'unenroll', log, input.auth, input.request, input.requestId);
  }

  await recordAuthEvent({
    action: 'MFA_REMOVED',
    severity: 'WARNING',
    entityId: input.auth.userId,
    actorUserId: input.auth.userId,
    requestId: input.requestId,
    request: input.request,
    after: { factorId: input.body.factorId },
    reason: 'TOTP factor removed under an aal2 session',
  });

  log.info('TOTP factor removed', { userId: input.auth.userId });
}

/* ───────────────────────────────── internals ──────────────────────────── */

async function stampEnrollmentMirror(userId: string, log: Logger): Promise<void> {
  try {
    const { error } = await getSupabaseServiceClient()
      .from('profiles')
      .update({ mfa_enrolled_at: new Date().toISOString() })
      .eq('id', userId)
      .is('mfa_enrolled_at', null);

    if (error !== null) {
      // The mirror is informational; the auth server owns factor truth.
      log.warn('mfa_enrolled_at mirror stamp failed', { reason: error.message });
    }
  } catch (error) {
    log.warn('mfa_enrolled_at mirror stamp threw', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function auditMfaFailure(
  auth: AuthContext,
  request: Request,
  requestId: string,
  step: string,
  error: { readonly message: string } | null,
  log: Logger,
): Promise<void> {
  log.warn('MFA verification failed', {
    userId: auth.userId,
    step,
    reason: error?.message ?? 'unknown',
  });
  await recordAuthEvent({
    action: 'LOGIN_FAILED',
    severity: 'WARNING',
    entityId: auth.userId,
    actorUserId: auth.userId,
    requestId,
    request,
    after: { reason: 'mfa_failed', step },
    reason: `MFA ${step} failed`,
  });
}

function mapMfaError(
  error: { readonly message: string; readonly status?: number | undefined } | null,
  step: string,
  _log?: Logger,
  _auth?: AuthContext,
  _request?: Request,
  _requestId?: string,
): ApiError {
  if (error === null) {
    return ApiError.internal(new Error(`mfa.${step} returned no data`));
  }
  if (typeof error.status === 'number' && error.status >= 500) {
    return ApiError.serviceUnavailable('The authentication service is temporarily unavailable.');
  }
  // GoTrue's factor errors (unknown factor, wrong code, expired challenge,
  // attempt limits) all map to the credentials family: retryable, uniform.
  // Audit already performed by caller (auditMfaFailure) before throwing.
  return ApiError.invalidCredentials(`The verification code could not be accepted (${step}).`);
}
