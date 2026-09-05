import { vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { authContextRpcPayload, gotrueUserFixture } from './auth-fixtures';

/**
 * Fake Supabase clients for the Phase 3 contract tests.
 *
 * These are SCRIPTABLE, not smart: each spec configures exactly the behaviour
 * it asserts against, and every method is a `vi.fn` so call arguments are
 * assertable. The real modules (`client-server.ts`, `client-service.ts`) are
 * mocked at the spec level; these builders produce the values those mocks
 * return.
 */

export type FakeClient = SupabaseClient<Database>;

/** A PostgREST chainable that answers any terminal with a fixed result. */
export function fakeQueryChain(result: { data?: unknown; error?: unknown } = {}) {
  const chain: Record<string, unknown> = {};
  const passthrough = vi.fn(() => chain);
  const terminal = vi.fn(() => ({
    data: result.data ?? null,
    error: result.error ?? null,
  }));

  for (const method of ['select', 'eq', 'neq', 'is', 'order', 'limit', 'insert', 'update']) {
    chain[method] = passthrough;
  }
  // `.single()` and `.maybeSingle()` end the chain; `.insert(...).select().single()`
  // and `.update(...).select()` reuse the same terminals.
  chain.single = terminal;
  chain.maybeSingle = terminal;

  // Chains that are AWAITED WITHOUT a terminal (`await from(t).insert(row)`,
  // `await from(t).update(x).select()`) resolve like postgrest-js does.
  chain.then = ((onFulfilled?: (value: unknown) => unknown) =>
    Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then((value) =>
      onFulfilled === undefined ? value : onFulfilled(value),
    )) as unknown;

  return { chain, terminal, passthrough };
}

export interface FakeUserClientConfig {
  /** Result of `getUser()`. Default: a live INTERNAL user. */
  readonly user?: Record<string, unknown> | null;
  /**
   * Error value for `getUser()` — wins over `user` when set. Accepts real
   * auth-js error instances so `instanceof` branches in production code take
   * the same path they take live.
   */
  readonly getUserError?: unknown;
  /** Result of `rpc('auth_context')`. */
  readonly authContext?: Record<string, unknown> | null;
  /** Error for `rpc('auth_context')`. */
  readonly authContextError?: unknown;
  readonly aal?: 'aal1' | 'aal2';
}

export interface FakeUserClient {
  readonly client: FakeClient;
  readonly spies: {
    readonly getUser: ReturnType<typeof vi.fn>;
    readonly signOut: ReturnType<typeof vi.fn>;
    readonly getAal: ReturnType<typeof vi.fn>;
    readonly rpc: ReturnType<typeof vi.fn>;
    readonly signInWithPassword: ReturnType<typeof vi.fn>;
    readonly updateUser: ReturnType<typeof vi.fn>;
    readonly resetPasswordForEmail: ReturnType<typeof vi.fn>;
    readonly verifyOtp: ReturnType<typeof vi.fn>;
    readonly mfaEnroll: ReturnType<typeof vi.fn>;
    readonly mfaChallenge: ReturnType<typeof vi.fn>;
    readonly mfaVerify: ReturnType<typeof vi.fn>;
    readonly mfaListFactors: ReturnType<typeof vi.fn>;
    readonly mfaUnenroll: ReturnType<typeof vi.fn>;
  };
}

export function fakeUserClient(config: FakeUserClientConfig = {}): FakeUserClient {
  const user = config.user === undefined ? gotrueUserFixture() : config.user;
  // `authContext: null` (verified identity, no profile row) must survive the
  // defaulting, hence the undefined check rather than `??`.
  const authContextPayload =
    config.authContext === undefined ? authContextRpcPayload() : config.authContext;
  const aal = config.aal ?? 'aal1';

  const getUser = vi.fn(async () => ({
    data: { user: config.getUserError ? null : user },
    error: config.getUserError ?? null,
  }));

  const signOut = vi.fn(async () => ({ error: null }));

  const getAal = vi.fn(async () => ({
    data: { currentLevel: aal, nextLevel: aal, currentAuthenticationMethods: [] },
    error: null,
  }));

  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'auth_context') {
      return {
        data: config.authContextError ? null : authContextPayload,
        error: config.authContextError ?? null,
      };
    }
    return { data: null, error: null };
  });

  const signInWithPassword = vi.fn(async () => ({
    data: { user, session: { user } },
    error: null,
  }));

  const updateUser = vi.fn(async () => ({ data: { user }, error: null }));
  const resetPasswordForEmail = vi.fn(async () => ({ data: null, error: null }));
  const verifyOtp = vi.fn(async () => ({ data: { user }, error: null }));

  const mfaEnroll = vi.fn(async () => ({
    data: {
      id: 'factor-new',
      type: 'totp',
      totp: {
        qr_code: 'data:image/png;base64,qr',
        secret: 'BASE32SECRET',
        uri: 'otpauth://totp/x',
      },
    },
    error: null,
  }));
  const mfaChallenge = vi.fn(async () => ({ data: { id: 'challenge-1' }, error: null }));
  const mfaVerify = vi.fn(async () => ({
    data: { access_token: 'new-token', token_type: 'bearer', expires_in: 3600, refresh_token: 'r' },
    error: null,
  }));
  const mfaListFactors = vi.fn(async () => ({
    data: {
      all: [],
      totp: [
        {
          id: 'factor-1',
          status: 'verified',
          friendly_name: 'x',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    },
    error: null,
  }));
  const mfaUnenroll = vi.fn(async () => ({ data: { factor_id: 'factor-1' }, error: null }));

  const client = {
    auth: {
      getUser,
      signOut,
      updateUser,
      resetPasswordForEmail,
      verifyOtp,
      signInWithPassword,
      mfa: {
        enroll: mfaEnroll,
        challenge: mfaChallenge,
        verify: mfaVerify,
        listFactors: mfaListFactors,
        unenroll: mfaUnenroll,
        getAuthenticatorAssuranceLevel: getAal,
      },
      getAuthenticatorAssuranceLevel: getAal,
    },
    rpc,
  } as unknown as FakeClient;

  return {
    client,
    spies: {
      getUser,
      signOut,
      getAal,
      rpc,
      signInWithPassword,
      updateUser,
      resetPasswordForEmail,
      verifyOtp,
      mfaEnroll,
      mfaChallenge,
      mfaVerify,
      mfaListFactors,
      mfaUnenroll,
    },
  };
}

export interface FakeServiceClientConfig {
  /** Result of GoTrue `admin.updateUserById`. */
  readonly adminUpdateUserById?: { error?: unknown };
  /** Result of GoTrue `admin.inviteUserByEmail`. */
  readonly inviteUserByEmail?: { data?: unknown; error?: unknown };
}

export interface FakeServiceClient {
  readonly client: FakeClient;
  readonly spies: {
    /** `from(table)` — specs implement per test to wire table chains. */
    readonly from: ReturnType<typeof vi.fn>;
    readonly updateUserById: ReturnType<typeof vi.fn>;
    readonly inviteUserByEmail: ReturnType<typeof vi.fn>;
  };
}

/**
 * A service-role fake. `from()` defaults to an empty chain for every table;
 * specs override `spies.from.mockImplementation(...)` and return
 * {@link fakeQueryChain} terminals for the tables they exercise.
 */
export function fakeServiceClient(config: FakeServiceClientConfig = {}): FakeServiceClient {
  const from = vi.fn(() => fakeQueryChain().chain);

  const updateUserById = vi.fn(async () => ({
    data: { user: null },
    error: config.adminUpdateUserById?.error ?? null,
  }));
  const inviteUserByEmail = vi.fn(async () => ({
    data: config.inviteUserByEmail?.data ?? { user: gotrueUserFixture() },
    error: config.inviteUserByEmail?.error ?? null,
  }));

  const client = {
    auth: { admin: { updateUserById, inviteUserByEmail } },
    from,
  } as unknown as FakeClient;

  return { client, spies: { from, updateUserById, inviteUserByEmail } };
}
