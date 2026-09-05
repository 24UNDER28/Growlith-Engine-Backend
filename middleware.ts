import { NextResponse, type NextRequest } from 'next/server';

import {
  planPageRoute,
  refreshSession,
  requestSessionCookieNames,
} from '@/server/auth/session-refresh';

/**
 * Middleware — refresh + coarse routing gate (design §7). THE PHASE 1 RULE
 * STANDS: this is never a security boundary. It refreshes the session cookie
 * (the only writer available during RSC rendering, whose cookie store is
 * read-only), redirects anonymous traffic away from `/admin` and `/portal`,
 * and sends authenticated visitors past the login page. Every authoritative
 * check repeats where data is read: `withRoute` for the API, layout guards for
 * pages, PostgreSQL RLS for rows.
 *
 * Exactly three responsibilities, no more:
 *   1. refresh — `getUser()` through a request/response-cookie-bound client;
 *   2. coarse gate — protected prefixes vs `/login?next=<safe-path>`;
 *   3. landing hint — `app_metadata.user_type`, a non-authoritative hint.
 *
 * Explicit non-responsibilities: no database reads (no `auth_context()`, no
 * status checks), no authorization, no `/api/**` traffic (matcher excludes
 * it — `withRoute` owns API auth so the two never double-verify), no logging
 * of tokens or token-bearing URLs.
 *
 * The matcher excludes API routes and static assets, per the design. `_next/*`
 * and `favicon.ico` never need a session; everything else is a page.
 */
export const config = {
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico).*)'],
};

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, searchParams } = request.nextUrl;

  const refreshed = await refreshSession(request);

  const userTypeHint = (() => {
    const hint = refreshed.user?.app_metadata?.user_type;
    return hint === 'INTERNAL' || hint === 'CLIENT' ? hint : null;
  })();

  const plan = planPageRoute({
    pathname,
    nextParam: searchParams.get('next'),
    state: refreshed.state,
    userTypeHint,
  });

  const response =
    plan.kind === 'unavailable'
      ? // Fail closed but distinguishable from "you are not logged in" (§7).
        new NextResponse('Service temporarily unavailable.', {
          status: 503,
          headers: { 'Retry-After': '30', 'Cache-Control': 'no-store' },
        })
      : plan.kind === 'redirect'
        ? NextResponse.redirect(new URL(plan.location, request.url))
        : NextResponse.next({ request });

  // Rotated session cookies ride out on whichever response was chosen. The
  // adapter exists because Next's `set` is a rest-args overload, which does
  // not structurally match the sink type under `exactOptionalPropertyTypes`.
  refreshed.applyCookies({
    cookies: {
      set: (name, value, options) => {
        if (options === undefined) {
          response.cookies.set(name, value);
        } else {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // A dead token family must not linger in the jar (§12): strip every session
  // cookie on the way past, whatever the response.
  if (refreshed.state === 'anonymous-invalid') {
    for (const name of requestSessionCookieNames(request)) {
      response.cookies.set(name, '', { maxAge: 0, path: '/' });
    }
  }

  return response;
}
