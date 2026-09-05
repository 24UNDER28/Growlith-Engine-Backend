import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetClientEnvCacheForTests } from '@/lib/env/client-env';
import {
  exchangeInviteLink,
  exchangeRecoveryLink,
  isEmailLinkType,
} from '@/server/auth/email-links';

/**
 * Email-link token exchange contracts (§2.2, §9).
 *
 * The `/auth/confirm` callback consumes email links server-side: no token
 * reaches browser JS or a URL fragment (§13 control 2). Two credentials ride
 * an invite link (Supabase's `token_hash` + the app token `it`), and one for
 * recovery (`token_hash` only). Every failure is neutral: the link holder
 * learns nothing about which invitation exists beyond their own (§12).
 */

const createServerClientMock = vi.hoisted(() => vi.fn());

vi.mock('@/server/supabase/client-server', () => ({
  createSupabaseServerClient: (...args: unknown[]) => createServerClientMock(...args),
}));
vi.mock('@/server/supabase/client-service', () => ({
  getSupabaseServiceClient: () => ({ from: vi.fn() }),
}));
vi.mock('@/server/auth/audit', () => ({
  recordAuthEvent: vi.fn(async () => true),
}));

beforeEach(() => {
  process.env.LOG_LEVEL = 'silent';
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.test.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-test-key');
  __resetClientEnvCacheForTests();
});

function scriptClient(config: {
  verifyOtpError?: unknown;
  rpcData?: unknown;
  rpcError?: unknown;
} = {}) {
  const verifyOtp = vi.fn(async () => ({
    data: config.verifyOtpError ? null : { user: { id: 'u1' } },
    error: config.verifyOtpError ?? null,
  }));

  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'accept_invitation') {
      return {
        data: config.rpcData ?? { branch: 'client' },
        error: config.rpcError ?? null,
      };
    }
    return { data: null, error: null };
  });

  createServerClientMock.mockImplementation(async () => ({
    auth: {
      verifyOtp,
    },
    rpc,
  }));

  return { verifyOtp, rpc };
}

/* ─────────────────────────── type guard ─────────────────────────────── */

describe('isEmailLinkType — the link-type vocabulary', () => {
  it('accepts invite and recovery', () => {
    expect(isEmailLinkType('invite')).toBe(true);
    expect(isEmailLinkType('recovery')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isEmailLinkType('signup')).toBe(false);
    expect(isEmailLinkType('')).toBe(false);
    expect(isEmailLinkType('magiclink')).toBe(false);
  });
});

/* ─────────────────────────── invite exchange ────────────────────────── */

describe('exchangeInviteLink — neutral outcomes (§2.2, §12)', () => {
  const baseInput = {
    tokenHash: 'abc123hash',
    rawAppToken: 'raw-app-token-xyz',
    next: '/auth/set-password',
  };

  it('verifies the mailbox token, runs the acceptance RPC, and returns accepted', async () => {
    const fake = scriptClient({ rpcData: { branch: 'client' } });

    const outcome = await exchangeInviteLink(baseInput);

    expect(outcome).toMatchObject({
      result: 'accepted',
      branch: 'client',
      next: '/auth/set-password',
    });
    expect(fake.verifyOtp).toHaveBeenCalledWith({
      token_hash: 'abc123hash',
      type: 'invite',
    });
    expect(fake.rpc).toHaveBeenCalledWith('accept_invitation', {
      p_raw_token: 'raw-app-token-xyz',
    });
  });

  it('classifies the staff branch from the RPC response', async () => {
    scriptClient({ rpcData: { branch: 'staff' } });

    const outcome = await exchangeInviteLink(baseInput);

    expect(outcome).toMatchObject({
      result: 'accepted',
      branch: 'staff',
    });
  });

  it('returns neutral "invalid" when verifyOtp fails (expired/revoked/unknown token)', async () => {
    scriptClient({ verifyOtpError: { message: 'Token has expired or is invalid' } });

    const outcome = await exchangeInviteLink(baseInput);

    expect(outcome).toMatchObject({
      result: 'invalid',
      reason: 'other',
    });
  });

  it('classifies an expired invitation neutrally', async () => {
    scriptClient({
      rpcError: { message: 'INVITATION_EXPIRED: this invitation has expired' },
    });

    const outcome = await exchangeInviteLink(baseInput);

    expect(outcome).toMatchObject({
      result: 'invalid',
      reason: 'expired',
    });
  });

  it('classifies a revoked invitation neutrally', async () => {
    scriptClient({
      rpcError: { message: 'INVITATION_REVOKED: this invitation was revoked' },
    });

    const outcome = await exchangeInviteLink(baseInput);

    expect(outcome).toMatchObject({
      result: 'invalid',
      reason: 'revoked',
    });
  });

  it('classifies already-accepted as idempotent success', async () => {
    scriptClient({
      rpcError: {
        message: 'INVITATION_ALREADY_ACCEPTED: this invitation was already accepted',
      },
    });

    const outcome = await exchangeInviteLink(baseInput);

    expect(outcome.result).toBe('already-accepted');
  });

  it('classifies unknown RPC errors as neutral "other"', async () => {
    scriptClient({
      rpcError: { message: 'INVITATION_EMAIL_MISMATCH: email does not match' },
    });

    const outcome = await exchangeInviteLink(baseInput);

    expect(outcome).toMatchObject({
      result: 'invalid',
      reason: 'other',
    });
  });

  it('defaults to client branch for unexpected RPC shapes', async () => {
    scriptClient({ rpcData: null });

    const outcome = await exchangeInviteLink(baseInput);

    expect(outcome).toMatchObject({
      result: 'accepted',
      branch: 'client',
    });
  });
});

/* ─────────────────────────── recovery exchange ─────────────────────── */

describe('exchangeRecoveryLink — mailbox-control credential (§9)', () => {
  const baseInput = {
    tokenHash: 'recovery-hash',
    next: '/auth/reset-password',
  };

  it('verifies the mailbox token and returns the next destination', async () => {
    const fake = scriptClient();

    const outcome = await exchangeRecoveryLink(baseInput);

    expect(outcome).toMatchObject({
      result: 'verified',
      next: '/auth/reset-password',
    });
    expect(fake.verifyOtp).toHaveBeenCalledWith({
      token_hash: 'recovery-hash',
      type: 'recovery',
    });
  });

  it('returns neutral "invalid" when verifyOtp fails', async () => {
    scriptClient({ verifyOtpError: { message: 'Token not valid' } });

    const outcome = await exchangeRecoveryLink(baseInput);

    expect(outcome.result).toBe('invalid');
  });
});
