import 'server-only';

import { createLogger, type Logger } from '@/server/logging/logger';
import { createSupabaseServerClient } from '@/server/supabase/client-server';

/**
 * Email-link token exchange — the `/auth/confirm` callback's engine
 * (design §2.2, §9 step 2).
 *
 * Email links carry `token_hash` and are consumed by SERVER code only: no
 * token ever lands in a URL fragment or in browser JS (§13 control 2). Two
 * credentials ride an invite link — Supabase's `token_hash` (proves control
 * of the mailbox) and the app token `it` (selects the invitation). Order
 * matters: `verifyOtp` first (session established, cookies written on the
 * redirect response), THEN the `accept_invitation` RPC through the same
 * user client, whose `auth.uid()` identifies the accepter.
 *
 * Every failure maps to a NEUTRAL redirect state — the link holder learns
 * nothing about which invitation exists beyond their own (§12).
 */

export type EmailLinkType = 'invite' | 'recovery';

/** Neutral outcomes the callback turns into redirects; never error envelopes. */
export type InviteExchangeOutcome =
  | { readonly result: 'accepted'; readonly branch: 'client' | 'staff'; readonly next: string }
  | { readonly result: 'already-accepted' }
  | { readonly result: 'invalid'; readonly reason: 'expired' | 'revoked' | 'other' };

export type RecoveryExchangeOutcome =
  { readonly result: 'verified'; readonly next: string } | { readonly result: 'invalid' };

/** Machine prefixes raised by `accept_invitation()` — a wire contract. */
const RPC_ERROR_PREFIXES = [
  'INVITATION_EXPIRED',
  'INVITATION_REVOKED',
  'INVITATION_ALREADY_ACCEPTED',
  'INVITATION_UNKNOWN',
  'INVITATION_EMAIL_MISMATCH',
  'INVITATION_NO_SESSION',
  'INVITATION_NO_PROFILE',
  'INVITATION_ACCOUNT_STATE',
  'MEMBERSHIP_CONFLICT',
  'MEMBERSHIP_MISSING',
] as const;

export function isEmailLinkType(value: string): value is EmailLinkType {
  return value === 'invite' || value === 'recovery';
}

/**
 * Exchange an invite link: verify the mailbox token, establish the session,
 * run the atomic acceptance RPC, and classify every failure neutrally.
 */
export async function exchangeInviteLink(input: {
  readonly tokenHash: string;
  readonly rawAppToken: string;
  readonly next: string;
}): Promise<InviteExchangeOutcome> {
  const log = createLogger({ scope: 'auth-confirm-invite' });
  const supabase = await createSupabaseServerClient();

  // 1. Mailbox control. Failure here is neutral: the GoTrue token is
  //    single-use, so a consumed link and a forged link look identical by
  //    design — no which-case disclosure.
  const { error: otpError } = await supabase.auth.verifyOtp({
    token_hash: input.tokenHash,
    type: 'invite',
  });

  if (otpError !== null) {
    log.debug('invite link rejected at verifyOtp', { reason: otpError.message });
    return { result: 'invalid', reason: 'other' };
  }

  // 2. Atomic acceptance. The RPC's message prefixes are the contract.
  const { data, error: rpcError } = await supabase.rpc('accept_invitation', {
    p_raw_token: input.rawAppToken,
  });

  if (rpcError !== null) {
    return classifyRpcError(rpcError, log);
  }

  const branch = branchOf(data);
  log.info('invitation accepted', { branch });

  return { result: 'accepted', branch, next: input.next };
}

/**
 * Exchange a recovery link: `verifyOtp` signs the user in (mailbox control is
 * the credential — GoTrue's native behaviour, kept per §9 step 2), and the
 * session cookies ride the redirect to the reset screen.
 */
export async function exchangeRecoveryLink(input: {
  readonly tokenHash: string;
  readonly next: string;
}): Promise<RecoveryExchangeOutcome> {
  const log = createLogger({ scope: 'auth-confirm-recovery' });
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.auth.verifyOtp({
    token_hash: input.tokenHash,
    type: 'recovery',
  });

  if (error !== null) {
    log.debug('recovery link rejected', { reason: error.message });
    return { result: 'invalid' };
  }

  return { result: 'verified', next: input.next };
}

function classifyRpcError(error: { readonly message: string }, log: Logger): InviteExchangeOutcome {
  const prefix = RPC_ERROR_PREFIXES.find((candidate) =>
    error.message.toUpperCase().startsWith(candidate),
  );
  log.debug('accept_invitation rejected the link', { prefix: prefix ?? 'UNCLASSIFIED' });

  switch (prefix) {
    case 'INVITATION_EXPIRED':
      return { result: 'invalid', reason: 'expired' };
    case 'INVITATION_REVOKED':
      return { result: 'invalid', reason: 'revoked' };
    case 'INVITATION_ALREADY_ACCEPTED':
      // Idempotent, not an error: the account is active and the person should
      // simply sign in (§12).
      return { result: 'already-accepted' };
    default:
      // Neutral for everything else: unknown, mismatched, conflicting and
      // integrity states share one page so the link state cannot be probed.
      return { result: 'invalid', reason: 'other' };
  }
}

function branchOf(data: unknown): 'client' | 'staff' {
  if (data !== null && typeof data === 'object' && 'branch' in data) {
    const branch = (data as { branch?: unknown }).branch;
    if (branch === 'client' || branch === 'staff') {
      return branch;
    }
  }
  return 'client';
}
