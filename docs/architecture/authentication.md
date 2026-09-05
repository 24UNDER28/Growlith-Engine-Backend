# Phase 3 — Authentication Design

**Status:** designed — implementation pending. This document is the Phase 3
contract; nothing in it is implemented yet, by instruction. Implementation
follows the sequence in [§J](#j-implementation-sequence).
**Decisions:** [ADR-0011](adr/ADR-0011-authorization-data-lives-in-postgres-not-jwt-claims.md)
(no authorization data in JWT claims), [ADR-0026](adr/ADR-0026-server-only-session-cookies.md)
(server-only session cookies, no browser Supabase client).
**Inputs:** Phase 1 architecture (`docs/architecture/README.md` §E), Phase 2
schema (`profiles`, `organization_memberships`, `invitations`,
`platform_role_grants`, `audit_events`, and the `SECURITY DEFINER` RLS
helpers), the role vocabulary in `src/lib/domain/roles.ts`, and the error
envelope in `src/server/api/errors.ts`.

---

## 0. Summary

Authentication is **delegated entirely to Supabase Auth** (GoTrue): no custom
JWT issuance, no session table, no password hashing in application code.
Sessions travel as `HttpOnly` cookies managed by `@supabase/ssr` and are
written **only by server code** — `middleware.ts` (refresh), the
`/api/v1/auth/**` route handlers (login, logout, password, MFA), and the
`/auth/confirm` callback that exchanges email-link tokens for sessions
(ADR-0026: there is no browser Supabase client at all).

Every privileged surface re-verifies the session **at the point of use**:
`middleware.ts` performs only refresh and coarse routing; `withRoute` gains a
required per-route authentication declaration; Server Component layout guards
repeat the same check; and PostgreSQL RLS — using the Phase 2 `is_active_account()`
predicate — is the final, independent gate. **No role, status or permission
ever travels in the JWT** (ADR-0011); the database is the only authority on
what an identity may do, resolved per request through a `SECURITY DEFINER`
`growlith.auth_context()` function so the application and RLS share one
definition of "who is this and what state are they in".

Accounts come into existence **only by invitation** — sign-up is disabled —
and the `invitations` row, holding only a SHA-256 of the invitation token, is
the audited ledger of every pending access grant. `TOTP` MFA is mandatory for
`SUPER_ADMIN` and `ADMIN`.

---

# Part I — Design specifications

The fifteen areas below are the detailed mechanics. Part II restates them as
the consolidated A–J deliverables.

## 1. Authentication flow (overview)

All authentication enters through exactly three kinds of surface:

| Surface             | Files (Phase 3)               | Runs as                                | Writes session cookies                       |
| ------------------- | ----------------------------- | -------------------------------------- | -------------------------------------------- |
| Auth API            | `app/api/v1/auth/**/route.ts` | Node route handler with `withRoute`    | ✅ (login, logout, password, MFA)            |
| Email-link callback | `app/auth/confirm/route.ts`   | Node route handler (redirect response) | ✅ (invite, recovery, verification exchange) |
| Middleware          | `middleware.ts` (repo root)   | Edge-compatible middleware             | ✅ (refresh only)                            |

Nothing else may call `supabase.auth.*` mutators. The constraint is enforced
by an architecture test: modules outside `src/server/auth/` and the callback
may not reference the auth namespace (see §15).

The complete lifecycle of every flow in this phase:

```
 REGISTRATION                 LOGIN                    RECOVERY
 ────────────                 ─────                    ────────
 admin POSTs invitation       POST /api/v1/auth/login  POST /api/v1/auth/password-recovery
   │ service-role invite        │ signInWithPassword      │ resetPasswordForEmail (always 202)
   ▼                            ▼                         ▼
 GoTrue emails link           cookies set (server)     GoTrue emails link
   │                            │ requireAuthContext      │
   ▼                            ├─ ACTIVE → landing       ▼
 GET /auth/confirm             ├─ SUSPENDED → 423       GET /auth/confirm?type=recovery
   ?type=invite&it=TOKEN        ├─ DEACTIVATED → 401       │ verifyOtp → session (server)
   │ verifyOtp(type=invite)     └─ INVITED → 403 pending   ▼
   │ + session established                              /reset-password → POST password
   ▼                                                    │ updateUser + sign out others
 accept_invitation RPC ──────── MFA step-up (staff):     ▼
   │ invitation → ACCEPTED       │ challenge + verify    redirect, audit
   │ profile  → ACTIVE           │ aal1 → aal2
   │ membership → ACTIVE         ▼
   ▼                          landing: INTERNAL → /admin
 /auth/set-password            CLIENT with ACTIVE membership → /portal
   │ updateUser({password})
   ▼
 landing
```

Two GoTrue behaviours the implementation must verify against the pinned
`supabase-js`/GoTrue versions before coding against them (marked
**verify-at-implementation**, per the ADR-0022 pin-on-evidence rule):

- that a second `inviteUserByEmail` for an **unconfirmed** user re-sends the
  invite (and that a confirmed user is rejected with a distinct error);
- the GoTrue config keys for mail-OTP expiry, so the invite link's lifetime
  matches the `invitations.expires_at` row (design target: 7 days).

## 2. Invitation flow

**Principle:** every account originates from a server-side invitation; sign-up
is disabled in Supabase Auth. The invitation is both an email and an audited
database row whose token exists **only** in the email — the database stores
`token_hash` (SHA-256, hex), never the token (Phase 2 schema, `invitations`).

### 2.1 Creation — `POST /api/v1/invitations` (authenticated)

Capability checks arrive in Phase 4; Phase 3 requires only a valid session and
records the actor. Steps, all server-side:

1. **Validate** `{ email, role, organizationId | platformRole, message? }`
   with a strict Zod schema (ADR-0017). Exactly one branch, mirroring the
   `invitations_exactly_one_branch` CHECK.
2. **Resolve the target.** Look up any existing auth identity for the address
   (service-role admin lookup — justified call site per
   `client-service.ts`):

   | State of the address                                        | Action                                                                                             |
   | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
   | No auth user                                                | Create + invite (2.2)                                                                              |
   | Auth user exists, **unconfirmed** (invited, never accepted) | **Re-issue**: re-send invite, update the pending invitation row (`resent_count`, `last_sent_at`)   |
   | Auth user exists, confirmed, live `profiles` row            | **Reject 409** — an existing person is routed through status/role flows, never a second invitation |

   The unique partial index `invitations_pending_unique` backstops this: two
   live invitations for the same address into the same target are
   unrepresentable, so the conflict path is also the concurrency path.

3. **Mint the app token**: 32 bytes from `crypto.randomBytes`, base64url — a
   credential with the same lifetime as the invitation. Persist
   `sha256(token)` as `token_hash`; the raw value is embedded **only** in the
   email's redirect target.
4. **Service-role invite**: `auth.admin.inviteUserByEmail(email, { data: { full_name, user_type }, redirectTo })`
   where `redirectTo = ${APP_URL}/auth/confirm?type=invite&it=<raw-token>&next=…`.
   GoTrue creates `auth.users`; the existing `on_auth_user_created` trigger
   creates the `profiles` row with `account_status = 'INVITED'`.
5. **Write the ledger**: `invitations` row `PENDING`, `expires_at = now() +
7 days`, `invited_by = actor`. **Client branch only**: also insert the
   `organization_memberships` row now, `status = 'INVITED'`, `invited_by` set —
   this is the "membership row written explicitly by the invite endpoint"
   rule from the Phase 1 architecture, so role assignment is an explicit,
   audited server decision rather than a side effect of link-clicking. The
   **staff branch** defers the `platform_role_grants` write to acceptance,
   because a grant is an event with a granter (§C, §D).
6. **Audit** `INVITE_SENT` (CRITICAL for staff branch, NOTICE for client) and
   return the invitation DTO.

### 2.2 Acceptance — `GET /auth/confirm?type=invite&token_hash=…&it=…`

One route handler, two credentials in the link: Supabase's `token_hash`
(proves control of the mailbox) and the app token `it` (selects the
invitation). Order matters:

1. `verifyOtp({ type: 'invite', token_hash })` **through the request-scoped
   user client** — GoTrue confirms the email and the server sets the session
   cookies on the redirect response. Failure → redirect `/link-invalid`.
2. Call the **`SECURITY DEFINER` RPC `growlith.accept_invitation(p_raw_token text)`**
   (ADR-0012 pattern; the caller's `auth.uid()` identifies the accepter). In
   one transaction it: hashes and looks up the token; rejects anything not
   `PENDING` and unexpired (lazily flipping `PENDING` + past `expires_at` →
   `EXPIRED`); verifies `invitations.email` matches `auth.uid()`'s email;
   then —
   - _client branch_: flips the invitation `ACCEPTED`, activates the
     membership (`ACTIVE`, `joined_at = now()`), activates the profile
     (`INVITED → ACTIVE`), and enforces the domain invariant that a `CLIENT`
     profile holds **at most one** organization membership (a second live
     membership elsewhere is a rejection, not a merge);
   - _staff branch_: flips the invitation `ACCEPTED`, activates the profile,
     and inserts the `platform_role_grants` row with `granted_by =
invitations.invited_by` and a reason citing the invitation id;
   - writes audit rows `INVITE_ACCEPTED`, `STATUS_CHANGE`, and (staff)
     `ROLE_GRANT` inside the same transaction.
3. Redirect to `/auth/set-password` with the fresh session. The account is
   `ACTIVE` but has **no password** until this step; abandoning here is safe —
   the standard recovery flow sets the first password (§9).

### 2.3 Resend and revoke

- **Resend** = the re-issue row of the table in 2.1, via a
  `POST /api/v1/invitations/{id}/resend` route; it re-runs `inviteUserByEmail`
  with a **fresh app token** (new `token_hash` on the same row;
  `freeze_invitation_terms` permits this — only email/target/role are frozen),
  bumps `resent_count`, re-audits `INVITE_SENT`.
- **Revoke** = `POST /api/v1/invitations/{id}/revoke`: sets `REVOKED` with
  `revoked_by`; the acceptance RPC then rejects by status. A revoked invitation
  does **not** touch the GoTrue identity — an unconfirmed identity that was
  never accepted is inert (no password, no session); an accepted invitation is
  terminal (`ACCEPTED` cannot change, per the Phase 2 trigger) and offboarding
  goes through account statuses (§8).

## 3. Login flow — `POST /api/v1/auth/login`

1. Strict Zod body `{ email, password }` (`.strict()`, so mass assignment is
   rejected by the existing pipeline).
2. `signInWithPassword` **through the request-scoped server client** — on
   success GoTrue sets the session and `@supabase/ssr` writes the `HttpOnly`
   cookies into the response. The browser never sees a token.
3. **Status gate** — `requireAuthContext()` (§5) against the just-issued
   session, before anything tenant-related runs:

   | `profiles.account_status` | Response                                           | Session                           |
   | ------------------------- | -------------------------------------------------- | --------------------------------- |
   | `ACTIVE`                  | continue                                           | kept                              |
   | `SUSPENDED`               | `423 ACCOUNT_SUSPENDED`                            | revoked (global), cookies cleared |
   | `DEACTIVATED`             | `401 UNAUTHENTICATED` (code `ACCOUNT_DEACTIVATED`) | revoked, cleared                  |
   | `INVITED`                 | `403` (code `INVITATION_PENDING`)                  | revoked, cleared                  |

   Rationale: these codes face the account holder, who is entitled to know
   their own account state; nothing here reveals whether an _address_ exists
   (step 2 already failed uniformly with `401 INVALID_CREDENTIALS` for wrong
   email/password, and GoTrue's own rate limits protect the endpoint).

4. **MFA step-up** (§6c): if factors are enrolled, the login response is `200`
   with `data.mfaRequired = true` and no landing path; the session is `aal1`
   and every protected surface rejects it until the challenge completes.
   `SUPER_ADMIN`/`ADMIN` without an enrolled factor are forced into enrollment
   on first entry to `/admin` (§6c).
5. **Audit + presence**: `LOGIN` audit row and a throttled `last_seen_at`
   touch (§5, step 4). `LOGIN_FAILED` is audited with a reason enum
   (`invalid_credentials | rate_limited | account_state`); the redaction
   module already prevents credentials entering logs.
6. Response: `200 { data: { user: AuthContextDTO, mfaRequired, redirectTo } }`.
   `redirectTo` is derived server-side from the resolved context — never from
   the request.

Membership status does **not** block login (a person may hold one live
membership and it may be `SUSPENDED`); it gates tenant surfaces (§8).

## 4. Session lifecycle

**What a session is.** One GoTrue session = a short-lived **access token JWT**
(default 3600 s) plus a **refresh token** under rotation. `@supabase/ssr`
serialises both into the cookie `sb-<project-ref>-auth-token`, chunked into
`…-auth-token.0`, `.1`, … when they exceed the single-cookie size limit. The
cookie is `HttpOnly`, `Secure` (production), `SameSite=Lax`, host-scoped,
`Path=/`.

**Who writes it — three writers, one rule.** Only server code writes session
cookies (ADR-0026): middleware (refresh), `/api/v1/auth/**` handlers, and
`/auth/confirm`. Consequently the browser never holds a readable token, and
`createBrowserClient` is never shipped in this phase.

**Refresh points.**

| Surface                                  | Refresh mechanism                                                                                                                                | Notes                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Page navigation (`/admin`, `/portal`, …) | `middleware.ts` calls `getUser()` on a request/response-cookie-bound client; rotated tokens are written onto the **response**                    | The only writer available during RSC rendering, whose cookie store is read-only                      |
| API requests                             | `withRoute`'s authentication step uses the request-scoped client; route handlers **can** persist refreshed cookies, so an API call refreshes too | Middleware deliberately **excludes** `/api/**` (§7) to avoid a duplicate `getUser()` per API request |
| Anonymous/expired on public pages        | none                                                                                                                                             | Nothing to protect                                                                                   |

**Rotation and reuse.** Refresh-token rotation stays enabled with GoTrue's
reuse interval (default 10 s): a replayed refresh token invalidates the token
family, and the next `getUser()` fails — the middleware then strips the
cookies and treats the browser as logged out (§12). This is the practical
theft-detection control.

**Lifetime posture.** Access-token TTL 3600 s (dashboard/config.toml) is kept
for Phase 3. GoTrue has no native idle or absolute session timeout; shortening
the TTL for privileged roles and an app-side absolute cap (via `last_seen_at`)
are recorded as Phase 6 candidates, not Phase 3 scope.

**Revocation paths** — all through `auth.admin.signOut` (global) or the
user's own `signOut`:

| Trigger                          | Action                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| Logout                           | user's own `signOut({ scope: 'global' })` (§14)                                                 |
| Password set/change via recovery | `signOut({ scope: 'others' })` — evict other devices, keep the current one                      |
| `SUSPENDED` / `DEACTIVATED`      | status service revokes globally and sets a GoTrue ban as defence in depth (§8)                  |
| Platform-role revocation         | **no session action** — roles are not claims (ADR-0011); effect is immediate on next resolution |
| Auth user deleted (hard)         | cascade removes the profile; next `getUser()` fails; middleware strips cookies                  |

**Residual risk, stated:** a stolen access token remains valid until expiry
even after logout/revocation (GoTrue access tokens are stateless). Mitigations
are the 1 h TTL, rotation-backed refresh, `HttpOnly` theft-resistance, and —
for privileged roles — mandatory MFA on the surfaces that matter. This is
documented, not hidden; Phase 6 revisits TTLs.

## 5. Server-side session verification

**Rule (from Phase 1, now made structural):** the _only_ function that may
decide "who is this request" is `requireAuthContext()` in
`src/server/auth/context.ts`. It is the single authority; it never trusts a
locally decoded token; `getSession()` is banned for decisions and the ban is
an architecture test.

Steps, in order:

1. Build the request-scoped client (`client-server.ts` — anon key + the
   caller's cookies).
2. `supabase.auth.getUser()` — **network verification** with Supabase:
   signature, expiry, and that the identity still exists. No valid user →
   `ApiError.unauthenticated()` (401 `UNAUTHENTICATED`).
3. **One round trip** to resolve identity+state: the `SECURITY DEFINER`
   function `growlith.auth_context()` (pinned `search_path`, `STABLE`,
   ADR-0008 conventions), called **through the user-JWT client** and anchored
   on `auth.uid()`. It returns the profile row, the live platform role
   (reusing the `auth_platform_role()` predicate), and the live organization
   memberships. This makes the database — not application code — the single
   definition of "is this account `ACTIVE`", the same predicates Phase 4 RLS
   policies will use. It also sidesteps the pre-Phase-4 reality that
   `profiles` has no policies yet: a definer function is the sanctioned,
   auditable read path (ADR-0008/0012), and it keeps working unchanged once
   policies land.
4. **Status gate** (§8): `SUSPENDED` → `423` (+ best-effort global revoke);
   `DEACTIVATED` → `401`; `INVITED` → `403 INVITATION_PENDING`.
5. Per-request memoisation: `cache()`-wrapped for Server Components, one
   resolution per route handler — `withRoute` resolves once and hands the
   context to the handler.
6. **Presence**: a `last_seen_at` touch is throttled app-side (only when the
   fetched value is older than 5 minutes) and executed via `after()` so it
   never delays the response, through a tiny definer `growlith.touch_last_seen()`.

The resolved contract:

```ts
interface AuthContext {
  readonly userId: string; // auth.users.id === profiles.id
  readonly email: string;
  readonly userType: 'INTERNAL' | 'CLIENT';
  readonly accountStatus: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  readonly platformRole: 'SUPER_ADMIN' | 'ADMIN' | null; // resolved live, never from the JWT
  readonly memberships: ReadonlyArray<{
    readonly organizationId: string;
    readonly role: 'CLIENT_ADMIN' | 'CLIENT_MEMBER';
    readonly status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
    readonly isPrimaryContact: boolean;
  }>;
  readonly aal: 'aal1' | 'aal2'; // from the verified session
}
```

**Authenticated server requests.** `withRoute` gains a **required** route
declaration:

```ts
readonly auth: 'public' | 'required';
// Phase 4 adds:  readonly capability: Capability;
```

`'required'` routes resolve `requireAuthContext()` after validation and before
the handler; the handler context exposes a non-optional `auth`. `'public'`
routes skip resolution. Omitting the field is a **compile error** — the same
structural enforcement `withRoute` already applies to `method` and `summary`,
and the exact pattern Phase 4 uses for `capability`. A contract test asserts
every file under `app/api/**` declares `auth`. `/api/v1/health` and the auth
endpoints are the initial `'public'` set; everything else defaults to denied
by construction.

## 6. Client-side session awareness

Because there is **no browser Supabase client** (ADR-0026), the browser learns
about the session in three ways:

1. **Server-rendered context** (primary). Protected layouts resolve
   `requireAuthContext()` on the server and pass a plain DTO down as props.
   There is no `onAuthStateChange` to subscribe to; the RSC payload _is_ the
   session state for that render.
2. **`GET /api/v1/auth/session`** — a `'public'` route returning
   `200 { data: { session: AuthContextDTO | null } }` (never a 401, so clients
   branch on data rather than exceptions) for client components that must
   react without a re-render.
3. **A thin fetch wrapper** (Phase 9 UI consumes it; the wrapper itself is
   Phase 3 foundation) that maps envelope codes to navigation:
   `UNAUTHENTICATED` → `/login?next=…`, `ACCOUNT_SUSPENDED` →
   `/account-restricted`, else surface the error envelope as-is.

Multi-tab consistency comes from the shared cookie jar plus per-navigation
middleware refresh; a tab holding a stale in-memory copy is corrected on its
next server round trip. **Deferred deliberately:** Supabase Realtime requires
an authenticated socket from the browser, which would reintroduce a
browser-held token; if Phase 9 wants realtime it must amend ADR-0026 with a
scoped exception. Not decided now, because no consumer exists.

## 7. Middleware strategy

`middleware.ts` lives at the **repository root** (the app directory is
`app/` at root, so there is no `src/app` and no `src/middleware.ts`). It is a
**routing gate and refresh mechanism only** — the Phase 1 rule stands: it is
never a security boundary, and every authoritative check repeats where data is
read (`withRoute` step, layout guards, RLS).

Responsibilities, exactly three:

1. **Refresh.** Bind `@supabase/ssr` to `request.cookies` (read) and
   `response.cookies` (write); `getUser()` triggers rotation when needed and
   refreshed cookies ride out on the response. The middleware imports only
   `@/lib/env/client-env` (public values) and a dedicated
   `src/server/auth/session-refresh.ts` — it must **not** import
   `client-service.ts`, and an architecture test asserts that (the
   `service_role` key has no business in the middleware graph).
2. **Coarse gate.** With no valid session, requests to protected prefixes
   (`/admin`, `/portal`) are redirected to
   `/login?next=<safe-path>`; `/login` with a valid session redirects to the
   landing path. The `next` parameter accepts **same-origin relative paths
   only** (must start with `/`, must not start with `//`) — open-redirect
   guard.
3. **Landing hint.** For routing only, the verified user's `app_metadata.user_type`
   (a non-authoritative hint, ADR-0011) picks `/admin` vs `/portal`. A stale
   hint can, at worst, send someone to the wrong landing page — the layout
   guard there is authoritative.

Explicit **non-responsibilities**: no database reads (no `auth_context()`, no
status checks — those live in §5), no authorization, no `/api/**` traffic
(matcher excludes it), no logging of tokens.

```ts
export const config = {
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico).*)'],
};
```

**Failure semantics.** Supabase unreachable is _unavailability_, not
_anonymity_: protected prefixes get a 503 page with `Retry-After` (fail-closed
but distinguishable from "you are not logged in"); public prefixes pass
through so the error pages and login remain reachable. A hard
`getUser()` rejection from a _revoked_ refresh token is not an outage: strip
the session cookies and redirect to `/login` (§12).

## 8. Account status checks

Two independent axes, per the Phase 2 enums: `profiles.account_status`
(platform-wide) and `organization_memberships.status` (per-organization).
`platform_role_grants` add a third, non-status dimension (revocation/expiry)
already handled inside `auth_platform_role()`.

**Enforcement points** (defence in depth — each survives the failure of the
others):

| Point                               | Mechanism                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login                               | §3 status gate                                                                                                                                                                  |
| Every request (API + protected RSC) | `requireAuthContext()` status gate (§5)                                                                                                                                         |
| Tenant data                         | `organization_memberships.status = 'ACTIVE'` required by guards; Phase 4 RLS (`current_org_ids()`) enforces the same in the database                                            |
| Last line                           | `is_active_account()` — already written in Phase 2 — is ANDed into every future policy, so a suspended account loses row access even if every application check above is broken |

**Behaviour matrix.**

| Status        | Login                     | API request | Portal/Admin page              | Data (RLS, Phase 4)                  | Sessions                |
| ------------- | ------------------------- | ----------- | ------------------------------ | ------------------------------------ | ----------------------- |
| `INVITED`     | 403 `INVITATION_PENDING`  | 403         | redirect to invite status page | none                                 | none issued             |
| `ACTIVE`      | ✓                         | ✓           | per user-type + membership     | per membership/role                  | live                    |
| `SUSPENDED`   | 423                       | 423         | `/account-restricted`          | denied (`is_active_account()` false) | revoked at suspension   |
| `DEACTIVATED` | 401 `ACCOUNT_DEACTIVATED` | 401         | `/account-restricted`          | denied                               | revoked at deactivation |

**Membership-axis behaviour** (account itself `ACTIVE`): a `SUSPENDED` or
`DEACTIVATED` membership removes the organization from the actor's live set
(`current_org_ids()` already filters on `status = 'ACTIVE'`). Login still
succeeds — the identity is fine — but every tenant surface for that
organization is denied, and a client user whose only membership is inactive
sees a restricted state rather than an empty portal.

**Transitions** (single writer: `src/server/auth/accounts.ts`; each write is
audited `STATUS_CHANGE` with `before`/`after`):

```
INVITED ──accept──▶ ACTIVE ──suspend──▶ SUSPENDED ──reinstate──▶ ACTIVE
   │                   │                     │
   (invite lapses      └──deactivate──▶ DEACTIVATED ◀──┘
    or is revoked)                         ▲
DEACTIVATED ──reactivate (SUPER_ADMIN only, CRITICAL audit)──▶ ACTIVE
```

- `INVITED → ACTIVE`: only via `accept_invitation` (§2.2).
- `ACTIVE → SUSPENDED`: platform admins for any account; `CLIENT_ADMIN` for
  own-org **memberships** only (capabilities land in Phase 4; the service
  takes the actor and validates scope — until Phase 4 the endpoints are
  SUPER_ADMIN/ADMIN-gated behind authentication alone and are not exposed in
  any UI).
- `SUSPENDED → ACTIVE`: reinstatement issues **no** resurrected sessions; the
  user signs in fresh.
- `ACTIVE → DEACTIVATED`: offboarding. Deactivation also sets all live
  memberships `DEACTIVATED` and revokes platform-role grants
  (`revoked_at`-style append rows). The `profiles.deleted_at` soft delete is a
  _different_ mechanism reserved for erasure alongside hard deletion of the
  auth identity; deactivation deliberately does not soft-delete the profile,
  so the audit trail keeps a named actor.
- Every suspension/deactivation additionally (a) revokes sessions globally via
  the service-role admin API — a justified call site, commented per
  `client-service.ts` — and (b) sets the GoTrue **ban** on the identity so the
  auth server itself refuses new logins; reinstatement lifts the ban. Belt and
  braces: the application gate and the auth-server gate fail independently.

**Not in Phase 3, on purpose:** a database trigger enforcing the transition
graph. The transition table belongs beside the Phase 4 definer RPCs that will
own all privileged status writes; adding it now would split one control across
two phases.

## 9. Password reset flow

1. `POST /api/v1/auth/password-recovery { email }` → **always `202`**, same
   shape and same latency path whether or not the address exists
   (non-disclosure, consistent with ADR-0025's error philosophy). Server:
   `resetPasswordForEmail(email, { redirectTo: ${APP_URL}/auth/confirm?type=recovery&next=/auth/reset-password })`.
   Recovery mail is **not** sent to non-`ACTIVE` accounts — an `INVITED`
   account has nothing to recover (its link is still in flight) and a
   `SUSPENDED`/`DEACTIVATED` account must not regain a session by proving
   mailbox control; the response stays `202`.
2. `GET /auth/confirm?type=recovery&token_hash=…` → `verifyOtp({ type:
'recovery', token_hash })` through the user client; session cookies set on
   the redirect to `/auth/reset-password`. (GoTrue recovery links sign the
   user in; that native behaviour is kept — mailbox control is the
   credential here.)
3. `POST /api/v1/auth/password { password }` (`'required'` session) →
   `updateUser({ password })`; then `signOut({ scope: 'others' })` so other
   devices are evicted while the current flow survives; audit `UPDATE` on the
   profile with `changed_fields: ['password']` (timestamp only — never the
   value); respond `204`.
4. `/auth/reset-password` applies the password policy client-side for UX only;
   the binding policy is GoTrue's minimum-length (and leak-list, where the
   plan supports it) set in Auth configuration (§H).

First-password-set after invitation acceptance uses the same endpoint (§2.2)
minus the `signOut others`.

## 10. Email verification flow

- **Sign-up does not exist**, so there is no signup-verification flow.
  Verification happens **through the invitation**: the invite link both proves
  control of the mailbox (GoTrue `email_confirmed_at`) and activates the
  account. This is the "email verification where appropriate" answer: for an
  invite-only B2B portal, invite acceptance _is_ email verification; a second
  verification email would be noise.
- **Email is immutable from the application.** It is the tenancy and audit
  anchor (`profiles.email` ↔ `auth.users.email`); a user-initiated change
  without a verified-change flow would desync them. Changes are
  admin-mediated: a future endpoint re-issues a GoTrue email-change
  confirmation (`type=email` — the `/auth/confirm` route already handles the
  general token exchange) in a later phase; until then, the only supported
  paths are re-invite (pre-acceptance) or support-mediated change with both
  stores updated by service-role in one operation.
- Recovery emails (§9) implicitly re-prove mailbox control; they do not alter
  the verified address.

## 11. Supabase Auth ↔ application user/profile relationship

```
        ┌───────────────────────┐   1:1, PK = PK    ┌────────────────────────┐
        │ auth.users (vendor)   │◄─────────────────▶│ public.profiles        │
        │  id, email,           │  profiles.id =    │  email, full_name,     │
        │  email_confirmed_at,  │  auth.users.id    │  user_type,            │
        │  invited_at, banned…  │  ON DELETE CASCADE│  account_status,       │
        └──────────┬────────────┘  (Phase 2)        │  last_seen_at,         │
                   │ created →                      │  mfa_enrolled_at …     │
                   ▼ trigger on_auth_user_created  └───────┬────────────────┘
             guarantees the profile row exists             │ 1:N
                                            ┌──────────────┴───────────────┐
                                            ▼                              ▼
                              organization_memberships           platform_role_grants
                              (org × role × membership_status)   (append-and-revoke)
                                            │                              │
                                            ▼                              ▼
                                     organizations (tenant)        audit_events (actor_user_id, no FK)

  invitations ── accepted_user_id ──▶ profiles      (token_hash only; raw token lives in the email)
```

Rules that make the two stores one identity:

1. **`profiles.id = auth.users.id`**, `ON DELETE CASCADE`, and the
   `on_auth_user_created` trigger guarantee the profile exists for every auth
   user created by _any_ path (Phase 2). Authentication code never inserts
   profiles.
2. **Claims policy (ADR-0011).** GoTrue `app_metadata` is written only by the
   service role and carries exactly one application value: `user_type`
   (`INTERNAL`/`CLIENT`), set at invite time as a **non-authoritative routing
   hint**. No role, status, organization or permission ever enters the token.
   `user_metadata` is user-writable and is used only for the profile-name
   fallback in the creation trigger — never for authorization (Phase 1 rule,
   unchanged).
3. **Status and roles live in PostgreSQL** and are resolved per request via
   `growlith.auth_context()` (§5). Revoking a role or suspending an account
   therefore takes effect at the _next resolution_ with no token rewrite.
4. **Field ownership.** GoTrue owns credential facts (email, confirmation,
   ban, factors); `profiles` owns display and lifecycle facts (name, timezone,
   `account_status`, `last_seen_at`, `mfa_enrolled_at` mirroring enrollment).
   The email equality invariant is maintained by the operations that may
   change email (§10) — while email changes are admin-mediated there is no
   silent-desync path; the invariant gets a trigger only when a self-service
   email change ships.
5. **MFA factors** are enrolled through server routes (§6c) against the user's
   own session; `profiles.mfa_enrolled_at` is stamped by the same operation.
   Staff unenrollment requires a fresh `aal2` session and is audited.

## 12. Failure handling

| Failure                                                            | Detected by                        | Behaviour                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expired access token, valid refresh                                | middleware / `withRoute` auth step | Transparent refresh; cookies rewritten; request proceeds. No user-visible event.                                                                                                                                                                                                         |
| Replayed/revoked refresh token (rotation family invalidated)       | `getUser()` failure                | **Not an outage**: middleware strips session cookies, redirects `/login?reason=session_expired`; API returns 401 `UNAUTHENTICATED`.                                                                                                                                                      |
| Wrong credentials                                                  | GoTrue error                       | Uniform `401 INVALID_CREDENTIALS` — identical for unknown email and wrong password; `LOGIN_FAILED` audited with a coarse reason.                                                                                                                                                         |
| Account status gate                                                | `requireAuthContext()`             | 403/423/401 per §8; session revoked where the status says so.                                                                                                                                                                                                                            |
| Supabase (Auth or PostgREST) unreachable                           | middleware / handler               | Protected pages: 503 with `Retry-After` (fail-closed). API: 503 `SERVICE_UNAVAILABLE` envelope. Public pages unaffected. Never fail-open.                                                                                                                                                |
| Environment incomplete at boot                                     | `reportEnvStatus()` (existing)     | Production crashes at boot (ADR-0023); auth routes then cannot half-work.                                                                                                                                                                                                                |
| Email link: expired invitation                                     | `accept_invitation`                | Invitation flipped `EXPIRED`; redirect `/link-invalid?reason=expired`. Unknown token or wrong email → same neutral `/link-invalid` (no which-case disclosure). Revoked → `/link-invalid?reason=revoked`. Already-accepted → `/login?notice=already_accepted` (idempotent, not an error). |
| Recovery link invalid/expired                                      | `verifyOtp`                        | `/link-invalid?reason=recovery`; the user simply requests a new email.                                                                                                                                                                                                                   |
| Audit write fails on a non-security-critical event (login, logout) | catch                              | Outcome stands; failure logged with the `requestId`. Audit **is** the control only for acceptance and status change — there it is transactional (definer RPC) and its failure aborts the operation.                                                                                      |
| GoTrue rate limit on login/recovery                                | GoTrue error                       | `429 TOO_MANY_REQUESTS` envelope; `LOGIN_FAILED{rate_limited}`. App-level rate limiting remains Phase 6.                                                                                                                                                                                 |
| MFA challenge failures                                             | GoTrue error                       | `401 INVALID_CREDENTIALS`-family response with retry (GoTrue enforces factor attempt limits); repeated failures re-audit `LOGIN_FAILED`.                                                                                                                                                 |
| Clock-skewed token (`nbf` in future)                               | `getUser()`                        | Treat as unauthenticated (GoTrue leeway applies); user re-authenticates.                                                                                                                                                                                                                 |

Two standing rules carry over unchanged: `toApiError()` downgrades unknown
throwables to a generic 500 with the cause logged, never serialized
(ADR-0025); and log redaction (`redaction.ts`) already strips tokens,
cookies, passwords and masks emails, so no new redaction code is needed —
only the discipline of not logging raw URLs that contain `token_hash` or `it`.

## 13. Session security

The consolidated control list (each item maps to a section above):

1. `HttpOnly` + `Secure` (prod) + `SameSite=Lax` + host-scoped session cookies; browser JS never reads a token (ADR-0026).
2. PKCE-style **server-side token exchange**: email links carry `token_hash` and are consumed by a server route; no token ever lands in a URL fragment or in JS (§1).
3. Refresh-token rotation with reuse detection; replay invalidates the family (§4).
4. Global logout; `signOut others` on password change; revocation + GoTrue ban on suspension/deactivation (§4, §8, §14).
5. No authorization data in JWTs — nothing in a stolen token elevates anyone (ADR-0011).
6. `getUser()` network verification everywhere a decision is made; `getSession()` banned by architecture test (§5).
7. `app_metadata.user_type` is a hint; `user_metadata` is never trusted; all authority is a database lookup (§11).
8. MFA: TOTP mandatory for `SUPER_ADMIN`/`ADMIN` (enrollment forced on first admin entry; `aal2` required for `/admin` surfaces), optional for `CLIENT_ADMIN`; sensitive factor changes need `aal2` (§6c).
9. CSRF posture: `SameSite=Lax` + the API is same-origin (no CORS, ADR-0014) + JSON-only POST bodies + mutations are POST/PUT/PATCH/DELETE through `withRoute`. A dedicated origin-check/CSRF-token layer, if still wanted after this posture is live, is Phase 6 — recorded, not silently dropped.
10. Enumeration resistance: uniform login failure, uniform 202 recovery, neutral link-invalid states (§3, §9, §12).
11. Invitation tokens: 32 bytes of CSPRNG, SHA-256-at-rest, single-purpose, expiring, and revocable; the hash column already has a unique index and a shape CHECK (§2).
12. Tokens and secrets never logged; URL redaction for link callbacks; `x-application-name` already tags service-role traffic; every service-role call site carries its justification comment and is enumerated in the architecture test (§5, §2, §8).
13. Password policy set at the auth server (minimum length 12; leaked-password protection where available) — never in application code (§H).
14. Middleware stays secret-free (no service client) and non-authoritative, so its compromise or outage degrades UX, not security (§7).

## 6c. MFA flows (step-up detail for §3)

- **Enrollment** (mandatory for internal roles, first entry to `/admin`):
  `POST /api/v1/auth/mfa/enroll` → `mfa.enroll({ factorType: 'TOTP' })`
  returns the secret/QR payload (displayed by the Phase 9 UI; no UI in this
  phase); `POST /api/v1/auth/mfa/verify` completes
  `challenge` + `verify`, stamps `profiles.mfa_enrolled_at`, audits.
  `SUPER_ADMIN`/`ADMIN` with zero factors and `aal1` are redirected to
  enrollment by the admin layout guard — enrollment, not denial, because the
  alternative locks staff out before they can act.
- **Challenge** (every login with factors enrolled): login returns
  `mfaRequired`; the client posts the code to `POST /api/v1/auth/mfa/challenge`
  (`'required'` session at `aal1`); `mfa.challenge` + `mfa.verify` upgrade the
  session to `aal2`; response returns the landing path.
- **Enforcement**: `requireAuthContext({ minAal: 2 })` is used by the admin
  layout guard and by the future privileged routes; the `aal` value comes from
  the _verified_ session (post-`getUser()`), not from a client assertion.
- Client-portal MFA stays optional and invisible to the platform (per-user
  factors); nothing portal-side checks `aal2`.

## 14. Logout behavior

- `POST /api/v1/auth/logout` (`'required'`, but effectively idempotent):
  `signOut({ scope: 'global' })` — **all** the user's refresh tokens, on every
  device, are revoked; the handler then deletes every `sb-…` cookie (including
  chunks) by setting empties with immediate expiry; responds `204` even if
  GoTrue reports nothing to revoke (idempotency beats error-loop fidelity);
  audits `LOGOUT` best-effort.
- Passive logout: an expired-and-unrefreshable session is cleared by the
  middleware path (§12) — the browser experiences the same "returned to
  /login" outcome without an explicit call.
- Forced logout: suspension, deactivation and password-change evictions (§4,
  §8, §9). Forced logout is invisible until the next request; there is no
  push channel by design (§6).
- The access token of the logging-out device remains valid until expiry
  (§4 residual risk); the cookie is destroyed so the browser cannot use it.

## 15. Route protection foundation

Three concentric layers, all present from Phase 3 even though the dashboard
UI is Phase 9:

```
Layer 0  middleware.ts        refresh + coarse gate (/admin, /portal vs /login)   — UX, not security
Layer 1  withRoute auth step  authoritative for /api/v1/**                        — required, per route
Layer 2  RSC layout guards    authoritative for pages, via requireAuthContext()   — required, per route group
Layer 3  PostgreSQL RLS       authoritative for rows (Phase 4 policies; predicates exist today)
```

**Route taxonomy** (the public set is a constant in `src/lib/auth/routes.ts`,
tested):

| Surface                                                                                 | Class                | Guard                                                                |
| --------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------- |
| `/api/v1/health`                                                                        | public               | none (probe reveals nothing)                                         |
| `/api/v1/auth/login`, `/logout`, `/session`, `/password-recovery`                       | public               | rate limits (GoTrue now, Phase 6 app-level)                          |
| `/api/v1/auth/password`, `/auth/mfa/**`, `/api/v1/invitations/**`                       | required             | `requireAuthContext()`; capabilities Phase 4                         |
| every future `/api/v1/**` business route                                                | required by default  | `auth: 'required'` is the compile-time default posture               |
| `/login`, `/forgot-password`, `/reset-password`, `/link-invalid`, `/account-restricted` | public pages         | redirect authenticated users onward                                  |
| `/auth/confirm`                                                                         | public route handler | self-guarding (token exchange)                                       |
| `/admin/**`                                                                             | protected            | layout guard: session + `userType = INTERNAL` + `aal2`               |
| `/portal/**`                                                                            | protected            | layout guard: session + `userType = CLIENT` + an `ACTIVE` membership |

Phase 3 delivers the **guard modules** (`requireAdminContext()`,
`requirePortalContext()` — thin, typed wrappers over `requireAuthContext`
that throw the right `ApiError` or perform the right redirect) and the route
constants; the layouts that call them and every page arrive with Phase 9.
Until then the guards exist and are unit-tested, so Phase 9 cannot render a
protected page without an authority check that already works.

---

# Part II — Consolidated deliverables

## A. Authentication architecture

One identity provider (Supabase Auth), one verification function
(`requireAuthContext()`), one claims policy (none that authorize), three
cookie writers, four enforcement points (middleware — coarse; `withRoute` —
API authority; layout guards — page authority; RLS — row authority).
Authentication code lives in `src/server/auth/` (secret-bearing:
`context.ts`, `session-refresh.ts`, `routes-login.ts`/`routes-password.ts`/
`routes-mfa.ts`, `invitations.ts`, `accounts.ts`, `audit.ts`) with the
isomorphic vocabulary — statuses, transitions, route constants, the
`AuthContext` DTO type — in `src/lib/auth/`. No new runtime dependency:
everything is `@supabase/ssr` + `@supabase/supabase-js`, already pinned
(ADR-0022).

## B. Session architecture

GoTrue session = access JWT (3600 s) + rotating refresh token, serialized by
`@supabase/ssr` into chunked `HttpOnly`/`Secure`/`SameSite=Lax` cookies.
Refresh happens in middleware for pages and in handlers for API; rotation with
reuse detection provides theft detection; revocation is global by default and
paired with GoTrue bans for status changes. No idle/absolute timeout exists in
the platform — short TTLs and Phase 6 revisit are the recorded answer
(§4). The browser holds no client and no token (ADR-0026).

## C. User lifecycle

```
 nonexistent ──invite──▶ INVITED ──accept (verify email + RPC)──▶ ACTIVE
 ACTIVE ⇄ SUSPENDED (suspend / reinstate)      ACTIVE → DEACTIVATED (offboard)
 DEACTIVATED → ACTIVE (SUPER_ADMIN-only reactivate, CRITICAL)
 erasure: hard-delete auth user → CASCADE profile (audit rows survive; no FK by design)
```

Birth is invitation-only; the GoTrue identity and the `profiles` row are born
together via the Phase 2 trigger; acceptance is the single activation event;
deactivation is the offboarding event that revokes grants, deactivates
memberships, bans the identity and kills sessions, while deliberately keeping
the named profile for audit; erasure is a separate, later, privileged path
(§2, §8, §11).

## D. Invitation lifecycle

`PENDING → ACCEPTED | REVOKED`, lazily `PENDING → EXPIRED`. Creation mints an
app token (raw only in the email), invites via service role, writes the
ledger row (and the `INVITED` membership for the client branch), audits.
Acceptance is one definer RPC that flips invitation, activates profile and
membership (client) or writes the role grant (staff), and audits — atomically.
Resend rotates the token hash on the same row; revoke is a status flip that
the RPC honours. The raw token never touches the database (§2).

## E. Account-status behavior

Per §8's matrix and transition graph: statuses gate login, every request, and
— via the existing `is_active_account()` predicate — every future RLS policy;
membership status gates tenant surfaces independently of account status;
suspension/deactivation revoke sessions and ban the identity; reinstatement
never resurrects sessions.

## F. Middleware strategy

Root `middleware.ts`; three responsibilities (refresh, coarse gate, landing
hint); matcher excludes `/api/**` and static assets; fail-closed-with-503 on
outage for protected prefixes; `next`-parameter open-redirect guard; imports
restricted to public env + `session-refresh.ts`, asserted by architecture
test. It is never consulted as evidence of anything (§7).

## G. Security considerations

§13 is the list. The four that carry the design: browser cannot touch a token
(ADR-0026); the database is the only authority on roles and status
(ADR-0011), so tokens are worthless as credentials-for-authorization; every
decision re-verifies with `getUser()`; and defence in depth means each of
middleware, handlers, guards and RLS would still hold if any other failed.

## H. Required environment variables

**No new application environment variables.** The auth phase is served
entirely by the existing contract, deliberately — ADR-0023 forbids
speculative variables, and the dangling Phase 1 mention of a
`SUPABASE_AUTH_SITE_URL` is hereby **closed**: the canonical origin is
already `NEXT_PUBLIC_APP_URL` (single declaration of one fact), Supabase's
"Site URL" is _Supabase project configuration_, not application env, and the
two must be kept equal as an operational invariant (runbook item, checked at
deployment, not by code).

| Variable                        | Existing contract           | Role in authentication                                                       |
| ------------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | `src/lib/env/client-env.ts` | Auth endpoint for every client                                               |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `src/lib/env/client-env.ts` | Bearer of user-JWT sessions (server clients only)                            |
| `NEXT_PUBLIC_APP_URL`           | `src/lib/env/client-env.ts` | Builds `redirectTo` targets; must equal Supabase Site URL origin             |
| `SUPABASE_SERVICE_ROLE_KEY`     | `src/server/env.ts`         | Invite, admin lookup, session revocation, ban — confined call sites (§2, §8) |
| `APP_ENV`                       | `src/server/env.ts`         | Cookie `Secure` flag gates on `production`                                   |
| `LOG_LEVEL`                     | `src/server/env.ts`         | Auth-flow log verbosity                                                      |

**Supabase Auth project configuration** (hosted dashboard + `supabase/config.toml`
for local, which Phase 3 adds — `supabase/README.md` already reserves it):
new sign-ups **disabled**; email confirmations enabled; custom SMTP in
staging/production; JWT expiry 3600 s; refresh-token rotation on (reuse
interval 10 s); TOTP MFA enabled; minimum password length 12 (leaked-password
protection where the plan allows); redirect allow-list containing exactly the
deployed origins; mail-OTP expiry 7 days for invites / 1 hour for recovery
(**verify-at-implementation** against the pinned GoTrue); invite and recovery
email templates rewritten to the `{{ .SiteURL }}/auth/confirm?token_hash={{
.TokenHash }}&type=…` confirm-route pattern.

## I. Required database relationships

**Existing (Phase 2) — consumed, not changed:**

| Relationship                                                                | Cardinality                         | Notes                                                                               |
| --------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| `auth.users` ↔ `profiles`                                                   | 1:1, shared PK, `ON DELETE CASCADE` | `on_auth_user_created` trigger guarantees existence                                 |
| `profiles` → `organization_memberships` → `organizations`                   | 1:N:N                               | the only cross-tenant edge; `enforce_membership_user_type` keeps internal staff out |
| `profiles` → `platform_role_grants`                                         | 1:N                                 | append-and-revoke; never deleted                                                    |
| `profiles` → `staff_team_memberships`                                       | 1:N                                 | staff team scoping (Phase 4 use)                                                    |
| `invitations` → `organizations`, `profiles (invited_by / accepted_user_id)` | N:1                                 | token-hash ledger                                                                   |
| `audit_events.actor_user_id` → _(no FK, by design)_                         | —                                   | evidence must outlive its subject                                                   |

**Added by Phase 3 implementation (design now, code later):**

1. `entity_kind` gains `'profile'` (additive `ALTER TYPE … ADD VALUE` in its
   own migration — the new value is used by runtime writes, not by the same
   transaction; mirrored in `ENTITY_KINDS` + the schema parity test), so
   auth events have an audit subject.
2. `audit_action` gains `LOGOUT`, `PASSWORD_RESET_REQUESTED`, `MFA_ENROLLED`,
   `MFA_REMOVED`, `SESSIONS_REVOKED` (additive; `LOGIN`, `LOGIN_FAILED`,
   `INVITE_SENT`, `INVITE_ACCEPTED`, `ROLE_GRANT`, `STATUS_CHANGE` exist).
3. `SECURITY DEFINER` functions, Phase 2 conventions (pinned `search_path`,
   `STABLE` where read): `growlith.auth_context()` (§5),
   `growlith.accept_invitation(p_raw_token text)` (§2.2),
   `growlith.touch_last_seen()` (§5.6).
4. **No new tables. No new columns. No FK changes.** The Phase 2 schema
   anticipated this phase almost exactly — which is the point of having done
   it first.

## J. Implementation sequence

Each step leaves `npm run validate` and `npm run db:check` green. Order is
dependency order; steps 4–8 can interleave once 1–3 land.

| #   | Step                        | Includes                                                                                                                                                                                       | Proof it is done                                                                          |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 0   | Supabase Auth configuration | `supabase/config.toml`; hosted checklist from §H; runbook section                                                                                                                              | `supabase start` boots with sign-ups disabled; templates render the confirm-route pattern |
| 1   | Isomorphic vocabulary       | `src/lib/auth/`: account-status transitions (data), route constants, `AuthContext` DTO type, new `ErrorCode`s (`INVALID_CREDENTIALS`, `ACCOUNT_PENDING`, `MFA_REQUIRED`, `INVITATION_INVALID`) | Unit tests on transitions + codes; env-parity untouched                                   |
| 2   | Database functions          | Migration: enum additions (§I) + the three definer functions; `npm run db:types`; `db-verify` assertions (definer functions pin `search_path`; RLS still forced)                               | `npm run db:check` green; parity tests updated                                            |
| 3   | Session core                | `requireAuthContext()` + `withRoute` `auth` field + `ApiError.accountSuspended` wiring (exists)                                                                                                | Contract tests: 401/403/423 matrix; every route declares `auth`                           |
| 4   | Middleware                  | `middleware.ts`, matcher, `session-refresh.ts`, failure semantics                                                                                                                              | Architecture tests: no service client in middleware graph; protected prefixes covered     |
| 5   | Auth API                    | login, logout, session, password, password-recovery, MFA routes                                                                                                                                | Contract tests per route; redaction spot-checks                                           |
| 6   | Confirm callback            | `/auth/confirm` for invite/recovery exchange; `/link-invalid` states                                                                                                                           | Unit tests on state mapping; no token logged                                              |
| 7   | Invitations                 | create/resend/revoke routes + `accept_invitation` integration                                                                                                                                  | Contract tests: branches, conflicts, expiry, revoke                                       |
| 8   | Account statuses            | suspend/reinstate/deactivate/reactivate service + revocation hooks + audits                                                                                                                    | Unit tests: transition matrix; audit assertions                                           |
| 9   | Route protection foundation | guard modules for `/admin` + `/portal`, landing logic, redirect rules                                                                                                                          | Guard unit tests; taxonomy test asserts the public set                                    |
| 10  | Audit + presence wiring     | audit module (`service-role`, justified call sites), `after()` last-seen touch                                                                                                                 | Log assertions; audit rows in `db:verify` fixtures                                        |
| 11  | Docs + ADR close-out        | runbook updates; ADR-0011/0026 consequences finalized with evidence; register statuses                                                                                                         | Review; `npm run validate` full gate                                                      |

**Deliberately out of Phase 3:** authorization capabilities and RLS policies
(Phase 4), dashboard UI (Phase 9), rate limiting/CSP/HSTS/CSRF tokens (Phase
6), seed data (Phase 7), E2E (Phase 8), self-service email change (needs its
own flow, §10), app-level session timeouts (Phase 6 candidate, §4).

---

_Conformance: this design implements the Phase 1 authentication boundary
(`docs/architecture/README.md` §E) without weakening any of its rows, and
adds two decisions the boundary left open — ADR-0011 (claims) and ADR-0026
(browser client) — both authored in `docs/architecture/adr/`._
