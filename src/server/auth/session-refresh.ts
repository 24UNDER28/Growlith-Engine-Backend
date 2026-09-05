/**
 * Middleware session support — REFRESH + ROUTING, nothing else (design §7).
 *
 * ⚠️ This is the ONE module under `src/server/` without `import 'server-only'`.
 * That is deliberate and load-bearing, not an oversight: middleware compiles
 * for the Edge runtime, where the `server-only` package evaluates its throwing
 * branch, so importing it here would break every page request at build time.
 * The exemption is enumerated in `tests/architecture/client-server-boundary.spec.ts`
 * block A with this same rationale, and what the module may import is pinned by
 * `tests/architecture/auth-boundary.spec.ts`:
 *
 *   - NO `client-service.ts` (the service_role key has no business in the
 *     middleware graph);
 *   - NO `@/server/env` (same reason);
 *   - only `@/lib/env/client-env` (public values) and `@supabase/ssr`.
 *
 * The module is secret-free by construction and by test.
 */

import { createServerClient } from '@supabase/ssr';

import { getClientEnv } from '@/lib/env/client-env';
import {
  isPublicAuthPage,
  isProtectedPath,
  loginRedirectPath,
  safeNextPath,
  landingHintFor,
} from '@/lib/auth/routes';
import type { User } from '@supabase/supabase-js';

/**
 * The minimal cookie-sink shape `applyCookies` needs: satisfied by
 * `NextResponse` without importing Next.js into this module (keeping it
 * unit-testable outside a Next runtime).
 */
export interface CookieSink {
  readonly cookies: {
    readonly set: (
      name: string,
      value: string,
      options?: {
        readonly domain?: string;
        readonly path?: string;
        readonly sameSite?: 'lax' | 'strict' | 'none' | boolean;
        readonly secure?: boolean;
        readonly httpOnly?: boolean;
        readonly maxAge?: number;
        readonly partitioned?: boolean;
      },
    ) => unknown;
  };
}

/**
 * See {@link CookieSink}. The options shape matches what `@supabase/ssr`
 * emits for session cookies (its DEFAULT_COOKIE_OPTIONS: path, sameSite,
        secure, httpOnly, maxAge — never `expires`), narrowed so it stays
 * assignable to every standard cookie sink.
 */
export type SessionCookieWriteOptions = NonNullable<Parameters<CookieSink['cookies']['set']>[2]>;

/**
 * Result of refreshing the session for a page request.
 *
 * `state` is deliberately the full classification middleware needs:
 * - `authenticated` — a network-verified user; refreshed cookies may ride out;
 * - `anonymous` — no session at all;
 * - `anonymous-invalid` — a session cookie existed but the token family is
 *   dead (expired/revoked/replayed refresh): strip the cookies and treat as
 *   logged out, with `reason=session_expired` on the redirect (§12);
 * - `outage` — Supabase could not be reached: unavailability, not anonymity.
 */
export type SessionRefreshState = 'authenticated' | 'anonymous' | 'anonymous-invalid' | 'outage';

export interface RefreshedSession {
  readonly state: SessionRefreshState;
  /** Present when `state === 'authenticated'`. */
  readonly user: User | null;
  /**
   * Apply any refreshed (rotated) session cookies to the outgoing response.
   * No-op unless the refresh rotated tokens. Middleware calls this on
   * whichever response it returns — pass-through, redirect or 503 — so a
   * rotation is never lost to a routing decision.
   */
  readonly applyCookies: (response: CookieSink) => void;
}

export async function refreshSession(request: {
  readonly cookies: { readonly getAll: () => { name: string; value: string }[] };
}): Promise<RefreshedSession> {
  const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey } = getClientEnv();

  // The rotation writes are buffered here and handed to middleware via
  // `applyCookies`, because the final response object does not exist yet at
  // the moment GoTrue rotates the tokens.
  const pendingWrites: {
    name: string;
    value: string;
    options?: CookieSink['cookies']['set'] extends (
      name: string,
      value: string,
      options?: infer T,
    ) => unknown
      ? T
      : never;
  }[] = [];

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const cookie of cookiesToSet) {
          pendingWrites.push(cookie as (typeof pendingWrites)[number]);
        }
      },
    },
  });

  let user: User | null = null;
  let state: SessionRefreshState;

  try {
    const {
      data: { user: verified },
      error,
    } = await supabase.auth.getUser();

    if (error === null && verified !== null) {
      user = verified;
      state = 'authenticated';
    } else if (error !== null && isOutageError(error)) {
      // Supabase unreachable is UNAVAILABILITY, not anonymity (§7): the
      // middleware will fail closed with 503 for protected prefixes.
      state = 'outage';
    } else if (request.cookies.getAll().some((cookie) => cookie.name.includes('auth-token'))) {
      // A cookie was present but the family is dead: rotation replay, expiry
      // or revocation. Not an outage — strip and continue anonymously.
      state = 'anonymous-invalid';
    } else {
      state = 'anonymous';
    }
  } catch {
    // Network-layer failure (fetch rejected) — same classification as a 5xx.
    state = 'outage';
  }

  return {
    state,
    user,
    applyCookies(response) {
      for (const write of pendingWrites) {
        response.cookies.set(write.name, write.value, write.options);
      }
    },
  };
}

function isOutageError(error: {
  readonly status?: number | undefined;
  readonly name?: string | undefined;
}): boolean {
  if (error.name === 'AuthRetryableFetchError') {
    return true;
  }
  return typeof error.status === 'number' && error.status >= 500;
}

/* ─────────────────────────── the routing planner ────────────────────────── */
/*
 * Pure decision logic, separated from the Edge glue so it is unit-testable
 * without a Next.js runtime. middleware.ts is a thin adapter that resolves a
 * session, calls `planPageRoute`, and translates the plan into a NextResponse.
 *
 * The middleware is a UX gate, never a security boundary (Phase 1 rule): every
 * authoritative check repeats where data is read (`withRoute`, layout guards,
 * RLS).
 */

export type PageRoutePlan =
  | { readonly kind: 'pass' }
  | { readonly kind: 'redirect'; readonly location: string }
  /** Fail closed but distinguishable from "not logged in": 503 + Retry-After. */
  | { readonly kind: 'unavailable' };

export interface PlanPageRouteInput {
  readonly pathname: string;
  /** Raw `next` query parameter, if any — sanitised inside via `safeNextPath`. */
  readonly nextParam: string | null;
  readonly state: SessionRefreshState;
  /**
   * Non-authoritative landing hint from `app_metadata.user_type` (ADR-0011).
   * A stale hint can at worst send someone to the wrong landing page; the
   * layout guard there is authoritative.
   */
  readonly userTypeHint: 'INTERNAL' | 'CLIENT' | null;
}

export function planPageRoute(input: PlanPageRouteInput): PageRoutePlan {
  const { pathname, state } = input;

  // Outage: protected prefixes fail closed with 503; public pages pass so the
  // login page and error pages stay reachable.
  if (state === 'outage') {
    return isProtectedPath(pathname) ? { kind: 'unavailable' } : { kind: 'pass' };
  }

  if (state === 'authenticated') {
    // An authenticated visitor on an auth page is routed onward to their
    // landing page. Without a usable hint the safest non-loop action is to
    // let the page render (it will resolve the truth server-side).
    if (isPublicAuthPage(pathname)) {
      const landing = landingHintFor(input.userTypeHint);
      return landing === null ? { kind: 'pass' } : { kind: 'redirect', location: landing };
    }
    return { kind: 'pass' };
  }

  // Anonymous (with or without dead cookies). Protected prefixes go to login
  // with a safe `next`; a dead session explains itself via `reason`.
  if (isProtectedPath(pathname)) {
    const next = safeNextPath(input.nextParam ?? pathname, '/');
    return {
      kind: 'redirect',
      location: loginRedirectPath(
        next,
        state === 'anonymous-invalid' ? 'session_expired' : undefined,
      ),
    };
  }

  return { kind: 'pass' };
}

/** Session cookie names present in the request, for stripping on dead sessions. */
export function requestSessionCookieNames(request: {
  readonly cookies: { getAll: () => { name: string; value: string }[] };
}): string[] {
  return request.cookies
    .getAll()
    .map((cookie) => cookie.name)
    .filter((name) => /^sb-.+-auth-token(?:\.\d+)?$/.test(name));
}
