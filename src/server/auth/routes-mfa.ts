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
}): Promise<MfaEnrollment> {
  const log = createLogger({ scope: 'auth-mfa', requestId: input.requestId });
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Growlith Engine',
  });

  if (error !== null || data === null) {
    throw mapMfaError(error, 'enroll');
  }

  if (data.totp === undefined) {
    log.error('mfa.enroll returned no TOTP payload');
    throw ApiError.internal(new Error('mfa.enroll returned no TOTP payload'));
  }

  log.info('TOTP factor enrolled (unverified)', { userId: input.auth.userId });

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
    throw mapMfaError(challengeError, 'challenge');
  }

  const { data: verification, error: verifyError } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code,
  });

  if (verifyError !== null || verification === null) {
    // GoTrue enforces per-factor attempt limits; repeated failures are the
    // same envelope, and the client may retry (§12).
    throw mapMfaError(verifyError, 'verify');
  }

  // The verified session's NEW assurance level — read after the promotion,
  // from the session the promotion just rewrote (never a client assertion).
  const { data: aalData, error: aalError } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel();

  if (aalError !== null) {
    throw mapMfaError(aalError, 'verify');
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
    throw mapMfaError(error, 'listFactors');
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
    throw mapMfaError(error, 'unenroll');
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

function mapMfaError(
  error: { readonly message: string; readonly status?: number | undefined } | null,
  step: string,
): ApiError {
  if (error === null) {
    return ApiError.internal(new Error(`mfa.${step} returned no data`));
  }
  if (typeof error.status === 'number' && error.status >= 500) {
    return ApiError.serviceUnavailable('The authentication service is temporarily unavailable.');
  }
  // GoTrue's factor errors (unknown factor, wrong code, expired challenge,
  // attempt limits) all map to the credentials family: retryable, uniform.
  return ApiError.invalidCredentials(`The verification code could not be accepted (${step}).`);
}
