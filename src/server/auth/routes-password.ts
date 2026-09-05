import 'server-only';

import { z } from 'zod';

import type { AuthContext } from '@/lib/auth/context';
import { RESET_PASSWORD_PATH } from '@/lib/auth/routes';
import { ApiError } from '@/server/api/errors';
import { getClientEnv } from '@/lib/env/client-env';
import { createLogger } from '@/server/logging/logger';
import { recordAuthEvent } from '@/server/auth/audit';
// JUSTIFIED service-role call site (client-service.ts rule): deciding whether
// a recovery email should be sent requires reading the profile's account
// status — before any session exists. The response is 202 either way, so the
// lookup can never be used to enumerate addresses (§9).
import { getSupabaseServiceClient } from '@/server/supabase/client-service';
import { createSupabaseServerClient } from '@/server/supabase/client-server';

/**
 * Password flows (design §9).
 *
 * Two endpoints, one policy: recovery requests are NON-DISCLOSING (always 202,
 * identical shape and latency path whether or not the address exists), and the
 * password set/change requires a session — either a recovery session (mailbox
 * control is the credential, §9 step 2) or the post-invitation session (first
 * password set, §2.2 step 3).
 *
 * The binding password POLICY lives in GoTrue configuration (minimum length,
 * leak protection — §H), never in application code: the Zod schemas below
 * check only presence and shape, and GoTrue's policy errors map to a 422 the
 * browser can render.
 */

export const passwordRecoveryBodySchema = z
  .object({
    email: z.email({ message: 'email must be a valid email address' }),
  })
  .strict();

export type PasswordRecoveryBody = z.infer<typeof passwordRecoveryBodySchema>;

export const passwordSetBodySchema = z
  .object({
    // Presence + a transport-plausible bound only. The binding length/leak
    // policy is enforced by GoTrue (§H) and its error is mapped below.
    password: z.string().min(1, 'password is required').max(256, 'password is too long'),
  })
  .strict();

export type PasswordSetBody = z.infer<typeof passwordSetBodySchema>;

/* ──────────────────────────── recovery request ─────────────────────────── */

/**
 * Request a recovery email. ALWAYS "succeeds" from the caller's perspective:
 * the same 202 envelope whether the address is unknown, INVITED, SUSPENDED,
 * DEACTIVATED or ACTIVE. Only the last case sends mail — an INVITED account
 * has nothing to recover (its link is still in flight), and a suspended or
 * deactivated account must not regain a session by proving mailbox control.
 */
export async function requestPasswordRecovery(input: {
  readonly body: PasswordRecoveryBody;
  readonly request: Request;
  readonly requestId: string;
}): Promise<void> {
  const log = createLogger({ scope: 'auth-recovery', requestId: input.requestId });
  const email = input.body.email.trim().toLowerCase();

  let profileId: string | null = null;
  let sendable = false;
  try {
    const { data, error } = await getSupabaseServiceClient()
      .from('profiles')
      .select('id, account_status')
      .eq('email', email)
      .is('deleted_at', null)
      .maybeSingle();

    if (error !== null) {
      log.warn('recovery eligibility lookup failed — responding 202 regardless', {
        reason: error.message,
      });
    } else if (data !== null) {
      profileId = data.id;
      sendable = data.account_status === 'ACTIVE';
    }
  } catch (error) {
    log.warn('recovery eligibility lookup threw — responding 202 regardless', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  if (!sendable) {
    // Identical outcome, identical timing profile, no mail. Log at debug with
    // NO address: even server logs keep enumeration discipline (§12).
    log.debug('recovery request evaluated');
    return;
  }

  const { NEXT_PUBLIC_APP_URL: appUrl } = getClientEnv();
  const supabase = await createSupabaseServerClient();

  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${appUrl}/auth/confirm?type=recovery&next=${RESET_PASSWORD_PATH}`,
    });

    if (error !== null) {
      // A GoTrue send failure is an availability problem, not a disclosure
      // opportunity: still 202 (the user retries; support sees the log).
      log.warn('recovery email could not be sent — responding 202 regardless', {
        reason: error.message,
      });
      return;
    }

    if (profileId !== null) {
      await recordAuthEvent({
        action: 'PASSWORD_RESET_REQUESTED',
        severity: 'NOTICE',
        entityId: profileId,
        actorUserId: profileId,
        requestId: input.requestId,
        request: input.request,
        reason: 'recovery email sent',
      });
    }
  } catch (error) {
    log.warn('recovery email threw — responding 202 regardless', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/* ──────────────────────────── set / change ─────────────────────────────── */

/**
 * Set or change the caller's password (authenticated). On success every OTHER
 * device is evicted (`signOut({ scope: 'others' })`) while the current flow
 * survives; for the first-password-set case after invitation acceptance the
 * same call evicts nobody — one code path, correct in both cases (§9 step 3).
 *
 * Timestamps only in the audit row — the value never travels anywhere except
 * to GoTrue over the authenticated update call.
 */
export async function setPassword(input: {
  readonly body: PasswordSetBody;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<void> {
  const log = createLogger({ scope: 'auth-password', requestId: input.requestId });
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.auth.updateUser({ password: input.body.password });

  if (error !== null) {
    throw mapPasswordPolicyError(error);
  }

  try {
    const { error: signOutError } = await supabase.auth.signOut({ scope: 'others' });
    if (signOutError !== null) {
      // The password DID change; eviction failure is logged, not fatal.
      log.warn('post-password eviction of other sessions failed', {
        reason: signOutError.message,
      });
    }
  } catch (error) {
    log.warn('post-password eviction of other sessions threw', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  await recordAuthEvent({
    action: 'UPDATE',
    severity: 'NOTICE',
    entityId: input.auth.userId,
    actorUserId: input.auth.userId,
    requestId: input.requestId,
    request: input.request,
    changedFields: ['password'],
    reason: 'password set or changed',
  });

  log.info('password updated', { userId: input.auth.userId });
}

/**
 * GoTrue owns the password policy (§H). Its violations arrive as error text;
 * they are mapped to a 422 the browser can render next to the field, without
 * restating (and therefore owning) the policy in application code.
 */
function mapPasswordPolicyError(error: { readonly message: string }): ApiError {
  const message = error.message;

  if (/password/i.test(message)) {
    return ApiError.validation(
      [
        {
          path: 'password',
          message: 'The password does not meet the required policy.',
          code: 'password_policy',
        },
      ],
      'The password does not meet the required policy.',
    );
  }

  return ApiError.badRequest('The password could not be updated.', error);
}
