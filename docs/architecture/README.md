# Growlith Engine — Architecture

**Status:** Phase 1 (Architecture) implemented and validated.
**Owner:** platform engineering. **Change control:** every significant change
requires an [ADR](adr/README.md).

This document is the canonical description of the system's architecture. It
records what the repository was, what it is now, and the boundaries that later
phases must respect. Phase-by-phase detail lives in the ADR register; the domain
model lives in [domain-model.md](domain-model.md).

---

## A. Starting point

Phase 1 began from a repository containing exactly one commit and one file
(`README.md`, 99 bytes). There was no framework, no package manager, no
TypeScript configuration, no database schema, no migrations, no RLS, no API, no
middleware, no authentication, no authorization, no tests, no linting, no CI, no
storage configuration, no UI and no dependencies. Nothing was ever deleted from
history and no dangling objects existed.

Two consequences follow, and both shaped the work:

1. **There was no existing architecture to preserve.** The brief's instruction to
   treat the repository as the source of truth could not be satisfied by
   inspection, so the irreversible decisions were surfaced for owner approval
   rather than invented (Rule 4, Rule 25).
2. **There was no backward-compatibility baseline.** Rule 5 had nothing to
   protect. The compatibility contract is therefore _established_ by this phase:
   after Phase 5, `/api/v1` and the database schema become the contract, and
   breaking either requires a version bump.

The one piece of domain evidence available was the public site,
[growlithacademy.com](https://growlithacademy.com): a B2B growth-engineering firm
operating across NYC, LDN, SYD and the Dubai DIFC, whose seven published service
lines map almost one-to-one onto the seven internal delivery teams. That
correspondence is a domain invariant and is encoded in
`src/lib/domain/service-lines.ts`.

## B. Target architecture

A **single modular monolith**: one Next.js application (App Router, Node.js
runtime) serving the admin dashboard, the client portal, and a versioned
server-side API, with Supabase — PostgreSQL, Auth and Storage — as the only
backend service. No microservices, no GraphQL, no ORM, no message broker
(Rules 15–17).

```
                            ┌────────────────────────────────────────────┐
                            │        ONE Next.js 16 app (Node runtime)   │
   Browser ── HTTPS ──────▶ │                                            │
                            │  middleware.ts    (routing gate ONLY)      │
   Admin user  ─ /admin/*   │      │                                     │
   Client user ─ /portal/*  │      ▼                                     │
                            │  RSC pages ──▶ server/services ──┐         │
                            │  /api/v1/* ──▶ withRoute() ──────┤         │
                            │      authn → validate → authorize│         │
                            └──────────────────────────────────┼────────┘
                                                               │ anon key +
                                                               │ USER JWT propagated
                                                               ▼
                    ┌───────────────────────────────────────────────────────┐
                    │                     S U P A B A S E                   │
                    │  Auth (cookie/PKCE sessions, invites, MFA)            │
                    │  PostgREST ──▶ PostgreSQL                             │
                    │                 ├─ RLS  ◀── LAST LINE OF DEFENCE      │
                    │                 ├─ composite FKs / CHECKs / triggers  │
                    │                 ├─ column-level GRANTs                │
                    │                 └─ SECURITY DEFINER RPCs + audit      │
                    │  Storage ──▶ private bucket, org-prefixed paths, RLS  │
                    │  Realtime ──▶ RLS-filtered channels (read-only)       │
                    └───────────────────────────────────────────────────────┘
                       ▲
                       │ service_role (BYPASSRLS) — SERVER-ONLY MODULES ONLY
                       └── invites, cross-tenant admin, object verification
```

Four ideas carry the design:

1. **Two directories, one hard wall.** `src/lib/` is isomorphic and provably
   secret-free; `src/server/` is secret-bearing and unreachable from a client
   graph. See [ADR-0002](adr/ADR-0002-client-server-boundary-wall.md).
2. **Authorization is enforced twice, by different mechanisms.** The API layer
   enforces _capabilities_; PostgreSQL RLS enforces _row visibility_,
   independently of application code. Forgetting one still leaves the other.
3. **`organization_id` is denormalized onto every tenant row and made
   tamper-proof by composite foreign keys**, so RLS can check tenancy with one
   indexed column and no joins.
4. **The permission matrix and the state machine are data, not prose** — read by
   the guard, the UI and the tests from one definition, so they cannot drift.

## C. Directory structure

```
app/                      routing + HTTP surface only. No business logic.
  (auth)/  (admin)/  (portal)/     ← route groups, created in Phase 3/9
  api/v1/                          ← every route built with withRoute
components/               UI (Phase 9). May import @/lib only.
src/
  lib/                    ISOMORPHIC. No secrets, no database access, no
                          browser-only APIs. Safe to import from either side.
    domain/               roles, teams, service lines, entity hierarchy
    env/client-env.ts     the only isomorphic module allowed to read process.env
    errors/               error types shared across the wall
    pagination/           cursor codec + page-size policy
    types/                api envelope, error codes, pagination, http
    utils/                request id
    validation/           shared Zod primitives + issue formatting
  server/                 SERVER-ONLY. Every module begins `import 'server-only'`.
    api/                  withRoute, ApiError
    env.ts                validated server environment contract
    logging/              structured logger + redaction
    supabase/             request-scoped client, service-role client (no barrel)
  types/database.ts       GENERATED from the schema. Never hand-edited.
supabase/                 migrations, config, seed, pgTAP tests (Phase 2)
tests/
  unit/  contract/  architecture/  helpers/  stubs/
docs/architecture/        this document + ADRs + domain model
scripts/                  Node build/CI tooling
```

`src/lib` and `src/server` are the architecture rendered as a filesystem. The
alias configuration in `tsconfig.json` is what makes the wall expressible in an
import statement.

## D. Request and data flow

Representative privileged write (Phase 5 shape; steps 4 and 6 arrive in
Phases 3 and 4):

```
 Browser ── POST /api/v1/deliverables/{id}/tasks ──▶ (HttpOnly cookie, no token in JS)
 [1] middleware.ts        session refresh + COARSE ROUTING GATE ONLY. Not a security boundary.
 [2] route.ts             runtime='nodejs', dynamic='force-dynamic', delegates to withRoute
 [3] withRoute            requestId → method check
 [4] authentication       supabase.auth.getUser() — verified with Supabase, never decoded locally
 [5] validation           Zod .strict() — unknown keys REJECTED, so mass assignment is impossible
 [6] authorization        requireCapability(actor, 'task:create')   ← Phase 4
 [7] service              loads the parent THROUGH THE USER-JWT CLIENT, so RLS applies;
                          derives organization_id FROM THE PARENT ROW, never from the request;
                          validates the state machine; writes audit; emits notifications
 [8] PostgreSQL           RLS evaluated against auth.jwt() — a second, independent authorization;
                          composite FK proves tenant consistency; triggers and CHECKs hold the rest
 [9] serialization        explicit DTO mapper — never a raw row, never a spread of the request
 [10] 201 {data, meta:{requestId, tookMs}} + x-request-id, logged with the same requestId
```

The invariant that eliminates an entire bug class: **`organization_id` is derived
server-side from the parent row and never accepted from the request body.**

A resource hidden by RLS yields a **404, not a 403** — a 403 would confirm that
the resource exists in another tenant (ADR-0019).

## E. Authentication boundary _(Phase 3 — designed, not implemented)_

|             |                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider    | Supabase Auth, cookie-based sessions via `@supabase/ssr` (PKCE). No custom JWT issuance, no session table, no password hashing in application code                |
| Inside      | Server components, route handlers, middleware — anything holding the request's cookies                                                                            |
| Outside     | Browser JS never holds a raw access token: it lives in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie                                                             |
| Enforcement | `supabase.auth.getUser()`, which verifies the JWT with Supabase. **Never** `getSession()` for an authorization decision — it decodes locally without verification |
| Middleware  | Token refresh and routing only. Explicitly **not** a security boundary (Rule 8); every authoritative check is repeated where data is read                         |
| Signup      | **Disabled.** A B2B portal where every account originates from a server-side invitation                                                                           |
| Invitations | Service-role `inviteUserByEmail`; the membership row is written explicitly by the invite endpoint so role assignment stays an audited server decision             |
| Step-up     | Email verification required; TOTP MFA mandatory for `SUPER_ADMIN` and `ADMIN`                                                                                     |
| Not trusted | Any role or permission asserted by the client. `user_metadata` is user-writable and is **never** used for authorization                                           |

**Phase 1 delivers only the parts that are architectural:** the cookie-capable
server client factory (`src/server/supabase/client-server.ts`), the confined
service-role client (`src/server/supabase/client-service.ts`), and the
request-scoped JWT-propagation pattern those factories establish. No session
resolution, no login, no guards.

**Deliberately deferred: the browser client factory.** `createBrowserClient`
reads and writes `document.cookie`, so it is _browser-only_ — it does not belong
in `src/lib`, whose contract is "isomorphic: safe to import from either side of
the wall". Shipping it in Phase 1 would have meant either weakening that
contract for a module with no consumer, or placing it in a tier that does not
yet exist. Phase 3 (Auth) introduces the first real consumer and decides the
placement with it, choosing between:

| Option                                                                     | When it is right                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/lib/supabase/` + an explicit browser-only exception, enforced by test | If browser components across several route groups need it                |
| A dedicated `src/client/` tier                                             | If more than one browser-only module appears (likely once Phase 9 lands) |
| Colocated with its route group                                             | If only one feature area ever needs it                                   |

**Resolved in the Phase 3 design — none of the three.** The deciding fact
arrived and it pointed the other way: any browser client stores session
cookies JavaScript must be able to read, which breaks the "no token in JS"
invariant above. [ADR-0026](adr/ADR-0026-server-only-session-cookies.md)
records the decision: no browser Supabase client exists; session cookies are
written only by `middleware.ts`, the `/api/v1/auth/**` handlers and the
`/auth/confirm` callback, all server-side.

The full Phase 3 authentication design — flows, session lifecycle, middleware
strategy, account statuses, failure handling, implementation sequence — is
[authentication.md](authentication.md), with [ADR-0011](adr/ADR-0011-authorization-data-lives-in-postgres-not-jwt-claims.md)
settling the claims question (no authorization data in JWTs).

## F. Authorization boundary _(Phase 4 — designed, not implemented)_

Two layers, both mandatory:

**Layer 1 — application capability check.** A single typed role → capability
matrix in `src/lib/domain/permissions.ts` (Phase 4), consumed identically by the
API guard, the RSC page guards, the UI and the tests. Enforced through
`withRoute`, which gains a required `capability` field; the contract test then
asserts every route declares one.

**Layer 2 — PostgreSQL RLS.** Evaluated inside the database on every statement,
regardless of which code path issued it. Implemented with `SECURITY DEFINER`
helper functions that have a **pinned `search_path`** and are declared `STABLE`:

```sql
create or replace function app.current_org_role(p_org uuid)
returns public.org_role language sql stable security definer
set search_path = app, public, pg_temp
as $$ select role from public.organization_members
     where organization_id = p_org and profile_id = auth.uid() and status = 'active' $$;
```

`SECURITY DEFINER` is not a convenience here — it is what prevents the infinite
policy recursion that occurs when a policy on a table queries that same table.
Pinning `search_path` prevents a search-path hijack, and `STABLE` makes the
lookup evaluate once per statement instead of once per row.

Supporting database controls: column-level `GRANT`s (so a client cannot edit
`status` or contract fields even under a permissive policy), `SECURITY DEFINER`
RPCs for sensitive client mutations (role check + state validation + audit in one
transaction), and triggers that derive `organization_id` from the parent row.

> ⚠️ **Open decision — risk R-1.** The four specified roles cannot express
> "internal staff scoped to their own team and assigned engagements", so every
> specialist across seven teams would need cross-tenant `ADMIN`. A fifth role
> (`TEAM_MEMBER`) is recommended. `src/lib/domain/roles.ts` documents the gap
> explicitly on `ROLES`, and `tests/unit/domain.spec.ts` turns it into a tripwire:
> adding a fifth role fails the suite until risk R-1 below is closed in the same
> change. Recorded and enforced, not resolved unilaterally.

## G. Database boundary _(Phase 2 — designed, not implemented)_

PostgreSQL is the single source of truth and the final enforcement point.

```
organizations  (TENANT ROOT — every tenant-scoped row carries organization_id)
   ├── organization_members ── profiles ── auth.users     [CLIENT_ADMIN | CLIENT_MEMBER]
   ├── engagements                                        (retainer | project | advisory)
   │      └── services ──▶ service_lines ──▶ internal_teams ── staff_team_memberships
   │             └── projects                              (delivery container, lead + team)
   │                    ├── deliverables                   (review/approval workflow)
   │                    │      ├── tasks                   (deliverable_id NULLABLE — ADR-0005)
   │                    │      ├── attachments ──▶ storage.objects
   │                    │      └── comments
   │                    ├── tasks
   │                    └── comments
   ├── metrics            (time-series KPIs)
   ├── notifications
   └── audit_events       (append-only)
```

Invariants are enforced **in the database**, because a guarantee held only in
application code is a guarantee held nowhere:

| Invariant                                         | Mechanism                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A child row always belongs to its parent's tenant | Composite FK `tasks (project_id, organization_id) → projects (id, organization_id)`                                      |
| `organization_id` cannot be spoofed on insert     | `BEFORE INSERT` trigger deriving it from the parent                                                                      |
| Money is never a float                            | `numeric(14,2)` + a `currency` column with a CHECK against an allowed list                                               |
| A comment attaches to exactly one subject         | `CHECK (num_nonnulls(project_id, deliverable_id, task_id) = 1)` — real FK integrity instead of a polymorphic `entity_id` |
| Status changes follow the state machine           | `status_transitions` reference table + validating trigger                                                                |
| Audit is immutable                                | `BEFORE UPDATE OR DELETE` trigger raises; insert-only                                                                    |

Connection topology: Supavisor **pooled** for application traffic, **direct**
only for CLI/CI migrations, and the **service-role** client confined to
server-only modules. `service_role` has `BYPASSRLS`, which is why its containment
is a four-control problem (ADR-0002) rather than a code-review convention.

## H. API boundary

`/api/v1/**` Route Handlers, Node.js runtime, `force-dynamic`. Implemented in
Phase 1: `withRoute`, `ApiError`, the envelope types, error codes, cursor
pagination, and the health probe.

| Aspect           | Decision                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Style            | Resource-oriented REST, nesting capped at two levels; deeper access via query filters                                                                                                                            |
| Versioning       | URL prefix. A breaking change creates `/v2`; `/v1` is never silently mutated                                                                                                                                     |
| Wrapper          | `withRoute` — requestId → method → validation → _(Phase 4: capability)_ → handler → envelope → headers → log                                                                                                     |
| Mutation path    | Route handlers only (ADR-0013)                                                                                                                                                                                   |
| Validation       | Zod, `.strict()`, shared with client forms (ADR-0017)                                                                                                                                                            |
| Pagination       | Keyset cursors, opaque and schema-validated on decode; `limit` clamped server-side (default 25, max 100)                                                                                                         |
| Success envelope | `{ data, meta: { requestId, tookMs } }`; lists add `pagination: { limit, nextCursor, hasMore }`                                                                                                                  |
| Error envelope   | `{ error: { code, message, details?, requestId? } }` — never a stack trace, SQL, row contents or upstream error text                                                                                             |
| Status mapping   | 400 malformed · 401 unauthenticated · 403 forbidden · **404 for RLS-hidden** · 405 + `Allow` · 409 conflict · 413 too large · 422 validation · 423 suspended · 429 rate limited · 500 internal · 503 unavailable |
| Body limit       | 1 MiB for JSON. Files never traverse the API — they use signed URLs (ADR-0016)                                                                                                                                   |
| 405              | **Framework-generated — see the open item below**                                                                                                                                                                |
| Caching          | `Cache-Control: no-store` set per response **and** at the edge in `next.config.ts`, so a handler that forgets still does not leak                                                                                |
| CORS             | None. Same-origin only (ADR-0014)                                                                                                                                                                                |
| No fake APIs     | Rule 14: `/api/v1/health` is operational infrastructure, not a stub. No other route exists until its migration, service and policies exist                                                                       |

### Open item discovered in Phase 1 — 405 responses are framework-generated

Verified against a running production build, not inferred: `POST` to
`/api/v1/health` (which exports only `GET`) returns `405 Method Not Allowed` with
an **empty body**, no `x-request-id`, and no `Allow` header. The request never
reaches `withRoute` and never appears in the server log — Next.js rejects methods
a route file does not export before invoking the handler.

Consequences:

- The `{ error: { code, … } }` envelope does **not** hold for 405. Clients of
  `/api/v1` must tolerate a body-less 405, so the typed API client (Phase 5)
  treats an unparseable error body as a first-class case rather than an exception.
- `withRoute`'s method check is _not_ the primary 405 mechanism. It catches a
  **declaration/export mismatch** — `export { GET }` built from
  `withRoute({ method: 'POST' })` — which would otherwise serve the wrong
  semantics on the wrong verb. Its documentation and its contract test both say so
  explicitly, because the alternative is a false belief that the application
  controls every 405.

Resolution is deferred to Phase 5, when routes exist to decide it against. The two
viable options are (a) export every supported method per route file so the
envelope is always ours, or (b) accept the framework behaviour and document it in
the API contract. Option (a) is preferred if envelope uniformity proves worth the
per-route boilerplate; deciding now, without real routes, would be guesswork.

## I. Storage boundary _(Phase 6 — designed, not implemented)_

| Aspect                | Decision                                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buckets               | One private bucket, `growlith-assets`. No public bucket                                                                                                                                   |
| Path convention 🔒    | `{organization_id}/{entity_type}/{entity_id}/{ulid}-{sanitized-filename}` — the organization id is **always the first segment**, so `(storage.foldername(name))[1]` _is_ the tenant check |
| Constraints           | `public = false`, bucket-level size limit, `allowed_mime_types` restricted to document/image/video/archive. Executables and `text/html` excluded                                          |
| `storage.objects` RLS | Internal staff → all prefixes; client members → own-org prefix and only objects whose parent entity is `client_visible`                                                                   |
| Upload                | Authorized route mints a signed upload URL → browser PUTs **directly to Storage** → client registers metadata → server verifies the object exists and marks it `ready`                    |
| Trade-off             | Bytes land in Storage before metadata validation runs. Mitigated by bucket limits, `status='pending'` until verified, and post-upload verification. Accepted, not hidden                  |
| Download              | Signed URL, 60 s TTL, authorization-checked and audit-logged. No permanent public URLs                                                                                                    |
| Deletion              | Soft delete, then purge by a scheduled job. Immediate hard delete would destroy audit evidence                                                                                            |
| Malware scanning      | `scan_status` column reserved now so no later migration is needed; no scanning dependency added (Rule 17)                                                                                 |

## J. Testing architecture

Five levels, each answering a different question.

| Level                 | Suite                            | Tool                                      | Runs in this sandbox?          | Proves                                                                                                                                   |
| --------------------- | -------------------------------- | ----------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| L1 Unit               | `tests/unit/**`                  | Vitest                                    | ✅                             | Codecs, limits, error mapping, redaction, env contracts, domain vocabulary                                                               |
| L2 Policy matrix      | `tests/unit/permissions.spec.ts` | Vitest                                    | Phase 4                        | Every role × capability × resource, from the same constant the guard imports                                                             |
| L3 API contract       | `tests/contract/**`              | Vitest + faked Supabase client            | ✅                             | Handler behaviour: envelope shape, validation, status mapping, non-disclosure, correlation                                               |
| **L4 Database + RLS** | `supabase/tests/*.sql`           | **pgTAP** via `supabase test db` (Docker) | ❌ **CI or your machine only** | The only real proof of tenant isolation: for each role and each of two seeded organizations, exactly which rows are visible and writable |
| L5 E2E                | `tests/e2e/**`                   | Playwright                                | ❌ needs a running stack       | Critical journeys, plus a negative test that client A cannot reach client B's data                                                       |

**Phase 1 adds a level the assessment did not name: architectural conformance
tests** (`tests/architecture/**`). They read the repository as source and assert
properties that no amount of unit testing can: every `src/server/**` module
declares `server-only` first; no isomorphic module reaches it; no `'use client'`
file reaches it; only the client env module reads `process.env`; no server module
imports UI; the Supabase clients have no barrel; every API route is built with
`withRoute`; no credential-shaped literal is committed; `.env.example` matches the
declared key sets exactly in both directions; the dependency budget is exactly the
approved list; the strictness flags are still enabled; the security headers and
lint wall are still present.

Three of them guard the guards, and each was added because the Phase 1 review
found the gap it closes:

- **No browser-only API in the isomorphic tier.** `src/lib` must be safe to
  _execute_ on both sides, not merely importable from both. This check names
  `createBrowserClient` explicitly, because a source scan cannot see through a
  dependency: that factory reads `document.cookie` inside `@supabase/ssr`, so a
  `src/lib` module importing it contains no offending token of its own.
- **No non-literal dynamic `import()`.** Every boundary test extracts module
  specifiers from source text, so `import(computed)` would be invisible to all of
  them — a complete bypass of the wall. Application source contains none today,
  and this keeps it that way.
- **The env key lists are derived from their schemas**, so `.env.example` parity
  transitively validates the schemas themselves. Two hand-maintained statements of
  one contract can disagree silently; derivation makes that unrepresentable
  (ADR-0023 rule 6).

`tests/unit/domain.spec.ts` sits alongside these for a related reason: the domain
vocabulary is pure data with no behaviour to exercise, so it went untested until
the review — yet in Phase 2 it becomes PostgreSQL enums, in Phase 4 the axis of the
permission matrix, and in Phase 9 the navigation. It also carries the **risk R-1
tripwire**, which binds `src/lib/domain/roles.ts` to the §M risk register so that
closing the known role-model gap requires updating both in one change.

These tests exist because the properties they guard are **invisible when they
break**. Removing `import 'server-only'` from one file changes no behaviour and
fails no other test — it simply removes a control.

Two deliberate exclusions: no snapshot tests for authorization decisions (a
snapshot makes it easy to accept a changed permission matrix without noticing),
and no L4 substitute — RLS cannot be unit-tested, and pretending otherwise would
produce false confidence about the single most important property of the system.

## K. Environment configuration

| Variable                        | Scope  | Required                       | Notes                                                                     |
| ------------------------------- | ------ | ------------------------------ | ------------------------------------------------------------------------- |
| `APP_ENV`                       | server | ✅ (defaults to `development`) | At `production`, an incomplete environment crashes the process at boot    |
| `LOG_LEVEL`                     | server | optional                       | `debug\|info\|warn\|error\|silent`; unrecognised values degrade to `info` |
| `SUPABASE_SERVICE_ROLE_KEY`     | server | ✅                             | **`BYPASSRLS`.** Read by exactly one module                               |
| `NEXT_PUBLIC_SUPABASE_URL`      | client | ✅                             | Public by design                                                          |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client | ✅                             | Public by design; safe **only** because RLS exists                        |
| `NEXT_PUBLIC_APP_URL`           | client | ✅                             | Canonical origin                                                          |

Authoritative contracts: `src/lib/env/client-env.ts` and `src/server/env.ts`.
Full rationale in [ADR-0023](adr/ADR-0023-environment-lazy-fail-fast.md).
`.env.example` is kept in exact parity with those lists by test — and both lists
are **derived from their Zod schemas** rather than hand-maintained beside them, so
the schema is the only place a variable is declared and the two cannot drift.

**Deliberately absent: the Supabase connection strings.**
`SUPABASE_DB_URL_POOLED` and `SUPABASE_DB_URL_DIRECT` were removed from this
contract during the Phase 1 architecture review. Nothing in the repository read
them, and nothing ever will: this application never opens a PostgreSQL connection
— all database access goes through Supabase's API, with Row Level Security as the
enforcement point (ADR-0004, §G). They are _migration tooling_ configuration, and
Phase 2 introduces them in the same change that adds the migration runner which
consumes them. `supabase/README.md` records which one migrations need and why, so
the decision is preserved rather than rediscovered.

Variables are added **when a module consumes them**. Auth configuration arrives in
Phase 3 and rate limiting in Phase 6; nothing speculative is listed (Rule 14).

## L. Security boundaries

| #   | Layer            | Control                                                                                                                                           | Phase                    |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1   | Transport / edge | HTTPS, `HttpOnly`+`Secure`+`SameSite=Lax` cookies, no CORS surface                                                                                | 1 (cookies) / 3          |
| 2   | Response headers | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `X-DNS-Prefetch-Control`                                             | **1 — implemented**      |
| 3   | Middleware       | Session refresh + coarse routing gate. **UX only, never a control**                                                                               | 3                        |
| 4   | Route handler    | `getUser()` verification → Zod `.strict()` → `requireCapability()`                                                                                | **1 (validation)** / 3–4 |
| 5   | Service layer    | `organization_id` derived from the parent row; state machine; explicit DTOs; transactional audit                                                  | 5                        |
| 6   | Supabase client  | Anon key + **propagated user JWT** for all tenant operations                                                                                      | **1 — implemented**      |
| 7   | PostgreSQL       | RLS (`ENABLE` + `FORCE`), `SECURITY DEFINER` helpers with pinned `search_path`, composite FKs, CHECKs, triggers, column grants, append-only audit | 2                        |
| 8   | Storage          | Private bucket, org-prefixed paths, `storage.objects` RLS, 60 s signed URLs, MIME/size limits, filename sanitization                              | 6                        |

Implemented in Phase 1 and verified: layers 2 and 6, plus the four-control
containment of the service-role key (ADR-0002), structured logging with
two-mechanism redaction (ADR-0024), error non-disclosure (ADR-0025), and
request-id correlation with log-injection resistance.

Deferred with a stated reason, not overlooked: **CSP and HSTS** (Phase 6 — a CSP
written before any UI exists would be either too loose to matter or strict enough
to break Phase 9), **rate limiting** (Phase 6), **MFA enforcement** (Phase 3/6),
**malware scanning** (Phase 6).

## M. Risks and trade-offs

| ID   | Risk                                                                                                                        | Sev | Mitigation / status                                                                                                                                                                                                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1  | No non-privileged internal role: all internal staff need cross-tenant `ADMIN`                                               | 🔴  | **Owner decision required.** Documented on `ROLES` in `src/lib/domain/roles.ts` and enforced by a tripwire test in `tests/unit/domain.spec.ts`, which fails if a fifth role appears while this row still says "Owner decision required"; permission layer designed so a fifth role is configuration, not refactor |
| R-2  | JWT claim staleness: a revoked role stays valid until refresh                                                               | 🟠  | Authoritative DB re-check for privileged ops; forced re-auth on role change (Phase 3)                                                                                                                                                                                                                             |
| R-3  | **RLS cannot be executed in the Phase 1 sandbox** — no Docker, no Supabase CLI, no PostgreSQL, no network route to Supabase | 🔴  | pgTAP authored in Phase 2 and executed in CI (Docker available there) and locally. Until then RLS is reported as _authored, not executed_                                                                                                                                                                         |
| R-4  | Bleeding-edge stack                                                                                                         | 🟠  | **Resolved on evidence** — see [ADR-0022](adr/ADR-0022-dependency-versions-pinned-on-evidence.md). TypeScript 7 and ESLint 10 were both rejected after reproducing concrete failures                                                                                                                              |
| R-5  | Denormalized `organization_id` could drift                                                                                  | 🟡  | Composite FKs make drift impossible at the database level (Phase 2)                                                                                                                                                                                                                                               |
| R-6  | No rate limiting until Phase 6                                                                                              | 🟠  | Interface reserved; no dependency added without approval                                                                                                                                                                                                                                                          |
| R-7  | No malware scanning on client uploads                                                                                       | 🟡  | `scan_status` reserved; MIME/size allowlist + verification meanwhile                                                                                                                                                                                                                                              |
| R-8  | Signed uploads land in Storage before metadata validation                                                                   | 🟡  | Bucket limits, `status='pending'` until verified, post-upload HEAD check                                                                                                                                                                                                                                          |
| R-9  | Serverless ↔ PostgreSQL connection exhaustion                                                                               | 🟠  | Pooled connections for the app; direct only for migrations                                                                                                                                                                                                                                                        |
| R-10 | Data residency across US/UK/EU/DIFC/AU clients                                                                              | 🟠  | **Owner decision required.** Region choice is effectively irreversible without a data migration                                                                                                                                                                                                                   |
| R-11 | Compliance surface (`/data-processing`, `/terms-of-engagement` are published)                                               | 🟠  | Append-only audit, retention policy, export/erasure endpoints (Phase 6)                                                                                                                                                                                                                                           |
| R-12 | Repository name says "Backend" but holds both dashboards                                                                    | 🟢  | Documented; rename is cheap now, expensive later — **owner decision**                                                                                                                                                                                                                                             |
| R-13 | Multi-currency money (USD/GBP/EUR/AED/AUD)                                                                                  | 🟡  | `numeric(14,2)` + explicit currency; **no FX conversion in scope** — confirm                                                                                                                                                                                                                                      |
| R-14 | `audit_events` / `metrics` unbounded growth                                                                                 | 🟡  | Append-only + documented partitioning thresholds                                                                                                                                                                                                                                                                  |
| R-15 | Single deployable couples UI and API                                                                                        | 🟡  | Accepted (Rule 16); error boundaries + health probe                                                                                                                                                                                                                                                               |
| R-16 | Realtime + RLS policy evaluation load                                                                                       | 🟢  | Read-only channels, coarse granularity, `STABLE` helpers                                                                                                                                                                                                                                                          |
| R-17 | Supabase plan limits (egress, MAU, storage, PITR needs Pro)                                                                 | 🟠  | Size the plan before Phase 7; per-organization quotas enforced in-app                                                                                                                                                                                                                                             |
| R-18 | `eslint@9.39.5` is past its support window                                                                                  | 🟡  | Accepted with reasoning in ADR-0022; upgrade path is mechanical because the wall rules use only core ESLint rules                                                                                                                                                                                                 |

## N. What Phase 1 deliberately did not build

Recording omissions matters as much as recording decisions, because each of these
looks like something that "should already be here":

- No authentication, no sessions, no login, no guards → Phase 3.
- No permission matrix, no capability enforcement, no roles in the database → Phase 4.
- No business endpoints, no services, no repositories → Phase 5.
- No migrations, no schema, no RLS SQL, no seed data → Phases 2 and 7.
- No rate limiting, CSP, HSTS, MFA enforcement, malware scanning → Phase 6.
- No entity TypeScript types and no entity Zod schemas → generated/authored in Phases 2 and 5.
- No dashboard UI beyond the minimum needed to build and serve: an unstyled root
  page, a 404, and two error boundaries. → Phase 9.
- No placeholders standing in for the above. A stubbed guard or a mock endpoint
  would read as a control while providing none (Rules 8 and 14).

## O. Local development

See [docs/runbooks/local-development.md](../runbooks/local-development.md).
