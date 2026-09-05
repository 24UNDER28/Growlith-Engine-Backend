import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetClientEnvCacheForTests } from '@/lib/env/client-env';
import { ApiError } from '@/server/api/errors';
import { recordAuthEvent } from '@/server/auth/audit';
import {
  challengeAndVerifyTotp,
  enrollTotpFactor,
  listTotpFactors,
  unenrollTotpFactor,
} from '@/server/auth/routes-mfa';
import { requestPasswordRecovery, setPassword } from '@/server/auth/routes-password';
import { authContextFixture, UUIDS } from '../helpers/auth-fixtures';
import { fakeQueryChain, fakeServiceClient, fakeUserClient } from '../helpers/fake-supabase';

/**
 * Password flows (§9): recovery enumeration discipline, set/change eviction.
 * MFA (§6c): enrollment shape, challenge+verify promotion, the aal2 unenroll
 * gate. Session reporting: see auth-context.spec (resolveAuthContext).
 */

const createServerClientMock = vi.hoisted(() => vi.fn());
const serviceClientMock = vi.hoisted(() => vi.fn());

vi.mock('@/server/supabase/client-server', () => ({
  createSupabaseServerClient: (...args: unknown[]) => createServerClientMock(...args),
}));
vi.mock('@/server/supabase/client-service', () => ({
  getSupabaseServiceClient: () => serviceClientMock(),
}));
vi.mock('@/server/auth/audit', () => ({
  recordAuthEvent: vi.fn(async () => true),
}));

const audit = vi.mocked(recordAuthEvent);

function script(config: Parameters<typeof fakeUserClient>[0] = {}) {
  const fake = fakeUserClient(config);
  createServerClientMock.mockReset();
  createServerClientMock.mockImplementation(async () => fake.client);
  return fake;
}

function scriptProfiles(profile: { id: string; account_status: string } | null) {
  const service = fakeServiceClient();
  service.spies.from.mockImplementation((table: string) => {
    if (table === 'profiles') {
      return fakeQueryChain({ data: profile }).chain;
    }
    return fakeQueryChain().chain;
  });
  serviceClientMock.mockReturnValue(service.client);
  return service;
}

async function rejectionOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('expected the call to reject');
}

beforeEach(() => {
  process.env.LOG_LEVEL = 'silent';
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.test.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-test-key');
  __resetClientEnvCacheForTests();
  serviceClientMock.mockReturnValue(fakeServiceClient().client);
  audit.mockClear();
});

/* ───────────────────────────── password recovery ───────────────────────── */

describe('requestPasswordRecovery — 202 for everyone, mail for ACTIVE only (§9)', () => {
  const recoveryInput = {
    body: { email: 'client@example.test' },
    request: new Request('https://app.test/api/v1/auth/password-recovery', { method: 'POST' }),
    requestId: 'req-recovery',
  };

  it('sends recovery mail only to a live ACTIVE profile, with the confirm callback as redirect', async () => {
    const fake = script();
    scriptProfiles({ id: UUIDS.user, account_status: 'ACTIVE' });

    await requestPasswordRecovery(recoveryInput);

    expect(fake.spies.resetPasswordForEmail).toHaveBeenCalledWith('client@example.test', {
      redirectTo: 'https://app.test/auth/confirm?type=recovery&next=/auth/reset-password',
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PASSWORD_RESET_REQUESTED', entityId: UUIDS.user }),
    );
  });

  it('sends nothing for a SUSPENDED profile — and still resolves', async () => {
    const fake = script();
    scriptProfiles({ id: UUIDS.user, account_status: 'SUSPENDED' });

    await expect(requestPasswordRecovery(recoveryInput)).resolves.toBeUndefined();
    expect(fake.spies.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('sends nothing for an unknown address — the response is indistinguishable', async () => {
    const fake = script();
    scriptProfiles(null);

    await expect(requestPasswordRecovery(recoveryInput)).resolves.toBeUndefined();
    expect(fake.spies.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('still resolves when the eligibility lookup or the send fails (availability, not disclosure)', async () => {
    const service = scriptProfiles({ id: UUIDS.user, account_status: 'ACTIVE' });
    service.spies.from.mockImplementation(
      () => fakeQueryChain({ error: { message: 'db down' } }).chain,
    );

    await expect(requestPasswordRecovery(recoveryInput)).resolves.toBeUndefined();

    const fake = script();
    fake.spies.resetPasswordForEmail.mockResolvedValue({
      data: null,
      error: { message: 'smtp down' },
    });
    await expect(requestPasswordRecovery(recoveryInput)).resolves.toBeUndefined();
  });
});

/* ───────────────────────────── password set/change ─────────────────────── */

describe('setPassword — set/change with other-session eviction (§9)', () => {
  const setPasswordInput = (password: string) => ({
    body: { password },
    auth: authContextFixture(),
    request: new Request('https://app.test/api/v1/auth/password', { method: 'PUT' }),
    requestId: 'req-password',
  });

  it('updates through GoTrue and evicts every OTHER device', async () => {
    const fake = script();

    await setPassword(setPasswordInput('new-correct-horse-42'));

    expect(fake.spies.updateUser).toHaveBeenCalledWith({ password: 'new-correct-horse-42' });
    expect(fake.spies.signOut).toHaveBeenCalledWith({ scope: 'others' });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        changedFields: ['password'],
        entityId: UUIDS.user,
      }),
    );
  });

  it('maps GoTrue policy violations to a 422 field error, policy text not restated', async () => {
    const fake = script();
    fake.spies.updateUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Password should be at least 8 characters.' },
    });

    const error = await rejectionOf(setPassword(setPasswordInput('short')));
    expect(error.status).toBe(422);
    expect(error.code).toBe('VALIDATION_FAILED');
  });
});

/* ─────────────────────────────────── MFA ───────────────────────────────── */

describe('enrollTotpFactor — the enrollment shape (§6c)', () => {
  it('returns factorId, uri, secret and the QR payload (qr_code field upstream)', async () => {
    script();

    const enrollment = await enrollTotpFactor({
      auth: authContextFixture(),
      request: new Request('https://app.test/'),
      requestId: 'req-mfa',
    });

    expect(enrollment).toEqual({
      factorId: 'factor-new',
      totpUri: 'otpauth://totp/x',
      secret: 'BASE32SECRET',
      qr: 'data:image/png;base64,qr',
    });
  });
});

describe('challengeAndVerifyTotp — promotion to aal2 (§6c)', () => {
  const verifyInput = {
    body: { factorId: UUIDS.factor, code: '123456' },
    auth: authContextFixture(),
    request: new Request('https://app.test/'),
    requestId: 'req-mfa',
  };

  it('challenges, verifies, then reads the NEW assurance level — never the response body', async () => {
    const fake = script({ aal: 'aal2' });

    const result = await challengeAndVerifyTotp(verifyInput);

    expect(fake.spies.mfaChallenge).toHaveBeenCalledWith({ factorId: UUIDS.factor });
    expect(fake.spies.mfaVerify).toHaveBeenCalledWith({
      factorId: UUIDS.factor,
      challengeId: 'challenge-1',
      code: '123456',
    });
    expect(fake.spies.getAal).toHaveBeenCalled();
    expect(result.aal).toBe('aal2');
    expect(result.redirectTo).toBe('/admin'); // INTERNAL fixture
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'MFA_ENROLLED',
        after: { factorId: UUIDS.factor, aal: 'aal2' },
      }),
    );
  });

  it('stamps aal1 when the session did not promote — the honest answer', async () => {
    script({ aal: 'aal1' });

    const result = await challengeAndVerifyTotp(verifyInput);
    expect(result.aal).toBe('aal1');
  });

  it('maps a wrong code to uniform invalid credentials — retryable, no detail', async () => {
    const fake = script();
    fake.spies.mfaVerify.mockResolvedValue({
      data: null,
      error: { message: 'Invalid TOTP code', status: 401 },
    });

    const error = await rejectionOf(challengeAndVerifyTotp(verifyInput));
    expect(error.status).toBe(401);
    expect(error.code).toBe('INVALID_CREDENTIALS');
  });

  it('maps an auth-server outage to 503', async () => {
    const fake = script();
    fake.spies.mfaChallenge.mockResolvedValue({
      data: null,
      error: { message: 'upstream down', status: 503 },
    });

    const error = await rejectionOf(challengeAndVerifyTotp(verifyInput));
    expect(error.status).toBe(503);
  });
});

describe('listTotpFactors — the management list', () => {
  it('maps friendly_name and created_at from the auth server factors', async () => {
    const fake = script();
    fake.spies.mfaListFactors.mockResolvedValue({
      data: {
        all: [],
        totp: [
          {
            id: 'factor-1',
            status: 'verified',
            friendly_name: 'Authenticator',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      },
      error: null,
    });

    const factors = await listTotpFactors();
    expect(factors).toEqual([
      {
        factorId: 'factor-1',
        status: 'verified',
        friendlyName: 'Authenticator',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);
  });
});

describe('unenrollTotpFactor — the aal2 gate (§6c, §13 control 8)', () => {
  const unenrollInput = {
    body: { factorId: UUIDS.factor },
    auth: authContextFixture({ aal: 'aal2' }),
    request: new Request('https://app.test/'),
    requestId: 'req-mfa',
  };

  it('requires a fresh aal2 session — an aal1 session is refused before any call', async () => {
    const fake = script();
    const input = { ...unenrollInput, auth: authContextFixture({ aal: 'aal1' }) };

    const error = await rejectionOf(unenrollTotpFactor(input));

    expect(error.status).toBe(401);
    expect(error.code).toBe('MFA_REQUIRED');
    expect(fake.spies.mfaUnenroll).not.toHaveBeenCalled();
  });

  it('unenrolls and audits the removal', async () => {
    const fake = script();

    await unenrollTotpFactor(unenrollInput);

    expect(fake.spies.mfaUnenroll).toHaveBeenCalledWith({ factorId: UUIDS.factor });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MFA_REMOVED', severity: 'WARNING' }),
    );
  });
});
