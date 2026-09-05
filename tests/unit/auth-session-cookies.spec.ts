import { describe, expect, it } from 'vitest';

import { isSessionCookieName, presentSessionCookieNames } from '@/server/auth/session-cookies';

/**
 * Session-cookie contract (§4, §14, ADR-0026).
 *
 * The session lives exclusively in HttpOnly cookies written by `@supabase/ssr`
 * (`sb-<project-ref>-auth-token`, chunked as `.0`, `.1`, …). Only server code
 * writes them. Clearing them at logout, the status gate, and dead-session
 * stripping must match EXACTLY the cookie-name pattern — never touching
 * unrelated cookies (a stray `theme` or `_ga` cookie must survive).
 */

describe('isSessionCookieName — the cookie-name filter (§4)', () => {
  it('matches the unchunked session cookie', () => {
    expect(isSessionCookieName('sb-abcdefgh-auth-token')).toBe(true);
  });

  it('matches chunked session cookies', () => {
    expect(isSessionCookieName('sb-abcdefgh-auth-token.0')).toBe(true);
    expect(isSessionCookieName('sb-abcdefgh-auth-token.1')).toBe(true);
    expect(isSessionCookieName('sb-abcdefgh-auth-token.12')).toBe(true);
  });

  it('matches across different project refs', () => {
    expect(isSessionCookieName('sb-xyzproject-auth-token')).toBe(true);
    expect(isSessionCookieName('sb-a1b2c3d4e5-auth-token.3')).toBe(true);
  });

  it('rejects non-session cookies', () => {
    expect(isSessionCookieName('theme')).toBe(false);
    expect(isSessionCookieName('_ga')).toBe(false);
    expect(isSessionCookieName('next-auth.session-token')).toBe(false);
    expect(isSessionCookieName('')).toBe(false);
  });

  it('rejects cookies that look similar but do not match the pattern', () => {
    // Missing the -auth-token suffix
    expect(isSessionCookieName('sb-abcdefgh-other')).toBe(false);
    // Does not start with sb-
    expect(isSessionCookieName('other-auth-token')).toBe(false);
    // A prefix match that is NOT a session cookie
    expect(isSessionCookieName('sb-abcdefgh-auth-token-extra')).toBe(false);
    // Chunk suffix that is not a number
    expect(isSessionCookieName('sb-abcdefgh-auth-token.abc')).toBe(false);
  });

  it('is total: never throws on any input', () => {
    for (const name of ['', 'x', 'sb-', 'sb-x', 'sb-x-auth-token', 'sb-x-auth-token.0']) {
      expect(() => isSessionCookieName(name)).not.toThrow();
    }
  });
});

describe('presentSessionCookieNames — select only session cookies from the jar', () => {
  it('filters the jar to session cookies only', () => {
    const names = presentSessionCookieNames([
      { name: 'sb-project-auth-token' },
      { name: 'sb-project-auth-token.0' },
      { name: 'sb-project-auth-token.1' },
      { name: 'theme' },
      { name: '_ga' },
      { name: 'sb-other-auth-token' },
    ]);

    expect(names).toEqual([
      'sb-project-auth-token',
      'sb-project-auth-token.0',
      'sb-project-auth-token.1',
      'sb-other-auth-token',
    ]);
  });

  it('returns an empty array when no session cookies are present', () => {
    expect(presentSessionCookieNames([{ name: 'theme' }, { name: 'csrftoken' }])).toEqual([]);
  });

  it('returns an empty array for an empty jar', () => {
    expect(presentSessionCookieNames([])).toEqual([]);
  });
});
