import { AuthRetryableFetchError } from '@supabase/auth-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/server/api/errors';
import { requireAuthContext, resolveAuthContext } from '@/server/auth/context';
import { authContextRpcPayload, gotrueUserFixture, UUIDS } from '../helpers/auth-fixtures';
import { fakeServiceClient, fakeUserClient } from '../helpers/fake-supabase';

/**
 * requireAuthContext is the single authority on "who is this request" (§5).
 * These contracts pin its observable behaviour: the §8 status matrix with
 * evictions, minAal enforcement, and the unavailability-vs-anonymity split.
 * The Supabase factories are module-mocked; the fakes are scriptable.
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

beforeEach(() => {
  process.env.LOG_LEVEL = 'silent';
  serviceClientMock.mockReturnValue(fakeServiceClient().client);
});

function scriptUserClient(config: Parameters<typeof fakeUserClient>[0]) {
  const fake = fakeUserClient(config);
  createServerClientMock.mockReset();
  createServerClientMock.mockImplementation(async () => fake.client);
  return fake;
}

async function rejectionOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('expected the call to reject');
}

describe('requireAuthContext — the happy path', () => {
  it('resolves identity + state from the database in one round trip', async () => {
    scriptUserClient({});

    const context = await requireAuthContext();

    expect(context.userId).toBe(UUIDS.user);
    expect(context.email).toBe('staff@growlith.test');
    expect(context.userType).toBe('INTERNAL');
    expect(context.accountStatus).toBe('ACTIVE');
    expect(context.platformRole).toBe('ADMIN');
    expect(context.aal).toBe('aal1');
    expect(context.mfaEnrolled).toBe(false);
  });

  it('derives mfaEnrolled from VERIFIED factors only', async () => {
    scriptUserClient({
      user: gotrueUserFixture({
        factors: [{ id: UUIDS.factor, status: 'verified' }],
      }),
    });

    const context = await requireAuthContext();
    expect(context.mfaEnrolled).toBe(true);
  });

  it('maps memberships and aal2 from the session claim', async () => {
    scriptUserClient({
      aal: 'aal2',
      authContext: authContextRpcPayload({
        memberships: [
          {
            organizationId: UUIDS.organization,
            role: 'CLIENT_ADMIN',
            status: 'ACTIVE',
            isPrimaryContact: false,
          },
        ],
      }),
    });

    const context = await requireAuthContext();
    expect(context.aal).toBe('aal2');
    expect(context.memberships).toEqual([
      {
        organizationId: UUIDS.organization,
        role: 'CLIENT_ADMIN',
        status: 'ACTIVE',
        isPrimaryContact: false,
      },
    ]);
  });
});

describe('requireAuthContext — no session / unavailability', () => {
  it('throws 401 UNAUTHENTICATED when getUser finds nothing', async () => {
    scriptUserClient({ user: null, getUserError: { message: 'Auth session missing!' } });

    const error = await rejectionOf(requireAuthContext());
    expect(error.status).toBe(401);
    expect(error.code).toBe('UNAUTHENTICATED');
  });

  it('throws 503 when the auth server is unreachable — never a silent 401', async () => {
    scriptUserClient({
      user: null,
      getUserError: new AuthRetryableFetchError('Network request failed', 503),
    });

    const error = await rejectionOf(requireAuthContext());
    expect(error.status).toBe(503);
  });

  it('throws 503 when the auth_context RPC fails', async () => {
    scriptUserClient({ authContextError: { message: 'function not granted' } });

    const error = await rejectionOf(requireAuthContext());
    expect(error.status).toBe(503);
  });

  it('throws 401 when the RPC returns no profile row for a verified identity', async () => {
    scriptUserClient({ authContext: null });

    const error = await rejectionOf(requireAuthContext());
    expect(error.status).toBe(401);
  });

  it('throws 500 when auth_context returns an unexpected shape', async () => {
    scriptUserClient({ authContext: { nonsense: true } });

    const error = await rejectionOf(requireAuthContext());
    expect(error.status).toBe(500);
  });
});

describe('requireAuthContext — the §8 status gate', () => {
  const evictionCases = [
    {
      status: 'SUSPENDED' as const,
      expectedStatus: 423,
      expectedCode: 'ACCOUNT_SUSPENDED',
    },
    {
      status: 'DEACTIVATED' as const,
      expectedStatus: 401,
      expectedCode: 'ACCOUNT_DEACTIVATED',
    },
    {
      status: 'INVITED' as const,
      expectedStatus: 403,
      expectedCode: 'INVITATION_PENDING',
    },
  ];

  for (const { status, expectedStatus, expectedCode } of evictionCases) {
    it(`${status} → ${expectedStatus} ${expectedCode} with own-session global sign-out and a belt-and-braces ban`, async () => {
      const service = fakeServiceClient();
      serviceClientMock.mockReturnValue(service.client);
      const fake = scriptUserClient({
        authContext: authContextRpcPayload({ accountStatus: status }),
      });

      const error = await rejectionOf(requireAuthContext());

      expect(error.status).toBe(expectedStatus);
      expect(error.code).toBe(expectedCode);
      // Eviction 1: the caller's OWN session, revoked globally (every device).
      expect(fake.spies.signOut).toHaveBeenCalledWith({ scope: 'global' });
      // Eviction 2: the by-identity kill switch GoTrue offers — the ban.
      expect(service.spies.updateUserById).toHaveBeenCalledWith(UUIDS.user, {
        ban_duration: '87600h',
      });
    });
  }

  it('survives an eviction failure — the rejection still wins', async () => {
    const service = fakeServiceClient({ adminUpdateUserById: { error: { message: 'boom' } } });
    serviceClientMock.mockReturnValue(service.client);
    scriptUserClient({
      authContext: authContextRpcPayload({ accountStatus: 'SUSPENDED' }),
    });

    const error = await rejectionOf(requireAuthContext());
    expect(error.status).toBe(423);
  });

  it('skips the gate when the caller reports state (skipStatusGate via resolveAuthContext)', async () => {
    scriptUserClient({
      authContext: authContextRpcPayload({ accountStatus: 'SUSPENDED' }),
    });

    const context = await resolveAuthContext();
    expect(context?.accountStatus).toBe('SUSPENDED');
  });
});

describe('resolveAuthContext — the reporting surface', () => {
  it('resolves null (data, not an error) when unauthenticated', async () => {
    scriptUserClient({ user: null, getUserError: { message: 'Auth session missing!' } });

    await expect(resolveAuthContext()).resolves.toBeNull();
  });

  it('still throws 503 on outage — a reporting endpoint must not say "logged out"', async () => {
    scriptUserClient({
      user: null,
      getUserError: new AuthRetryableFetchError('Network request failed', 503),
    });

    const error = await rejectionOf(resolveAuthContext());
    expect(error.status).toBe(503);
  });
});

describe('requireAuthContext — MFA assurance (minAal)', () => {
  it('rejects an aal1 session under minAal 2 with 401 MFA_REQUIRED', async () => {
    scriptUserClient({ aal: 'aal1' });

    const error = await rejectionOf(requireAuthContext({ minAal: 2 }));
    expect(error.status).toBe(401);
    expect(error.code).toBe('MFA_REQUIRED');
  });

  it('accepts an aal2 session under minAal 2', async () => {
    scriptUserClient({ aal: 'aal2' });

    const context = await requireAuthContext({ minAal: 2 });
    expect(context.aal).toBe('aal2');
  });

  it('accepts any session under the default minAal 1', async () => {
    scriptUserClient({ aal: 'aal1' });
    await expect(requireAuthContext()).resolves.toMatchObject({ aal: 'aal1' });
  });
});
