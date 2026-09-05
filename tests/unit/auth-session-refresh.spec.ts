import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetClientEnvCacheForTests } from '@/lib/env/client-env';
import {
  planPageRoute,
  refreshSession,
  requestSessionCookieNames,
  type SessionRefreshState,
} from '@/server/auth/session-refresh';

/**
 * The middleware planner, tested WITHOUT Next.js: `planPageRoute` is pure, and
 * `refreshSession` is exercised with a mocked `@supabase/ssr` factory so the
 * classification matrix (authenticated / anonymous / anonymous-invalid /
 * outage) and the buffered cookie writes are asserted directly (§7).
 */

const createServerClientMock = vi.hoisted(() => vi.fn());

vi.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => createServerClientMock(...args),
}));

const CLIENT_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://db.test.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-test-key',
};

/** Script `getUser` for the fake Edge client `refreshSession` builds. */
function scriptUser(result: { user?: unknown; error?: { name?: string; status?: number } | null }) {
  createServerClientMock.mockImplementation(() => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: result.user ?? null },
        error: result.error ?? null,
      })),
    },
  }));
}

function fakeRequest(cookies: string[]) {
  return {
    cookies: {
      getAll: () => cookies.map((name) => ({ name, value: 'x' })),
    },
  };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', CLIENT_ENV.NEXT_PUBLIC_SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', CLIENT_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.test.local');
  __resetClientEnvCacheForTests();
  createServerClientMock.mockReset();
  createServerClientMock.mockImplementation(() => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
  }));
});

describe('planPageRoute — the routing matrix', () => {
  type Case = readonly [
    name: string,
    input: {
      pathname: string;
      nextParam: string | null;
      state: SessionRefreshState;
      userTypeHint: 'INTERNAL' | 'CLIENT' | null;
    },
    expected: { kind: string; location?: string },
  ];

  const cases: readonly Case[] = [
    // Anonymous visitors.
    [
      'anonymous on /admin goes to login with next',
      { pathname: '/admin', nextParam: null, state: 'anonymous', userTypeHint: null },
      { kind: 'redirect', location: '/login?next=%2Fadmin' },
    ],
    [
      'anonymous on /portal/settings carries its path',
      { pathname: '/portal/settings', nextParam: null, state: 'anonymous', userTypeHint: null },
      { kind: 'redirect', location: '/login?next=%2Fportal%2Fsettings' },
    ],
    [
      'anonymous honours a safe next param',
      { pathname: '/admin', nextParam: '/portal', state: 'anonymous', userTypeHint: null },
      { kind: 'redirect', location: '/login?next=%2Fportal' },
    ],
    [
      'anonymous with hostile next falls back to /',
      { pathname: '/admin', nextParam: '//evil.example', state: 'anonymous', userTypeHint: null },
      { kind: 'redirect', location: '/login?next=%2F' },
    ],
    [
      'anonymous-invalid explains itself with session_expired',
      { pathname: '/admin', nextParam: null, state: 'anonymous-invalid', userTypeHint: null },
      { kind: 'redirect', location: '/login?next=%2Fadmin&reason=session_expired' },
    ],
    [
      'anonymous on the login page passes through',
      { pathname: '/login', nextParam: null, state: 'anonymous', userTypeHint: null },
      { kind: 'pass' },
    ],
    [
      'anonymous on a public page passes through',
      { pathname: '/auth/set-password', nextParam: null, state: 'anonymous', userTypeHint: null },
      { kind: 'pass' },
    ],

    // Authenticated visitors.
    [
      'authenticated INTERNAL on /login is bounced to /admin',
      { pathname: '/login', nextParam: null, state: 'authenticated', userTypeHint: 'INTERNAL' },
      { kind: 'redirect', location: '/admin' },
    ],
    [
      'authenticated CLIENT on /login is bounced to /portal',
      { pathname: '/login', nextParam: null, state: 'authenticated', userTypeHint: 'CLIENT' },
      { kind: 'redirect', location: '/portal' },
    ],
    [
      'authenticated without hint stays (page resolves truth)',
      { pathname: '/login', nextParam: null, state: 'authenticated', userTypeHint: null },
      { kind: 'pass' },
    ],
    [
      'authenticated on protected page passes',
      {
        pathname: '/admin/users',
        nextParam: null,
        state: 'authenticated',
        userTypeHint: 'INTERNAL',
      },
      { kind: 'pass' },
    ],
    [
      'authenticated on public root passes',
      { pathname: '/', nextParam: null, state: 'authenticated', userTypeHint: 'INTERNAL' },
      { kind: 'pass' },
    ],

    // Outage.
    [
      'outage on a protected prefix fails closed with 503',
      { pathname: '/admin', nextParam: null, state: 'outage', userTypeHint: null },
      { kind: 'unavailable' },
    ],
    [
      'outage on the login page passes (login must stay reachable)',
      { pathname: '/login', nextParam: null, state: 'outage', userTypeHint: null },
      { kind: 'pass' },
    ],
  ];

  for (const [name, input, expected] of cases) {
    it(name, () => {
      const plan = planPageRoute(input);
      expect(plan).toMatchObject(expected);
      if (plan.kind === 'redirect' && 'location' in expected) {
        expect(plan.location).toBe(expected.location);
      }
    });
  }
});

describe('refreshSession — classification', () => {
  it('reports authenticated for a network-verified user', async () => {
    scriptUser({ user: { id: 'u1', app_metadata: {} } });
    const refreshed = await refreshSession(fakeRequest(['sb-project-auth-token']));
    expect(refreshed.state).toBe('authenticated');
    expect(refreshed.user).toMatchObject({ id: 'u1' });
  });

  it('reports anonymous when no session cookie exists', async () => {
    scriptUser({ user: null, error: null });
    const refreshed = await refreshSession(fakeRequest([]));
    expect(refreshed.state).toBe('anonymous');
  });

  it('reports anonymous-invalid when a session cookie is present but dead', async () => {
    scriptUser({ user: null, error: { name: 'AuthSessionMissingError' } });
    const refreshed = await refreshSession(fakeRequest(['sb-project-auth-token']));
    expect(refreshed.state).toBe('anonymous-invalid');
  });

  it('reports outage for retryable fetch errors, not anonymous', async () => {
    scriptUser({ user: null, error: { name: 'AuthRetryableFetchError' } });
    const refreshed = await refreshSession(fakeRequest(['sb-project-auth-token']));
    expect(refreshed.state).toBe('outage');
  });

  it('reports outage for 5xx auth errors', async () => {
    scriptUser({ user: null, error: { name: 'AuthApiError', status: 503 } });
    const refreshed = await refreshSession(fakeRequest([]));
    expect(refreshed.state).toBe('outage');
  });

  it('reports outage when getUser throws at the network layer', async () => {
    createServerClientMock.mockImplementation(() => ({
      auth: {
        getUser: vi.fn(async () => {
          throw new Error('fetch failed');
        }),
      },
    }));
    const refreshed = await refreshSession(fakeRequest([]));
    expect(refreshed.state).toBe('outage');
  });
});

describe('refreshSession — rotated cookie handoff', () => {
  it('buffers setAll writes and replays them on applyCookies, in order', async () => {
    let cookieSink:
      | {
          getAll: () => { name: string; value: string }[];
          setAll: (cookies: { name: string; value: string; options?: unknown }[]) => void;
        }
      | undefined;

    createServerClientMock.mockImplementation((_url: string, _key: string, options: unknown) => {
      const config = options as { cookies: typeof cookieSink };
      cookieSink = config.cookies;
      return {
        auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
      };
    });

    const refreshed = await refreshSession(fakeRequest(['sb-project-auth-token']));

    // GoTrue rotates: two chunked cookies with options.
    expect(cookieSink).toBeDefined();
    cookieSink?.setAll([
      { name: 'sb-project-auth-token.0', value: 'part-a', options: { maxAge: 3600, path: '/' } },
      { name: 'sb-project-auth-token.1', value: 'part-b', options: { maxAge: 3600, path: '/' } },
    ]);

    const writes: { name: string; value: string; options?: unknown }[] = [];
    refreshed.applyCookies({
      cookies: {
        set: (name, value, options) => {
          writes.push({ name, value, options });
        },
      },
    });

    expect(writes.map((w) => w.name)).toEqual([
      'sb-project-auth-token.0',
      'sb-project-auth-token.1',
    ]);
    expect(writes[0]).toMatchObject({ value: 'part-a', options: { maxAge: 3600, path: '/' } });
  });

  it('applies nothing when no rotation happened', async () => {
    scriptUser({ user: null, error: null });
    const refreshed = await refreshSession(fakeRequest([]));
    const set = vi.fn();
    refreshed.applyCookies({ cookies: { set } });
    expect(set).not.toHaveBeenCalled();
  });
});

describe('requestSessionCookieNames', () => {
  it('selects exactly the sb-*-auth-token(.N)? family', () => {
    const names = requestSessionCookieNames(
      fakeRequest([
        'sb-project-auth-token',
        'sb-project-auth-token.0',
        'sb-project-auth-token.12',
        'sb-project-auth-token-bogus',
        'other-auth-token',
        'sb-other-provider',
        'theme',
      ]),
    );
    expect(names).toEqual([
      'sb-project-auth-token',
      'sb-project-auth-token.0',
      'sb-project-auth-token.12',
    ]);
  });
});
