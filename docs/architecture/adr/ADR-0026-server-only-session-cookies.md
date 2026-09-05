# ADR-0026 — Server-only session cookies; no browser Supabase client

**Status:** Accepted (Phase 3 design; implementation pending — see
`docs/architecture/authentication.md`)
**Phase:** 3 · **Resolves the browser-client placement decision deferred by
Phase 1** (`docs/architecture/README.md` §E listed three placement options for
`createBrowserClient`; this ADR answers "none of them, yet").

## Context

Phase 1 committed the portal to a strict reading of cookie-based sessions:
_"Browser JS never holds a raw access token: it lives in an `HttpOnly`,
`Secure`, `SameSite=Lax` cookie"_ (`docs/architecture/README.md` §D–E). It
also deliberately deferred the browser client factory, because
`createBrowserClient` is browser-only and had no consumer.

The deferral could not survive contact with Phase 3: the moment auth exists,
the placement question must be answered. But answering it exposed a conflict
the Phase 1 options table had glossed over — **any** placement of
`createBrowserClient` breaks the no-token-in-JS property:

- `@supabase/ssr`'s browser client stores the session in cookies it must
  **read and write from JavaScript** (to refresh tokens between page loads),
  so those cookies cannot be `HttpOnly`;
- the access token is therefore readable by any script that runs in the
  origin — an XSS becomes a session-theft primitive, and the Phase 1 request
  diagram's "(HttpOnly cookie, no token in JS)" invariant is false.

All three recorded placement options were variants of "where to put the
browser client", when the evidence said the answer is "not to have one".
Phase 3's consumers turned out not to need one: login, logout, password and
MFA are POST-able endpoints; email links are exchanged by a server route; and
session _awareness_ in the browser can be served by server-rendered context
plus one state-reporting endpoint.

## Decision

1. **No `createBrowserClient` is shipped in Phase 3, and no Supabase client
   exists in any client bundle.** The browser talks to this application only:
   `/api/v1/auth/**` (fetch, same-origin), `/auth/confirm` (link), and RSC
   payloads.
2. **Session cookies are written exclusively by server code**, in exactly
   three places: `middleware.ts` (refresh), `/api/v1/auth/**` route handlers
   (login, logout, password, MFA), and the `/auth/confirm` callback (email
   token exchange). All use `createServerClient` from `@supabase/ssr` bound to
   the request's cookies — preserving the cookie-session model with `HttpOnly`
   integrity intact.
3. **Browser session awareness** is served by (a) server-resolved context
   passed from protected layouts, (b) `GET /api/v1/auth/session` (returns the
   context or `null`, never a 401), and (c) envelope-code → navigation mapping
   in a thin fetch wrapper.
4. `src/lib/` remains isomorphic: the auth _vocabulary_ (statuses, route
   constants, DTO types) lives there; every auth _mechanism_ lives in
   `src/server/auth/`.

## Consequences

**Positive**

- The Phase 1 invariant is now load-bearing and true: tokens live only in
  `HttpOnly` cookies, so XSS cannot exfiltrate a session directly.
- One less runtime surface: no client-side token refresh logic, no
  `onAuthStateChange` bookkeeping, no dual-client cookie races.
- The boundary wall stays simple — there is no browser-only Supabase module
  to wall off, and the deferred Phase 1 placement question dissolves rather
  than being answered arbitrarily.

**Negative / accepted costs**

- No `onAuthStateChange`. Multi-tab and multi-device consistency comes from
  the shared cookie jar plus per-navigation middleware refresh; a tab holding
  stale in-memory state is corrected on its next server round trip. Accepted:
  nothing in the Phase 3 scope needs live auth-state push.
- Session awareness is request-scoped, not event-driven; Phase 9 UI must poll
  or re-render via navigation rather than subscribe. Accepted for Phase 9's
  known scope.
- **Supabase Realtime is incompatible with this decision as it stands** — a
  realtime socket authenticates from the browser, which would reintroduce a
  browser-held token. If Phase 9 wants realtime, it must amend this ADR with
  a scoped exception (e.g. short-TTL token minted per socket). Recorded now
  so the limitation is a decision, not a surprise.

**Verification at implementation:** the client-exposure scan
(`scripts/check-client-exposure.mjs`) and the architecture suite gain rules:
no `createBrowserClient` anywhere in the repository; no module under
`src/server/supabase/` imported by any client graph; middleware graph free of
the service client.
