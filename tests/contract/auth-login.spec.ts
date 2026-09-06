import { AuthApiError, AuthRetryableFetchError } from '@supabase/auth-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetClientEnvCacheForTests } from '@/lib/env/client-env';
import { ApiError } from '@/server/api/errors';
import { recordAuthEvent } from '@/server/auth/audit';
import { performLogin, performLogout } from '@/server/auth/routes-login';
import { authContextRpcPayload, gotrueUserFixture, UUIDS } from '../helpers/auth-fixtures';
import { fakeQueryChain, fakeServiceClient, fakeUserClient } from '../helpers/fake-supabase';

/**
 * The login contract (§3): enumeration resistance, the banned-status fork, the
 * status gate re-checking the just-issued session, and the derived redirect.
 * Logout (§14): global revocation + idempotency.
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

const baseInput = {
  body: { email: 'staff@growlith.test', password: 'correct-horse' },
  request: new Request('https://app.test/api/v1/auth/login', { method: 'POST' }),
  requestId: 'req-login',
};

function script(config: Parameters<typeof fakeUserClient>[0] = {}) {
  const fake = fakeUserClient(config);
  createServerClientMock.mockReset();
  createServerClientMock.mockImplementation(async () => fake.client);
  return fake;
}

/** First `getUser()`-style client for sign-in errors: fake a thrown error. */
/** Script a sign-in that RESOLVES with an error, as the real client does. */
function scriptSignInError(error: unknown) {
  const fake = fakeUserClient();
  fake.spies.signInWithPassword.mockResolvedValue({
    data: { user: null, session: null },
    error,
  });
  createServerClientMock.mockReset();
  createServerClientMock.mockImplementation(async () => fake.client);
  return fake;
}

function scriptProfiles(profile: { account_status: string } | null) {
  const service = fakeServiceClient();
  service.spies.from.mockImplementation((table: string) => {
    if (table === 'profiles') {
      const { chain } = fakeQueryChain({ data: profile });
      return chain;
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

describe('performLogin — the happy path', () => {
  it('resolves the context, derives INTERNAL landing, and audits LOGIN', async () => {
    script();

    const result = await performLogin(baseInput);

    expect(result.user.userId).toBe(UUIDS.user);
    expect(result.mfaRequired).toBe(false);
    expect(result.redirectTo).toBe('/admin');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'LOGIN',
        entityId: UUIDS.user,
        after: { aal: 'aal1', mfaRequired: false },
      }),
    );
  });

  it('derives /portal for a CLIENT with an active membership', async () => {
    script({
      user: gotrueUserFixture({ app_metadata: { user_type: 'CLIENT' } }),
      authContext: authContextRpcPayload({
        userType: 'CLIENT',
        platformRole: null,
        memberships: [
          {
            organizationId: UUIDS.organization,
            role: 'CLIENT_ADMIN',
            status: 'ACTIVE',
            isPrimaryContact: true,
          },
        ],
      }),
    });

    const result = await performLogin(baseInput);
    expect(result.redirectTo).toBe('/portal');
  });

  it('flags mfaRequired when a verified factor exists — the step-up follows', async () => {
    script({
      user: gotrueUserFixture({ factors: [{ id: UUIDS.factor, status: 'verified' }] }),
    });

    const result = await performLogin(baseInput);
    expect(result.mfaRequired).toBe(true);
  });
});

describe('performLogin — credential failures', () => {
  it('maps an unconfirmed address to uniform 401 (M-1 enumeration resistance)', async () => {
    scriptSignInError(new AuthApiError('Email not confirmed', 400, undefined));

    const error = await rejectionOf(performLogin(baseInput));
    expect(error.status).toBe(401);
    expect(error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns uniform 401 INVALID_CREDENTIALS for a wrong password and audits the failure (C-1)', async () => {
    const service = scriptProfiles({ account_status: 'ACTIVE' });
    scriptSignInError(new AuthApiError('Invalid login credentials', 400, undefined));

    const error = await rejectionOf(performLogin(baseInput));

    expect(error.status).toBe(401);
    expect(error.code).toBe('INVALID_CREDENTIALS');
    expect(error.message).toBe('The email address or password is incorrect.');
    // C-1 hardening: failed credentials are audited when a profile is resolvable.
    expect(service.spies.from).toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGIN_FAILED', after: { reason: 'invalid_credentials' } }),
    );
  });

  it('maps rate limiting to 429', async () => {
    scriptSignInError(new AuthApiError('Too many requests', 429, undefined));

    const error = await rejectionOf(performLogin(baseInput));
    expect(error.status).toBe(429);
  });

  it('maps an unreachable auth server to 503, not 401', async () => {
    scriptSignInError(new AuthRetryableFetchError('Network request failed', 503));

    const error = await rejectionOf(performLogin(baseInput));
    expect(error.status).toBe(503);
    expect(error.code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('performLogin — the banned fork (M-1 uniform 401, holder check via status gate)', () => {
  it('a banned identity with a SUSPENDED profile gets uniform 401 (pre-auth enumeration resistance)', async () => {
    scriptProfiles({ account_status: 'SUSPENDED' });
    scriptSignInError(new AuthApiError('User is banned', 400, undefined));

    const error = await rejectionOf(performLogin(baseInput));
    expect(error.status).toBe(401);
    expect(error.code).toBe('INVALID_CREDENTIALS');
  });

  it('a banned identity with a DEACTIVATED profile gets uniform 401', async () => {
    scriptProfiles({ account_status: 'DEACTIVATED' });
    scriptSignInError(new AuthApiError('User is banned', 400, undefined));

    const error = await rejectionOf(performLogin(baseInput));
    expect(error.status).toBe(401);
    expect(error.code).toBe('INVALID_CREDENTIALS');
  });

  it('a banned identity with no profile row degrades to the uniform 401', async () => {
    scriptProfiles(null);
    scriptSignInError(new AuthApiError('User is banned', 400, undefined));

    const error = await rejectionOf(performLogin(baseInput));
    expect(error.status).toBe(401);
    expect(error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('performLogin — the status gate re-checks the fresh session', () => {
  it('rejects a sign-in whose just-issued session is INVITED, with a LOGIN_FAILED audit row', async () => {
    script({ authContext: authContextRpcPayload({ accountStatus: 'INVITED' }) });

    const error = await rejectionOf(performLogin(baseInput));

    expect(error.status).toBe(403);
    expect(error.code).toBe('INVITATION_PENDING');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'LOGIN_FAILED',
        severity: 'WARNING',
        entityId: UUIDS.user,
        after: { reason: 'account_state', status: 403 },
        reason: 'blocked by account status gate',
      }),
    );
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'LOGIN' }));
  });
});

describe('performLogout — global, idempotent, cookie-destroying', () => {
  const logoutInput = {
    request: new Request('https://app.test/api/v1/auth/logout', { method: 'POST' }),
    requestId: 'req-logout',
  };

  it('revokes every refresh token globally and audits LOGOUT', async () => {
    const fake = script();

    await performLogout(logoutInput);

    expect(fake.spies.signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGOUT', entityId: UUIDS.user }),
    );
  });

  it('still completes (204 semantics) when there is no session at all', async () => {
    const fake = script({ user: null, getUserError: { message: 'Auth session missing!' } });

    await expect(performLogout(logoutInput)).resolves.toBeUndefined();
    expect(fake.spies.signOut).toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('still completes when signOut reports an error — idempotency beats error-loop fidelity', async () => {
    const fake = script();
    fake.spies.signOut.mockResolvedValue({ error: { message: 'already revoked' } });

    await expect(performLogout(logoutInput)).resolves.toBeUndefined();
  });
});
