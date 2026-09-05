import 'server-only';

import { cookies } from 'next/headers';

import { createLogger } from '@/server/logging/logger';

/**
 * Session-cookie helpers.
 *
 * The session lives in `HttpOnly` cookies written by `@supabase/ssr`
 * (`sb-<project-ref>-auth-token`, chunked into `.0`, `.1`, … when large). Only
 * server code writes them (ADR-0026), and the three writers are middleware
 * (refresh), the auth route handlers (login/logout/status-gate), and the
 * confirm callback. This module is the one place that *clears* them.
 *
 * Clearing matters at four moments (design §3, §4, §14): logout, the status
 * gate rejecting a SUSPENDED/DEACTIVATED/INVITED identity, a replayed refresh
 * token (middleware strips them there), and defence in depth around any
 * forced eviction.
 */

/**
 * Matches `sb-<anything>-auth-token` and its chunks `sb-<anything>-auth-token.0`.
 * Anchor at `sb-` and require the `-auth-token` suffix so unrelated cookies are
 * never touched.
 */
const SESSION_COOKIE_PATTERN = /^sb-.+-auth-token(?:\.\d+)?$/;

export function isSessionCookieName(name: string): boolean {
  return SESSION_COOKIE_PATTERN.test(name);
}

/** Names of session cookies (including chunks) present in the caller's jar. */
export function presentSessionCookieNames(all: readonly { readonly name: string }[]): string[] {
  return all.map((cookie) => cookie.name).filter(isSessionCookieName);
}

/**
 * Clear every session cookie through the request's cookie store.
 *
 * In a Route Handler this attaches expired `Set-Cookie` headers to the outgoing
 * response — exactly what the design's "cookies cleared" rows require. Inside a
 * Server Component the store is READ-ONLY and `delete()` throws; that is
 * expected (middleware owns that path) and swallowed at debug level, per the
 * same policy as `client-server.ts`.
 */
export async function clearSessionCookies(scope: string): Promise<void> {
  const log = createLogger({ scope });
  try {
    const cookieStore = await cookies();
    const names = presentSessionCookieNames(cookieStore.getAll());
    for (const name of names) {
      cookieStore.delete(name);
    }
    if (names.length > 0) {
      log.debug('cleared session cookies', { count: names.length });
    }
  } catch (error) {
    log.debug('session cookie clearing skipped — no writable cookie store in this scope', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
