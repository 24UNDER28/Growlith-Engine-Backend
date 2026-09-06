# Phase 5 — API Architecture

**Status:** **implemented.** `/api/v1` and the database schema are the
compatibility contract (`docs/architecture/README.md` §A.2); breaking either
requires a version bump ([§15](#15-versioning-and-the-compatibility-contract)).
**Decisions:** [ADR-0014](adr/ADR-0014-no-cors-same-origin-api.md) (no CORS,
same-origin API — authored here), [ADR-0027](adr/ADR-0027-framework-generated-405.md)
(405 responses are framework-generated — closes the Phase 1 open item),
[ADR-0028](adr/ADR-0028-idempotency-key-contract.md) (the `Idempotency-Key`
contract), [ADR-0029](adr/ADR-0029-archive-organization-definer-rpc.md)
(proposed: one new definer RPC, `archive_organization()`, joins the closed set).
**Inputs:** Phase 1 (`withRoute`, the envelope, error codes, cursor codec,
`/api/v1/health`), Phase 2 (23 tables, enums, `status_transitions`, audit),
Phase 3 (authentication, `AuthContext`, the implemented `/api/v1/auth/**`,
`/api/v1/invitations/**`, `/api/v1/accounts/**` routes), Phase 4 (the dense
capability matrix, `authorize()`, the 404-before-403 rule, the closed definer
RPC set, RLS).

---

## 0. Summary

The API is **one resource-oriented REST surface at `/api/v1`**, built on the
machine that already exists: every route is a `withRoute` definition
(ADR-0013), so authentication, capability checking, validation ordering,
envelopes, headers and logging are structural rather than per-handler. Phase 5
adds the resource catalogue on top of it — and nothing else.

```
 requestId → method → param/query/body validation (Zod .strict())
   → AUTHENTICATION (requireAuthContext: getUser + auth_context() + status gate)
   → tenant resolution → CAPABILITY (authorize: 404-before-403, denial audit)
   → obligations → IDEMPOTENCY replay check (creates that declare it)
   → service layer (user-JWT client ⇒ RLS; parent-derived organization_id;
     state machine; definer RPC where the matrix says [R]; transactional audit)
   → DTO mapper (audience-aware; never a raw row)
   → envelope {data|pagination, meta} → headers → structured log
```

The design answers five questions the earlier phases left to Phase 5:

1. **The 405 question** (README §H open item): resolved — 405s stay
   framework-generated; the envelope uniformity waiver is now contract
   (ADR-0027).
2. **The CORS question**: resolved — none, same-origin only (ADR-0014).
3. **Idempotency**: POST creates carry an `Idempotency-Key` contract
   (ADR-0028); everything else is idempotent by construction or answers 409.
4. **Rate limiting**: Phase 6's mechanism, but the _hook_ is designed now — a
   declared class per route, an enforcement point in `withRoute`, and the 429
   shape ([§10](#10-rate-limiting-hooks)).
5. **The client/portal surface**: there is **no separate client API**. A
   "client" is a user whose role is scoped to an organization, and the portal
   consumes the _same_ endpoints the admin dashboard does, narrowed by the
   matrix, the column grants and RLS ([Part II §E](#e-clients)).

**No fake endpoints.** Every route in Part II is backed by (a) an existing
table or definer RPC from Phases 2–4 and (b) at least one `ALLOW` cell in the
capability matrix. Where no capability exists there is no endpoint — metrics
ingestion, notification creation, team CRUD and user creation are therefore
_absent by construction_, and each absence is recorded in
[§17](#17-deliberate-absences).

### Route census

| Family                            | Endpoints | Status                              |
| --------------------------------- | :-------: | ----------------------------------- |
| Health                            |     1     | Implemented (Phase 1)               |
| Auth (`/api/v1/auth/**`)          |     9     | Implemented (Phase 3)               |
| Invitations                       |     5     | 3 implemented (Phase 3), 2 designed |
| Accounts lifecycle                |     4     | Implemented (Phase 3)               |
| Self, users, erasure              |     5     | Designed                            |
| Organization members              |     4     | Designed (RPC-backed)               |
| Platform grants                   |     3     | Designed (RPC-backed)               |
| Team staffing                     |     5     | Designed                            |
| Organizations                     |     9     | Designed                            |
| Engagements                       |     7     | Designed                            |
| Services                          |     7     | Designed                            |
| Projects (+ memberships)          |    11     | Designed                            |
| Tasks                             |     7     | Designed                            |
| Deliverables (+ versions/reviews) |    11     | Designed                            |
| Reports (+ metrics)               |     8     | Designed                            |
| Files                             |     7     | Designed                            |
| Comments                          |     5     | Designed                            |
| Notifications                     |     3     | Designed                            |
| Activity                          |     2     | Designed                            |
| Reference (`status-transitions`)  |     1     | Designed                            |
| **Total**                         |  **114**  | implemented                         |

---

# Part I — Conventions

## 1. URL and resource conventions

1. **Resource-oriented REST.** Plural nouns, no verbs in paths except the
   action sub-resources of item 4. Nesting is capped at **two levels**
   (README §H); deeper access is a query filter
   (`/api/v1/tasks?projectId=…`, never `/api/v1/organizations/…/engagements/…/services/…/projects/…/tasks`).
2. **Collections nest under their parent for creation; items are flat.** A
   child is created at `POST /api/v1/{parents}/{parentId}/{children}` — the
   parent in the path is what the tenant resolver and the composite FK
   consume. Once created, the child is addressed flat by its UUID
   (`/api/v1/tasks/{taskId}`): UUIDs are globally unique, and the tenant is
   derived **from the row** through the caller's RLS, which is what makes
   404-before-403 work (ADR-0019, [§4](#4-authorization-conventions)).
3. **Path parameters are UUIDs** unless the identifier is a human-facing code
   (none in v1 — organizations are addressed by id; `slug` is a portal-page
   concern, not an API one). Every id passes `uuidField()` validation; a
   malformed id is 422, never a database round trip.
4. **Lifecycle transitions are action sub-resources**, matching the
   implemented account routes: `POST /api/v1/{resource}/{id}/{verb}` —
   `status`, `assign`, `approve`, `publish`, `resend`, `revoke`, `suspend`,
   `revoke`, `erase`. An action endpoint performs exactly one state change and
   returns the updated resource (or 204 where nothing remains to say).
5. **Path segments are kebab-case** (`password-recovery`, `upload-url`,
   `download-url`); query parameters and JSON fields are **camelCase**; enum
   values travel as their PostgreSQL labels (`SCREAMING_SNAKE`).
6. Trailing slashes are not served (framework 404). Unknown paths under
   `/api/v1` return the framework's 404; the typed client treats an empty or
   unparseable error body as a first-class case (ADR-0027).
7. **`organization_id` never appears in a request body or query as the tenant
   of a write.** It is derived from the parent row (trigger + composite FK,
   README §D). Where a list _filters_ by organization, the parameter is named
   `organizationId` and is a filter, not a target ([§9](#9-filtering-and-sorting-conventions)).

## 2. The request pipeline

The order is fixed by `withRoute` and is identical for every route (README §D,
authorization §I.3). Phase 5 inserts exactly one new step — the idempotency
replay check — and pins its position:

| Step                    | Rejects as                                                    | Notes                                                         |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| request id              | —                                                             | caller-supplied or minted; echoed in `x-request-id`           |
| method                  | 405 (declaration mismatch only)                               | framework 405s never reach the handler (ADR-0027)             |
| params / query / body   | 422 `VALIDATION_FAILED` (400 for unparseable JSON / oversize) | `.strict()`: unknown keys rejected                            |
| authentication          | 401 / 403 `INVITATION_PENDING` / 423                          | `requireAuthContext()`, incl. `minAal` floor                  |
| tenant resolution       | 404 `NOT_FOUND`                                               | log-only; never audited (probes must not mint audit rows)     |
| capability              | 403 `FORBIDDEN` / `MFA_REQUIRED`                              | `PERMISSION_DENIED` audit at WARNING                          |
| idempotency             | replay stored response / 409                                  | creates that declare it ([§13](#13-idempotency-requirements)) |
| handler / service layer | 404 / 409 / 503                                               | RLS applies on every read and write                           |
| envelope + headers      | —                                                             | `no-store`, `x-request-id`                                    |
| structured log          | —                                                             | one line per request ([§11](#11-logging-strategy))            |

Validation runs before authentication (cheap, local, no privileged work for a
malformed request); capability runs after authentication and before any row is
loaded; row identity and state-machine legality belong to the service layer
and the database, never to the guard.

## 3. Authentication conventions

1. Every route declares `auth: 'public' | 'required'` — a compile-time field
   (Phase 3). The **closed public set** is `GET /api/v1/health`,
   `POST /api/v1/auth/login`, `GET /api/v1/auth/session` and
   `POST /api/v1/auth/password-recovery`. `POST /api/v1/auth/logout` is
   public by deliberate exception (a dead session must still log out).
   Everything else is `required`, and new routes default to denied by
   construction.
2. Sessions arrive **only** as the `HttpOnly` cookie (ADR-0026). The API
   accepts no `Authorization` header, no API keys, no service tokens in v1.
   Machine-to-machine access is a future phase with its own ADR; until then
   the only caller shape is "a signed-in person in a browser on this origin".
3. `minAal: 2` is declared on the privileged set ([§4](#4-authorization-conventions)
   lists it): platform grants, erasure, purge/archive, organization settings
   writes are **not** in it — settings are operational, not power-changing;
   the line is drawn at "changes who holds power or destroys evidence".
4. The status gate (423 `ACCOUNT_SUSPENDED`, 401 `ACCOUNT_DEACTIVATED`,
   403 `INVITATION_PENDING`) is applied once, inside `requireAuthContext()`,
   for every `required` route.

## 4. Authorization conventions

Every `required` route declares exactly one `capability` from the matrix
(`src/lib/domain/permissions.ts`). Phase 5's catalogue fixes how each route
fills the authorization fields:

| Field           | Convention                                                                                                                                                                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capability`    | The matrix cell that answers "may this actor attempt this verb". One route, one capability — `withRoute` types it as a single `Capability`, so an endpoint needing two verbs is two endpoints                                                                                                                        |
| `tenant`        | Where the organization comes from: **path** (nested collections), **row** (flat item routes load the row through the caller's RLS; invisible ⇒ `null` ⇒ 404), **query/body** (lists filtered by `organizationId`), **shared-org resolver** (cross-cutting reads of a person), or **absent** (GLOBAL/SELF cells only) |
| `project`       | Set on every `[P]`-qualified route so the guard evaluates §5-rule-3 for ADMIN and passes the project id through for object-side rules                                                                                                                                                                                |
| `subjectUser`   | Set where a SELF-scoped capability names a person in the path (`/accounts/{userId}/**`)                                                                                                                                                                                                                              |
| `minAal`        | `2` for the power-changing set below; absent otherwise                                                                                                                                                                                                                                                               |
| `denialSubject` | Set wherever the route can name the target without loading it, so a denial audit is not "denied about nothing"                                                                                                                                                                                                       |

**The 404-before-403 rule is absolute** (ADR-0019): tenant-unreachable rows
answer 404; 403 is only emitted once tenant reach is established. Step-4
denials are logged, not audited; step-5/6 denials write `PERMISSION_DENIED`
at WARNING (authorization §I.4).

**Routes requiring `minAal: 2`** (complete list; adding one is a review
decision, not an implementation detail):

- `POST /api/v1/admin/platform-grants` and `…/{userId}/revoke`
- `POST /api/v1/admin/users/{userId}/erase`
- `DELETE /api/v1/organizations/{organizationId}` (archive)
- the existing `POST /api/v1/accounts/{userId}/reactivate` (SUPER_ADMIN-only
  reopening of an offboarded account — already implemented; the AAL floor is
  an implementation retrofit noted in [§19](#19-implementation-sequence))

**Obligations are carried into the handler** (`CLIENT_VISIBLE`,
`STATE_MACHINE`, `RPC_ONLY`, `PROJECT_MEMBER`, `COLUMN_RESTRICTED`,
`OWN_ROW`) and each spec in Part II states which obligation the service layer
must honour. Forgetting an obligation is a contract-test failure, not a
runtime accident: [§18](#18-verification-strategy).

**Audience-aware DTOs.** The same route serves staff and clients where the
matrix allows both (authorization §I.5). The mapper picks the DTO by resolved
role: staff DTOs carry internal-only fields; client DTOs are a separate type
built from the column-restricted view. A field that is not granted to
`authenticated` never appears in any DTO — the DTO narrows _further_, it
never widens.

## 5. Response and DTO conventions

1. **Envelope.** Success `{ data, meta: { requestId, tookMs } }`; lists
   `{ data: […], pagination: { limit, nextCursor, hasMore }, meta }`; errors
   `{ error: { code, message, details?, requestId? } }`. `withRoute` gains
   one seam for this: a handler returning a `pageResult(items, page)` value is
   serialized as the list envelope; anything else is the object envelope.
2. **Status codes.** `200` reads and updates · `201` creates, with a
   `Location` header pointing at the new resource (`withRoute` gains an
   optional `location` field; the DTO also carries `id`, so no caller depends
   on the header) · `202` only where accepted work completes elsewhere
   (`password-recovery`) · `204` logout, deletes, and mutations with nothing
   to return (member removal, platform-role revocation, erasure).
3. **Wire casing and scalars.**
   - JSON fields are camelCase; DB rows are mapped field-by-field by explicit
     mappers — never a raw row, never a spread of the request (README §D).
   - Timestamps are ISO-8601 UTC with `Z` (`2026-09-06T12:00:00Z`); `date`
     columns travel as `YYYY-MM-DD`.
   - Money travels as a **decimal string** (`"12500.00"`) beside an explicit
     `currency` code — never a float (domain §5). Validation: regex
     `^\d{1,12}(\.\d{1,2})?$`, fitting `numeric(14,2)`.
   - UUIDs are lowercase; enums are their exact PostgreSQL labels.
   - Attribution fields (`createdBy`, `updatedBy`, `accountManagerUserId`,
     assignees, leads, reviewers) are **bare UUIDs** in v1. Callers resolve
     names through `GET /api/v1/users?ids=…` ([§B](#b-self-users-and-account-lifecycle)).
     Embedded actor objects were rejected: they drift from the directory and
     they would leak staff identity fields into client-visible payloads.
   - Every tenant-scoped DTO carries `organizationId` — cross-tenant staff
     lists must render the tenant (authorization §C.2).
4. **Soft-deleted rows are never returned**; list filters always AND
   `deleted_at is null` at the query level as well as in RLS.
5. **Mutation responses return the authoritative post-write DTO** — the
   service re-reads the row (or takes the RPC's return) rather than echoing
   input, so trigger-derived values (`organization_id`, `updated_at`,
   `current_version`) are what the caller sees.
6. **No ETags, no conditional requests, no HTTP caching in v1.** Every
   response is `Cache-Control: no-store, max-age=0, must-revalidate`
   (enforced by `withRoute` _and_ at the edge). ETags over RLS-filtered
   collections would leak visibility changes through validator behaviour;
   revisit only with a consumer that needs them.
7. **Nulls are returned as `null`**, not omitted — an absent field means "the
   schema does not define it", which keeps DTO shapes stable for the typed
   client.

## 6. Error conventions

One envelope, one code vocabulary (`src/lib/types/error-codes.ts` — adding a
code is compatible; renaming one is a version bump), and one mapping:

| Status | Code(s)                                                         | Emitted when                                                                                                  |
| ------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 400    | `MALFORMED_REQUEST`                                             | body not JSON, body empty where required, malformed `Content-Length`                                          |
| 401    | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `ACCOUNT_DEACTIVATED` | no/invalid session; login credential failure (uniform); offboarded account                                    |
| 403    | `FORBIDDEN`, `MFA_REQUIRED`, `INVITATION_PENDING`               | capability denied _after_ tenant reach; aal2 outstanding; not-yet-accepted account                            |
| 404    | `NOT_FOUND`                                                     | missing row **or row hidden by RLS** — deliberately indistinguishable (ADR-0019)                              |
| 405    | _(empty body — framework-generated)_                            | verb not exported by the route file (ADR-0027); `withRoute`'s own check covers declaration mismatch           |
| 409    | `CONFLICT`                                                      | unique violation, illegal state transition, idempotency-key reuse with a different body, RPC business refusal |
| 413    | `PAYLOAD_TOO_LARGE`                                             | body over 1 MiB (declared-length fast path + post-read check)                                                 |
| 422    | `VALIDATION_FAILED`                                             | schema failure — `details[]` carries `{ path, message, code }` issues, the only case `details` exists         |
| 423    | `ACCOUNT_SUSPENDED`                                             | suspended account, any `required` route                                                                       |
| 429    | `TOO_MANY_REQUESTS`                                             | rate limiter (Phase 6; hook [§10](#10-rate-limiting-hooks)) — `Retry-After` header included                   |
| 500    | `INTERNAL_ERROR`                                                | unknown throwable, downgraded; cause logged, never serialized (ADR-0025)                                      |
| 503    | `SERVICE_UNAVAILABLE`                                           | Supabase unreachable — fail closed, `Retry-After` included                                                    |

Conventions that keep the table honest:

- **409 carries machine-usable detail.** State-machine refusals and business
  refusals from definer RPCs return `CONFLICT` with `details` shaped like
  validation issues: `{ path: 'status', code: 'invalid_transition', message:
'…' }`; RPC-specific refusals use stable `code`s — `invalid_transition`,
  `duplicate_code`, `last_admin`, `primary_contact_replacement_required`,
  `role_ceiling`, `self_modification`, `reviewer_not_member`,
  `report_not_publishable`, `invitation_state`. These strings are part of the
  v1 contract on the same terms as error codes.
- **RPC exceptions are mapped, never surfaced.** A definer RPC raising
  `insufficient_privilege` becomes 403; a business `raise exception` becomes
  409 with its stable detail code; anything unrecognized becomes 500. PostgREST
  and Supabase error text never reach the wire (ADR-0025).
- **Non-disclosure.** No stack trace, SQL, row contents, constraint names or
  upstream text. Existence of another tenant's rows is never confirmable.

## 7. Validation conventions

1. **Zod `.strict()` on every input object** (ADR-0017): unknown keys are a
   422, which is what makes mass assignment unrepresentable — a caller cannot
   smuggle `organizationId`, `role`, `clientVisible` or `isInternal` into a
   payload that does not declare them.
2. **One schema, three consumers.** Entity schemas live in
   `src/lib/validation/{resource}.ts` (isomorphic), are composed into route
   input schemas, and drive the Phase 9 forms. The Phase 5 implementation
   authors: `organization`, `engagement`, `service`, `project`,
   `project-membership`, `task`, `deliverable`, `report`, `file`, `comment`,
   `notification`, `invitation`, `membership`, `platform-grant`,
   `team-membership`, `metric-query`.
3. **Field primitives reuse `src/lib/validation/common.ts`** — `uuidField`,
   `slugField`, `textField`, `optionalTextField`, `timestampField`,
   `boundedString` — plus Phase 5 additions declared here and authored in the
   implementation step: `moneyField` (decimal string, `numeric(14,2)` range),
   `dateField` (`YYYY-MM-DD`), `enumField(label, values)` (literal union from
   the generated DB types, so a DB enum change fails the build until the API
   schema follows), `csvField(inner, max = 20)` (comma-separated multi-value —
   required because `withRoute`'s query reader collapses repeated params to
   the last value; documented there as the Phase 5 seam).
4. **PATCH is partial-update semantics**: every field optional, at least one
   required (empty object ⇒ 422 `empty_update`). PATCH never changes status —
   transitions own their action endpoints ([§1](#1-url-and-resource-conventions)).
   Append-only resources (`deliverable_versions`, `report_metrics`,
   `audit_events`, `platform_role_grants`) have no PATCH at all.
5. **Bodies are required on POST/PATCH** (empty ⇒ 400, existing behaviour)
   and capped at 1 MiB; file bytes never traverse the API (README §H,
   ADR-0016 → [§L](#l-files)).
6. Dates must carry their unit: `startDate`/`endDate` are `date`s; `dueAt`
   inputs that arrive as timestamps are `timestampField`. Cross-field rules
   (period order, XOR subjects, currency consistency) are `.refine()`s on the
   object schema with a field-anchored message, so they surface as 422
   `details[]` entries.

## 8. Pagination strategy

Keyset-only (ADR-0018): offset pagination is rejected for growth, concurrency
and volume-leakage reasons, and `COUNT(*)` is never performed — there is no
`total` field in v1 and there will not be one without a version bump.

- `limit` — default 25, max 100, clamped server-side (`paginationQuerySchema`,
  implemented). `cursor` — opaque base64url payload `{ key, id }`, decoded
  through the schema-validated codec (implemented).
- **Each list endpoint declares its sort keys** (Part II). The default key
  applies when `sort` is absent; `?sort={key}` selects an alternate.
  **Direction is fixed per key** (e.g. `dueDate` is always ascending) — the
  client chooses the key, never the direction, which keeps the cursor codec
  direction-free and the indexes single-purpose.
- A cursor is **valid only for the exact query that produced it** (same
  filters, same sort key). A decoded cursor that disagrees with the requested
  sort key is 422 `cursor_mismatch`. Cursors are cheap to mint and expire
  with nothing — re-list from scratch is always valid.
- `hasMore` is computed by requesting `limit + 1` rows; the extra row is
  never serialized.
- Empty collections are `200` with `data: []` and `nextCursor: null` — never 404.

## 9. Filtering and sorting conventions

1. **Filters are an allowlist per endpoint**, listed in each Part II spec.
   No free-text search in v1: there is no search index and no justification
   for one (Rules 15–17). Adding a filter later is compatible; the column it
   names must be indexed (an unindexed filter is a review failure).
2. **Exact match and ranges only.** Ids and enums are exact; timestamps and
   dates take `{field}From` / `{field}To` (inclusive-from, exclusive-to);
   there are no substring, wildcard or negation filters.
3. **Multi-value filters are comma-separated** (`?status=TODO,BLOCKED`,
   `?ids=a,b,c`), max 20 values, duplicates collapsed — the `csvField`
   convention of [§7](#7-validation-conventions).
4. **Tenant filters.** On list endpoints whose capability is TENANT-scoped
   for clients, `organizationId` is **mandatory for CLIENT actors and
   optional for staff** (validation enforces this per `auth.userType` before
   the guard runs; the guard's own denial is the backstop). Staff omitting it
   get the cross-tenant list — which is audited as a read pattern in logs
   ([§11](#11-logging-strategy)), not per-row.
5. Sort keys are whitelisted per endpoint exactly like filters; every spec
   names its default. Unknown `sort` or filter keys are 422 — `.strict()`
   applies to query schemas too.

## 10. Rate-limiting hooks

Phase 6 owns the mechanism and its dependency decision (risk R-6: interface
reserved, nothing added without approval). Phase 5 owns the **hook**, so the
limiter plugs into a declared seam instead of being retrofitted onto 103
routes:

1. **Declaration.** `RouteDefinition` gains an optional
   `rateLimit?: { class: RateClass }`, with
   `RateClass = 'auth' | 'sensitive' | 'mutation' | 'read' | 'export'`.
   Absent means the default class: GET ⇒ `read`, everything else ⇒
   `mutation`. The existing implemented routes get explicit classes in the
   same change (login/password-recovery ⇒ `auth`; mfa/invitations/accounts ⇒
   `sensitive`).
2. **Enforcement point.** Inside `withRoute`, after the request id and before
   validation: public-route limits must apply to anonymous traffic. For
   `required` routes the limiter additionally records the resolved actor, so
   the key is `userId` when authenticated and client IP otherwise
   (`x-forwarded-for` first hop — trusted only because the platform edge is
   the sole ingress; documented as an assumption Phase 6 validates).
3. **Budgets (illustrative defaults — Phase 6 tunes, the classes are the
   contract):**

   | Class       | Budget (per key) | Rationale                                                 |
   | ----------- | ---------------- | --------------------------------------------------------- |
   | `auth`      | 10 / 15 min      | credential attempts; GoTrue's own limits remain the floor |
   | `sensitive` | 30 / 15 min      | invitations, grants, status changes, MFA                  |
   | `mutation`  | 300 / 15 min     | ordinary writes                                           |
   | `read`      | 600 / 15 min     | lists and detail reads                                    |
   | `export`    | 20 / hour        | download-URL minting and report export (cost + audit)     |

4. **Response.** 429 `TOO_MANY_REQUESTS` envelope with `Retry-After`
   (seconds) and the standard `requestId`. 429s are logged at `warn` with the
   class and key kind (never the raw IP); repeated 429s against `auth` are
   the Phase 6 abuse-detection input.
5. **What the hook deliberately is not:** not a quota system (per-org volume
   limits are risk R-17 territory), not a DoS control (edge concern), and not
   implemented here — a stub limiter would read as a control while providing
   none (Rules 8 and 14).

## 11. Logging strategy

Built on the Phase 1 foundation (ADR-0024): one structured line per request,
correlated by `requestId`, redaction unconditional.

1. **Access line (every request).** Fields: `requestId`, `route`
   (`METHOD /path`), `summary`, `status`, `tookMs`, `capability` (when
   declared), `actorUserId` (when authenticated — an id, not PII),
   `organizationId` (when the guard resolved one), `rateClass`. The pathname
   is logged **without the query string** — filters are telemetry nobody may
   trust, and tokens must never reach logs (`/auth/confirm` discipline,
   Phase 3 §12).
2. **Levels.** 2xx/4xx complete at `info` (rejections included — 4xx is
   normal traffic, no stack); 5xx at `error` with the cause; capability
   denials add a `warn` line carrying the capability and deny reason beside
   the `PERMISSION_DENIED` audit row; tenant-unresolvable (404-before-403) is
   `info` only, by design never audited.
3. **Service-layer lines** (state transitions, RPC invocations, idempotency
   replays, signed-URL minting) log at `info` with the same `requestId`, so a
   single request is one joinable trail from edge to database.
4. **Audit is not logging.** `audit_events` is the business/security record —
   partitioned, append-only, queryable, retained; logs are operational and
   disposable. The join key is `request_id`, stored on every audit row
   (Phase 2). [§12](#12-audit-conventions) fixes which events are audited;
   everything else is log-only.
5. **Redaction is inherited, not extended.** The two-mechanism redactor
   already strips tokens, cookies, passwords and masks emails; no Phase 5
   field may bypass it. New sensitive fields (there should be none — bodies
   are validated DTOs) require a redaction review before logging.

## 12. Audit conventions

Audit rows are written **in the same transaction as the mutation** (service
layer) or **inside the definer RPC** itself — never best-effort for a
mutation, never for a read unless the matrix says so. The vocabulary is the
Phase 2 `audit_action` enum — Phase 5 adds **no new audit enum values**; the
existing set covers the catalogue:

| API event class                                  | `audit_action`                       |     Default severity     | Notes                                                                                                    |
| ------------------------------------------------ | ------------------------------------ | :----------------------: | -------------------------------------------------------------------------------------------------------- |
| Creates of tenant data                           | `CREATE`                             |          NOTICE          | org create is CRITICAL (a tenant is born)                                                                |
| Field updates, assignments                        | `UPDATE`                             |           INFO           | `before`/`after` diff limited to changed fields                                                          |
| Deletes via API (soft)                           | `SOFT_DELETE`                        |          NOTICE          | org archive is CRITICAL                                                                                  |
| Status transitions (incl. approve/publish verbs) | `STATUS_CHANGE`                      |           INFO           | transition `from → to` in the diff; reopening transitions are CRITICAL by their `allowed_roles` handling |
| Platform role grant / revoke                     | `ROLE_GRANT` / `ROLE_REVOKE`         |         CRITICAL         | RPC-written                                                                                              |
| Invitations                                      | `INVITE_SENT` / `INVITE_ACCEPTED`    | NOTICE / CRITICAL(staff) | Phase 3 convention, kept                                                                                 |
| Membership writes                                | `UPDATE` (or `CREATE`/`SOFT_DELETE`) |         CRITICAL         | the cross-org edge is always CRITICAL (authorization §C)                                                 |
| Report export / file download                    | `EXPORT` / `FILE_DOWNLOAD`           |           INFO           | the two reads that are audited                                                                           |
| Erasure (GDPR)                                   | `UPDATE`                             |         CRITICAL         | RPC-written; the diff names erased columns, never values                                                 |
| Purge                                            | `HARD_DELETE`                        |         CRITICAL         | RPC writes it _first_                                                                                    |
| Capability denials                               | `PERMISSION_DENIED`                  |         WARNING          | guard-written, step 5/6 only                                                                             |

Every row carries `actor_user_id`, `entity_kind`, `entity_id`, `request_id`;
`before`/`after` never include columns the _audited actor_ could not read
(the mapper builds the diff, not the raw row). Client actors never read
`audit_events` through the API — the projection of [§O](#o-activity) is the
only client-facing surface.

## 13. Idempotency requirements

Three tiers, in decreasing order of ceremony:

1. **Idempotent by construction — safe to retry blindly.** All GETs; all
   action endpoints (`status`, `assign`, `approve`, `publish`, `suspend`, …):
   a repeated call either finds the state already reached and answers 409
   `invalid_transition` naming the current state, or re-applies a no-op and
   returns the same DTO; `DELETE` (a repeat answers 404 — the resource is
   gone, which is what the caller wanted); `logout` (204 even with nothing to
   revoke, implemented precedent).
2. **Conflict-guarded creates.** Creates whose schema carries a natural
   uniqueness constraint — invitations (unique pending per address/target,
   implemented) and organization members (one live membership per
   person×org) — answer a blind retry with 409 and enough detail to recover
   the existing row. Acceptable because the conflict _is_ the answer.
3. **`Idempotency-Key` creates (ADR-0028).** Every other POST create
   **requires** the header: organizations, engagements, services, projects,
   tasks, deliverables, deliverable review submissions, reports, comments,
   file registration, upload-URL minting. (Project memberships are tier 2 —
   their unique index answers retries, H-9.) Contract:
   - Header `Idempotency-Key`, a UUID (v4/v7), ≤ 64 chars; missing or
     malformed on a listed endpoint ⇒ 400 `idempotency_key_required`.
   - Key is scoped `(actor_user_id, route, key)`; store is the
     `idempotency_keys` table (Phase 5 implementation migration): key columns
     - `request_hash` (SHA-256 of the validated body) + stored `status` and
       response envelope + `created_at`; rows expire after **24 h** (job or
       lazy purge).
   - Replay semantics: same key + same `request_hash` ⇒ the **stored
     response**, re-emitted with its original status and an
     `Idempotency-Replayed: true` header; same key + different body ⇒ 409
     `CONFLICT` (`idempotency_key_reused`); a key whose first attempt failed
     with 4xx/5xx is **not consumed** — the client may retry with the same
     key. Concurrent same-key requests serialize on the unique index; the
     loser receives 409 `request_in_flight`.
   - The check sits after the capability gate ([§2](#2-the-request-pipeline)):
     a denied request neither consumes nor reveals a key.

## 14. Content, headers and body limits

- `Content-Type: application/json` (UTF-8) is required on requests carrying a
  body; anything else is 400. `Accept` is ignored — every response is JSON.
- 1 MiB JSON body cap (implemented: declared-length fast path + post-read
  check). Files use signed URLs ([§L](#l-files)); there is no multipart
  endpoint in v1.
- Response headers: `x-request-id`, `Cache-Control: no-store, max-age=0,
must-revalidate` (route _and_ edge — implemented), the security header set
  of Phase 1, and — deliberately — **no CORS headers at all** (ADR-0014).
  Cross-origin browser calls fail on the browser's own terms; the API never
  negotiates with them.
- No CORS preflight surface exists: with no CORS headers and same-origin
  callers only, there are no `OPTIONS` handlers — an `OPTIONS` request
  receives the framework's body-less 405 like any other unsupported verb.

## 15. Versioning and the compatibility contract

- `/api/v1` is the contract once Phase 5 implementation lands. Breaking it
  means `/api/v2`; `/v1` is never silently mutated (README §H).
- **Compatible:** new endpoints, new optional input fields, new DTO fields,
  new error codes, new `audit_action`/enum values where schemas already
  branch safely, new sort/filter keys.
- **Breaking:** removing or renaming routes, fields, error codes, capability
  strings, stable 409 detail codes; changing types, envelope shapes,
  pagination semantics; tightening a filter's accepted values.
- Capability strings are contract strings (authorization §1.3): the 19
  resources × 11 actions vocabulary may grow (compatibly) but never rename
  inside v1.

---

# Part II — The resource catalogue

**How to read a spec.** Each endpoint is one block with the same eight axes:
**AuthN/AuthZ** (session posture · capability with its matrix cells
`SUPER_ADMIN ADMIN CLIENT_ADMIN CLIENT_MEMBER` · tenant source · AAL floor) ·
**Input** · **Output** · **Page/filter/sort** · **Errors** (beyond the global
table of [§6](#6-error-conventions)) · **Validation** · **Audit** ·
**Idempotency**. Three recurring shapes are named once and referenced:

- **SOFT-DELETE** — staff-only `DELETE`, service layer sets `deleted_at` /
  `deleted_by` through the user-JWT client (RLS write policy), answers 204,
  audits `SOFT_DELETE` at NOTICE, is idempotent (repeat ⇒ 404), and refuses
  rows that carry live children where the schema says so (409
  `has_active_children`).
- **STATUS-TRANSITION** — `POST /{resource}/{id}/status` with body
  `{ status, reason? }`. Capability is the resource's `update` cell carrying
  `[S]`; the `STATE_MACHINE` obligation requires the service to load the
  transition row (`status_transitions`, incl. `allowed_roles` — authorization
  §13), reject illegal moves as 409 `invalid_transition` naming
  `currentStatus`, and let `growlith.enforce_status_transition()` re-check in
  the database. Audited `STATUS_CHANGE`, `before/after = {from, to, reason}`.
  The pattern applies to the five machine-bearing entities; D-5 documents
  the one designed exception (organizations).
- **ASSIGN** — `POST /{resource}/{id}/assign` with the assignment fields in
  the body. Capability is the resource's `assign` cell; object-side rules
  (e.g. task assignee must be a live project member) are obligations enforced
  by the service layer and the Phase 4 triggers. Audited `UPDATE` at INFO
  with the changed reference fields.

---

## A. Authentication

Implemented in Phase 3 and catalogued here for completeness — the Phase 5
contract adopts them unchanged, plus a `rateLimit` class retrofit.

### A-1. `POST /api/v1/auth/login`

- **AuthN/AuthZ** `public` — this endpoint _is_ authentication; no
  capability. Handler performs its own authoritative checks.
- **Input** body `{ email: string≤320, password: string≤4096 }` strict.
- **Output** `200` `{ user: AuthContextDTO, mfaRequired: boolean,
redirectTo: string }`; `redirectTo` derived server-side, never echoed from
  the request.
- **Page/filter/sort** —.
- **Errors** `401 INVALID_CREDENTIALS` uniform across unknown-address and
  wrong-password · `423 ACCOUNT_SUSPENDED` · `401 ACCOUNT_DEACTIVATED` ·
  `403 INVITATION_PENDING` · `429 TOO_MANY_REQUESTS` (GoTrue today, app-level
  `auth` class in Phase 6).
- **Validation** strict body; credentials are never serialized into logs,
  errors or audit.
- **Audit** `LOGIN` INFO on success; `LOGIN_FAILED` WARNING with coarse
  reason enum on failure.
- **Idempotency** n/a (stateless); rate class `auth`.

### A-2. `POST /api/v1/auth/logout`

- **AuthN/AuthZ** `public` by deliberate exception — an expired session must
  still log out; handler resolves the session best-effort.
- **Input** none. **Output** `204`, always — even with nothing to revoke.
- **Errors** none by design; `503` only on total outage.
- **Audit** `LOGOUT` INFO best-effort (a failed audit must not block logout).
- **Idempotency** by construction; rate class `auth`.

### A-3. `GET /api/v1/auth/session`

- **AuthN/AuthZ** `public`; reports state, applies no gate.
- **Output** `200` `{ session: AuthContextDTO | null }` — always 200 (never
  401), so callers branch on data; `503` still means "unknown", not "out".
- **Audit** none. **Idempotency** n/a; rate class `read`.

### A-4. `POST /api/v1/auth/password`

- **AuthN/AuthZ** `required` · `user:update` (SELF branch — own password);
  no `subjectUser` resolver (the caller is the subject).
- **Input** body `{ password: string≥12 }` strict; binding policy is GoTrue's.
- **Output** `204`; other sessions revoked (`signOut others`).
- **Errors** `422` policy refusal surfaced generically (never which check).
- **Audit** `UPDATE` · profile · INFO · `changed_fields: ['password']` —
  never the value.
- **Idempotency** naturally (second call with same password is a no-op update
  that still evicts others — acceptable); rate class `sensitive`.

### A-5. `POST /api/v1/auth/password-recovery`

- **AuthN/AuthZ** `public`; non-disclosure by construction.
- **Input** body `{ email }` strict. **Output** `202` always — same shape and
  latency whether or not the address exists or is `ACTIVE`.
- **Audit** `PASSWORD_RESET_REQUESTED` INFO (existing record exists or not —
  the audit row is about the event, not the address).
- **Idempotency** n/a; rate class `auth`.

### A-6…A-9. MFA — `POST /api/v1/auth/mfa/enroll` · `POST /api/v1/auth/mfa/challenge` · `GET /api/v1/auth/mfa/factors` · `POST /api/v1/auth/mfa/unenroll`

- **AuthN/AuthZ** all `required` · `user:update` (SELF — one's own factors;
  enrollment completes with challenge+verify inside `enroll`'s handler pair),
  unenroll of a staff factor requires an `aal2` session.
- **Input/Output** `enroll` `{ factorType: 'TOTP' }` → `200` `{ factorId,
totp: { qrCodeUri, secret } }` (secret shown once, never persisted
  plaintext, never returned again); `challenge` `{ code: 6-digit }` → `200`
  `{ redirectTo }` with the session upgraded to `aal2`; `factors` → `200`
  `{ factors: [{ id, factorType, enrolledAt, status }] }` (never the secret);
  `unenroll` `{ factorId, code }` → `204`.
- **Errors** `401 INVALID_CREDENTIALS`-family for wrong codes (GoTrue enforces
  attempt limits) · `403 MFA_REQUIRED` where aal2 is demanded · `409` for a
  second live factor of the same type.
- **Audit** `MFA_ENROLLED` / `MFA_REMOVED` NOTICE; challenge failures piggyback
  `LOGIN_FAILED` accounting.
- **Idempotency** n/a; rate class `sensitive`.

---

## B. Self, users and account lifecycle

Backing tables: `profiles`, `organization_memberships`,
`platform_role_grants`. The "users" resource is _people_ — global rows whose
reach is per-tenant; the matrix cells are `user:*` (authorization §B.1).

### B-1. `GET /api/v1/me`

- **AuthN/AuthZ** `required` · `user:read` (`● ● ◑ ◑`) · tenant ← the
  actor's first `ACTIVE` membership org (resolver returns `undefined` for
  staff, so the GLOBAL cells answer; a CLIENT with no live membership gets
  the profile-only shape below) · AAL 1.
- **Input** none.
- **Output** `200` `{ user: SelfUserDTO, memberships: MembershipSelfDTO[],
platformRole: 'SUPER_ADMIN' | 'ADMIN' | null }`. `SelfUserDTO` is the
  caller's own row in full (`id, email, fullName, displayName, jobTitle,
avatarPath, userType, accountStatus, mfaEnrolledAt, lastSeenAt,
createdAt`). Each `MembershipSelfDTO`: `{ id, organizationId,
organizationSlug, organizationDisplayName, role, status, isPrimaryContact,
joinedAt }` — the slug is included so the portal can build
  `/portal/[orgSlug]` without a second round trip.
- **Page/filter/sort** —.
- **Errors** global only.
- **Validation** —.
- **Audit** none (self-read).
- **Idempotency** n/a; rate class `read`. **Note:** this endpoint is the
  portal's tenant directory — clients discover their organizations here, not
  through a list endpoint ([§E](#e-clients)).

### B-2. `PATCH /api/v1/me`

- **AuthN/AuthZ** `required` · `user:update` (`● ●[R] ◦ ◦`) · SELF — caller
  is the subject; the `[R]` on ADMIN governs _others'_ accounts (status
  writes), not self display fields · AAL 1.
- **Input** body, all optional, ≥ 1: `{ fullName?≤120, displayName?≤80,
jobTitle?≤120, avatarPath?≤512, timezone?≤64 }`. `avatarPath` must be a
  storage path under the caller's reachable org prefix (validated; the
  avatar upload itself is the file flow of [§L](#l-files) with `fileKind:
AVATAR`).
- **Output** `200` `SelfUserDTO`.
- **Errors** `422 empty_update` · `409` email-change attempts are not a field
  here — email is immutable from the API (authentication §10) and is not in
  the schema, so this is a 422 unknown-key, by design.
- **Validation** strict; trim; length caps mirror column CHECKs.
- **Audit** `UPDATE` · profile · INFO · `changed_fields` names only.
- **Idempotency** naturally (last-write-wins partial update).

### B-3. `GET /api/v1/users`

- **AuthN/AuthZ** `required` · `user:read` · tenant ← `organizationId` query
  — **mandatory for CLIENT actors** (422 `organization_required` if absent),
  optional for staff (omitting it is the cross-tenant directory read) · AAL 1.
- **Input** query: `organizationId? uuid` · `ids? csv(uuid, ≤50)` ·
  `userType? INTERNAL|CLIENT` (staff-only; 422 for clients — they cannot
  filter the staff roster into view) · pagination.
- **Output** `200` list envelope of `UserSummaryDTO`. Staff audience:
  `{ id, fullName, displayName, avatarPath, jobTitle, userType, email,
accountStatus, lastSeenAt }`; client audience — exactly the granted
  columns plus the id (authorization §F.1): `{ id, fullName, displayName,
avatarPath, jobTitle }`. No `email`, no `userType`, no `lastSeenAt`, no
  phone or MFA fields of other people; the client directory does not
  distinguish staff from co-members, because the grant says it must not.
- **Page/filter/sort** keyset: default `fullName:asc` (key = lower-cased
  full name; implementation adds the supporting index), alternate
  `createdAt:desc`. Filters as Input; the directory for an org = its members
  plus staff identities on its work (RLS `shares_org_with()`), never the
  whole staff roster for client callers.
- **Errors** `404`-shaped empties are `200 []` — no 404 for lists.
- **Validation** csv caps; uuid shapes; `userType` restriction above.
- **Audit** none (read); cross-tenant staff reads are log-visible ([§11](#11-logging-strategy)).
- **Idempotency** n/a; rate class `read`.

### B-4. `GET /api/v1/users/{userId}`

- **AuthN/AuthZ** `required` · `user:read` · tenant ← **shared-org resolver**:
  staff resolve `undefined` (GLOBAL cells); a CLIENT actor resolves the first
  organization where _both_ actor and target hold live memberships — through
  the caller's own RLS, so invisible ⇒ `null` ⇒ 404 · AAL 1.
- **Input** path `userId` uuid.
- **Output** `200` `UserSummaryDTO` (audience-shaped as B-3) plus, for staff,
  `memberships: [{ organizationId, role, status }]` and the target's
  `platformRole` presence (`true`/`false` for ADMIN viewers, full value for
  SUPER_ADMIN — the roster of power is SUPER_ADMIN-only, authorization §B.1).
- **Errors** `404` (unknown _or_ not connected to the caller's tenant).
- **Validation** uuid path.
- **Audit** none. **Idempotency** n/a; rate class `read`.

### B-5…B-8. Account lifecycle — `POST /api/v1/accounts/{userId}/suspend` · `/reinstate` · `/deactivate` · `/reactivate` · _implemented, Phase 3_

- **AuthN/AuthZ** `required` · `user:update` · `subjectUser` ← path ·
  handler additionally demands a platform role (clients may only ever reach
  the SELF branch, which these transitions are not); **`reactivate` is
  SUPER_ADMIN-only** and gains `minAal: 2` in the Phase 5 implementation
  retrofit.
- **Input** body `{ reason: string≤500 }` required. **Output** `200`
  `{ accountStatus }`.
- **Errors** `409 invalid_transition` for a status the account does not hold
  (e.g. reinstating an `ACTIVE` account) · `403` ADMIN-altering-SUPER_ADMIN
  backstop.
- **Audit** `STATUS_CHANGE` · profile · NOTICE (CRITICAL for `reactivate`),
  `before/after = {accountStatus}`; suspension/deactivation additionally
  revoke all sessions and set the GoTrue ban (authentication §8).
- **Idempotency** tier 1 (repeat ⇒ 409 naming the current status); rate
  class `sensitive`.

### B-9. `POST /api/v1/admin/users/{userId}/erase`

- **AuthN/AuthZ** `required` · `user:delete` (`●[R] ✗ ✗ ✗`) · SUPER_ADMIN
  only by cell · `minAal: 2` · no tenant (global row).
- **Input** body `{ reason: string≤500 }` required (GDPR erasure demands the
  record of why).
- **Output** `204`. The RPC `erase_user(p_user_id, p_reason)` hard-deletes
  the auth identity; the profile cascades; audit rows survive by design (no
  FK, Phase 2).
- **Errors** `403` self-erasure while signed in (RPC refuses) · `404`
  unknown user · `422` missing reason. **Implementation obligation:** the
  current RPC does not refuse erasing the platform's _last_ live
  SUPER_ADMIN; the Phase 5 service layer must check live grants before
  calling it and answer `409 last_super_admin` — recorded here so the gap is
  closed by the endpoint, not discovered by it.
- **Validation** uuid + reason required.
- **Audit** `UPDATE` · profile · CRITICAL — written by the RPC before the
  erasure; the after-blob names the erased columns, never their values.
- **Idempotency** tier 1 (repeat ⇒ 404); rate class `sensitive`.

---

## C. Authorization and access management

"Authorization" as an API surface = the endpoints that change _who holds what
access_: invitations (pre-membership ledger), organization memberships,
platform role grants, and internal team staffing. All writes here are
RPC-backed or CRITICAL-audited; that is the design, not an accident
(authorization §C).

### C-1. `POST /api/v1/invitations` · _implemented, Phase 3_

- **AuthN/AuthZ** `required` · `invitation:create` (`● ● ◑ ✗`) · tenant ←
  body `organizationId` for the client branch; `undefined` for the staff
  branch (GLOBAL cells answer; TENANT cells cannot) · AAL 1.
- **Input** body `{ email, fullName?, organizationId? uuid,
organizationRole? 'CLIENT_MEMBER', platformRole? 'SUPER_ADMIN'|'ADMIN',
message?≤500 }` strict — exactly one branch (XOR refine mirroring the
  `invitations_exactly_one_branch` CHECK). **CLIENT_ADMIN callers may only
  ever send the `CLIENT_MEMBER` branch** — anything else is 422
  `role_ceiling` before the RPC could see it.
- **Output** `201` `InvitationDTO` `{ id, email, organizationId | null,
organizationRole | null, platformRole | null, status: 'PENDING',
invitedBy, expiresAt, resentCount, lastSentAt, createdAt }` + `Location`.
  Never the token, never `token_hash` (not granted at GRANT level).
- **Errors** `409` confirmed person already exists (routed to status flows) ·
  re-issue of an unconfirmed address is _not_ a conflict — it updates the
  pending row and returns it (implemented behaviour).
- **Audit** `INVITE_SENT` — NOTICE (client) / CRITICAL (staff branch).
- **Idempotency** tier 2 (unique pending index answers blind retries).

### C-2. `GET /api/v1/invitations`

- **AuthN/AuthZ** `required` · `invitation:read` (`● ● ◑ ✗`) · tenant ←
  `organizationId` query — mandatory for CLIENT_ADMIN (422 if absent),
  optional for staff · AAL 1.
- **Input** query: `organizationId? uuid` · `status? csv(PENDING|ACCEPTED|
EXPIRED|REVOKED)` · pagination.
- **Output** `200` list envelope of `InvitationDTO` (as C-1, minus
  `message`? — no: `message` is included, it is the inviter's note; the
  token hash is the only withheld field).
- **Page/filter/sort** default `createdAt:desc`, alternate `expiresAt:asc`.
- **Errors** global. **Validation** enum labels; csv cap.
- **Audit** none. **Idempotency** n/a; rate class `read`.

### C-3. `GET /api/v1/invitations/{invitationId}`

- **AuthN/AuthZ** `required` · `invitation:read` · tenant ← **row** (loaded
  through the caller's RLS; invisible ⇒ 404; the implemented resend route
  already uses this resolver pattern) · AAL 1.
- **Input** path uuid. **Output** `200` `InvitationDTO`.
- **Errors** `404`. **Audit** none. Rate class `read`.

### C-4. `POST /api/v1/invitations/{invitationId}/resend` · _implemented_

- **AuthN/AuthZ** `required` · `invitation:update` (`● ● ◑ ✗`) · tenant ←
  row · AAL 1. **Input** none. **Output** `200` updated `InvitationDTO`
  (fresh `expiresAt`, bumped `resentCount`).
- **Errors** `409 invitation_state` unless `PENDING` (accepted/revoked/expired
  rows refuse). **Audit** `INVITE_SENT` (as C-1). Idempotency tier 1.

### C-5. `POST /api/v1/invitations/{invitationId}/revoke` · _implemented_

- **AuthN/AuthZ** `required` · `invitation:update` · tenant ← row · AAL 1.
- **Input** none. **Output** `200` `InvitationDTO` with `status: 'REVOKED'`.
- **Errors** `409 invitation_state` unless `PENDING`. **Audit** `UPDATE` ·
  invitation · NOTICE — revocation is the off-switch of a pending grant;
  the acceptance RPC then refuses by status.
- **Idempotency** tier 1. Rate class `sensitive`.

### C-6. `GET /api/v1/organizations/{organizationId}/members`

- **AuthN/AuthZ** `required` · `membership:read` (`● ● ◑ ◑`) · tenant ←
  path · AAL 1.
- **Input** path org uuid; query: `status? csv(INVITED|ACTIVE|SUSPENDED|
DEACTIVATED)` · `role? csv(CLIENT_ADMIN|CLIENT_MEMBER)` · pagination.
- **Output** `200` list envelope of `MemberDTO` `{ id (membership id),
userId, fullName, displayName, avatarPath, jobTitle, role, status,
isPrimaryContact, invitedBy, joinedAt }` — name fields resolved from
  `profiles` via the same column-restricted join the directory uses.
- **Page/filter/sort** default `createdAt:asc` (join order = roster order).
- **Errors** `404` org unreachable. **Audit** none. Rate class `read`.

### C-7. `POST /api/v1/organizations/{organizationId}/members`

- **AuthN/AuthZ** `required` · `organization:manage_members`
  (`● ● ◑[R] ✗`) — the composite route capability (authorization §1.1); the
  decomposed `membership:create` is what the RPC and RLS see · tenant ←
  path · AAL 1.
- **Input** body `{ userId: uuid, role: 'CLIENT_MEMBER' | 'CLIENT_ADMIN',
jobTitle?≤120 }` strict — maps 1:1 to
  `add_organization_member(p_organization_id, p_user_id, p_role,
p_job_title)`. New _people_ arrive through invitations (C-1); this
  endpoint adds an **existing user** to a tenant.
- **Output** `201` `MemberDTO` + `Location`.
- **Errors** `404` org/target unreachable · `409` live membership exists ·
  `409 role_ceiling` — a CLIENT_ADMIN caller sending `CLIENT_ADMIN` is
  refused by the RPC (and pre-refused at validation) · `409 self_addition`
  — the RPC refuses to add the caller to their own tenant · `409
not_a_client_profile` — the target must be a live CLIENT profile (staff
  join teams, not organizations).
- **Validation** role enum; target `userType` must be CLIENT (RPC-enforced;
  `enforce_membership_user_type` is the last wall).
- **Audit** `CREATE` · organization_membership · **CRITICAL** — the
  cross-org edge is always CRITICAL; written inside the RPC transaction.
- **Idempotency** tier 2 (one-live-membership index answers retries). Rate
  class `sensitive`.

### C-8. `PATCH /api/v1/organizations/{organizationId}/members/{membershipId}`

- **AuthN/AuthZ** `required` · `organization:manage_members` · tenant ←
  path · AAL 1.
- **Input** body, ≥ 1: `{ role?, status?, isPrimaryContact?,
newPrimaryMembershipId?, jobTitle? }` — maps to
  `update_organization_member(p_membership_id, …)`.
- **Output** `200` updated `MemberDTO`.
- **Errors** `409 last_admin` (removing/demoting the last live
  CLIENT_ADMIN) · `409 primary_contact_replacement_required` ·
  `409 self_modification` (a CLIENT_ADMIN editing their own membership row)
  · `409 invalid_transition` for membership status moves the RPC refuses ·
  `409 role_ceiling` (CLIENT_ADMIN may only ever _set_ CLIENT_MEMBER).
- **Audit** `UPDATE` · organization_membership · CRITICAL (cross-org edge).
- **Idempotency** naturally. Rate class `sensitive`.

### C-9. `DELETE /api/v1/organizations/{organizationId}/members/{membershipId}`

- **AuthN/AuthZ** `required` · `organization:manage_members` · tenant ←
  path · AAL 1.
- **Input** query `newPrimaryMembershipId? uuid` (required when removing the
  primary contact) + `reason?≤500` body — maps to
  `remove_organization_member(p_membership_id, p_new_primary_membership_id,
p_reason)`.
- **Output** `204`.
- **Errors** `409 last_admin` · `409 primary_contact_replacement_required` ·
  `409 self_modification` · `404` membership invisible.
- **Audit** `SOFT_DELETE` · organization_membership · CRITICAL.
- **Idempotency** tier 1. Rate class `sensitive`.

### C-10. `GET /api/v1/admin/platform-grants`

- **AuthN/AuthZ** `required` · `platform_grant:read` (`● ◦ ✗ ✗`) · no
  tenant (global) · AAL 1. SUPER_ADMIN sees the full ledger; ADMIN sees
  **only their own grant row** — enforced by the service layer filtering on
  `userId = auth.userId` when `platformRole === 'ADMIN'`, mirroring the ◦
  cell.
- **Input** query: `userId? uuid` (SUPER_ADMIN only; 422 for ADMIN — they
  cannot probe others) · `includeRevoked? boolean` · pagination.
- **Output** `200` list envelope of `PlatformGrantDTO` `{ id, userId,
fullName, role, grantedBy, grantedAt, expiresAt, revokedAt, revokedBy,
revokeReason }`.
- **Page/filter/sort** default `grantedAt:desc`.
- **Audit** none. Rate class `read`.

### C-11. `POST /api/v1/admin/platform-grants`

- **AuthN/AuthZ** `required` · `platform_grant:create` (`●[R] ✗ ✗ ✗`) ·
  SUPER_ADMIN by cell · **`minAal: 2`** · no tenant.
- **Input** body `{ userId: uuid, role: 'SUPER_ADMIN'|'ADMIN', reason:
string≤500, expiresAt?: timestamp }` strict — maps to
  `grant_platform_role(p_user_id, p_role, p_reason, p_expires_at)`. Both
  platform roles are grantable here; granting `SUPER_ADMIN` is the single
  most powerful operation in the API and is treated accordingly — mandatory
  reason, `minAal: 2`, CRITICAL audit, and the RPC's refusal of CLIENT
  profiles is the backstop. The per-user one-live-grant invariant belongs to
  the RPC, not the caller.
- **Output** `201` `PlatformGrantDTO` + `Location`.
- **Errors** `409 grant_exists` — the target already holds a live grant;
  revoke first · `409 not_an_internal_profile` — CLIENT profiles hold
  organization roles, not platform grants · `404` target user not found.
- **Audit** `ROLE_GRANT` · CRITICAL — inside the RPC transaction.
- **Idempotency** tier 2 (one-live-grant invariant answers retries). Rate
  class `sensitive`.

### C-12. `POST /api/v1/admin/platform-grants/{userId}/revoke`

- **AuthN/AuthZ** `required` · `platform_grant:delete` (`●[R] ✗ ✗ ✗`) ·
  **`minAal: 2`**.
- **Input** body `{ reason: string≤500 }` — maps to
  `revoke_platform_role(p_user_id, p_reason)`; the grant row is _updated_
  (`revoked_at`), never deleted.
- **Output** `204`. Effect is immediate at the next `auth_context()`
  resolution (ADR-0011: no token rewrite needed or possible).
- **Errors** `409 last_super_admin` — the RPC refuses to revoke the
  platform's final SUPER_ADMIN grant · `409 grant_not_live` when the target
  holds no live grant.
- **Audit** `ROLE_REVOKE` · CRITICAL. **Idempotency** tier 1. Rate class
  `sensitive`.

### C-13. `GET /api/v1/admin/teams`

- **AuthN/AuthZ** `required` · `team_membership:read` (`● ● ✗ ✗`) — internal
  structure; no client cell exists · no tenant · AAL 1.
- **Output** `200` `{ teams: [{ team, label, memberCount, leads: [userId] }] }`
  — one object per seeded team (no pagination: seven rows, reference-shaped).
- **Audit** none. Rate class `read`.

### C-14. `GET /api/v1/admin/teams/{team}/members`

- **AuthN/AuthZ** `required` · `team_membership:read` · no tenant · AAL 1.
- **Input** path `team` — an enum label (`SEO`, `PAID_MEDIA`, …), validated
  against the `team` enum (422 otherwise).
- **Output** `200` list envelope of `TeamMembershipDTO` `{ id, userId,
fullName, avatarPath, team, isLead, allocationPct, createdAt }`.
- **Page/filter/sort** default `createdAt:asc`; filter `isLead? boolean`.
- **Audit** none. Rate class `read`.

### C-15. `POST /api/v1/admin/team-memberships`

- **AuthN/AuthZ** `required` · `team_membership:create` (`● ● ✗ ✗`) · AAL 1.
- **Input** body `{ userId: uuid, team: TeamEnum, isLead?: boolean,
allocationPct?: int 0–100 }` strict.
- **Output** `201` `TeamMembershipDTO` + `Location`.
- **Errors** `409` duplicate live membership (user×team) · `404` target user
  not INTERNAL (RPC-free check: the service loads the profile through RLS;
  `enforce_staff_user_type` is the DB wall).
- **Audit** `CREATE` · staff_team_membership · INFO.
- **Idempotency** tier 2. Rate class `mutation`.

### C-16. `PATCH /api/v1/admin/team-memberships/{membershipId}`

- **AuthN/AuthZ** `required` · `team_membership:update` · AAL 1.
- **Input** body ≥ 1: `{ isLead?, allocationPct? }`. `team` and `userId` are
  immutable — changing them is delete-and-recreate, audited as such.
- **Output** `200` `TeamMembershipDTO`. **Errors** `409` second lead where a
  lead already exists, if the schema's partial index says so (mapped from the
  constraint). **Audit** `UPDATE` · INFO. Idempotency natural.

### C-17. `DELETE /api/v1/admin/team-memberships/{membershipId}`

- **AuthN/AuthZ** `required` · `team_membership:delete` · AAL 1.
- **Output** `204` · SOFT-DELETE pattern · rate class `mutation`.

---

## D. Organizations

Backing tables: `organizations`, `organization_settings`. The tenant root —
every rule about `organization_id` derivation exists because of this resource.

### D-1. `POST /api/v1/organizations`

- **AuthN/AuthZ** `required` · `organization:create` (`● ● ✗ ✗`) · no
  tenant (this _is_ a tenant being born) · AAL 1.
- **Input** body `{ slug: slug≤64, displayName≤120, legalName?≤200,
region: 'NYC'|'LDN'|'SYD'|'DIFC', industry?≤80, websiteUrl?≤2048,
status?: org_status default 'PROSPECT', primaryCurrency?: currency_code,
accountManagerUserId?: uuid }` strict, with an `Idempotency-Key`.
- **Output** `201` `OrganizationDTO` `{ id, slug, displayName, legalName,
region, industry, websiteUrl, status, primaryCurrency,
accountManagerUserId, onboardedAt, churnedAt, organizationId (=== id),
createdAt }` + `Location`. The settings row is trigger-created
  (`create_organization_settings`) with defaults and readable via D-7.
- **Errors** `409 duplicate_code` slug collision (partial unique index —
  reusable after soft delete).
- **Validation** slug matches the DB shape CHECK — 3–64 chars, lowercase
  alphanumerics and single hyphens (the shared `slugField` is passed the
  DB's minimum, not its generic one); region/currency enums; account manager
  must be an INTERNAL profile (service-checked).
- **Audit** `CREATE` · organization · **CRITICAL** (a tenant is born;
  `before` empty, `after` = the public fields).
- **Idempotency** tier 3 — key **required**. Rate class `mutation`.

### D-2. `GET /api/v1/organizations`

- **AuthN/AuthZ** `required` · `organization:read` (`● ● ◑ ◑`) · **no
  tenant parameter** — staff get the cross-tenant list (GLOBAL cells); a
  CLIENT actor receives `403` by the matrix and uses `GET /api/v1/me`
  instead ([§E](#e-clients)). AAL 1.
- **Input** query: `status? csv(org_status)` · `region? csv(region_code)` ·
  `accountManagerUserId? uuid` · pagination.
- **Output** `200` list envelope of `OrganizationDTO`.
- **Page/filter/sort** default `displayName:asc` (indexed), alternate
  `createdAt:desc`. Filters map to existing indexes (status, region,
  account manager).
- **Errors** global. **Audit** none. Rate class `read`.

### D-3. `GET /api/v1/organizations/{organizationId}`

- **AuthN/AuthZ** `required` · `organization:read` · tenant ← path · AAL 1.
- **Output** `200` `OrganizationDTO`. Organizations carry no
  column-restricted fields, so the staff and client shapes are identical —
  the audience split costs nothing and keeps the mapper uniform.
- **Errors** `404`. Rate class `read`.

### D-4. `PATCH /api/v1/organizations/{organizationId}`

- **AuthN/AuthZ** `required` · `organization:update` (`● ● ✗ ✗`) — legal
  name, region and status are contractual facts; clients cannot edit them ·
  tenant ← path · AAL 1.
- **Input** body ≥ 1: `{ displayName?, legalName?, region?, industry?,
websiteUrl?, primaryCurrency? }`. **Status changes are NOT PATCH fields** —
  `POST …/status` below — and **`accountManagerUserId` is not either**: it is
  the ASSIGN verb (D-9), which has its own capability cell.
- **Output** `200` `OrganizationDTO`.
- **Errors** `409` currency change while live engagements carry a different
  currency (mapped from the engagement-currency CHECK) · `404`.
- **Audit** `UPDATE` · organization · NOTICE · changed-field diff.
- **Idempotency** natural. Rate class `mutation`.

### D-5. `POST /api/v1/organizations/{organizationId}/status`

- STATUS-TRANSITION-shaped action — **with one declared difference:** Phase 2
  seeded `status_transitions` for exactly five entity kinds (engagement,
  service, project, deliverable, task) and its validator _rejects_ any other
  (`status_transitions: organization has no status machine`). Organizations
  therefore have an **application-level graph**, defined as data in the
  Phase 5 state-machine module: `PROSPECT → ONBOARDING → ACTIVE ⇄ PAUSED`,
  `ACTIVE|PAUSED → CHURNED → ARCHIVED`. Capability `organization:update` ·
  tenant ← path.
- **Input** `{ status, reason?≤500 }` — `reason` is _required_ for
  `→ CHURNED` and `→ ARCHIVED` (422 otherwise). `churnedAt`/`onboardedAt`
  stamping is the service layer honouring the transition; the
  `CHURNED ⇒ churned_at` CHECK is the database's backstop.
- **Errors** `409 invalid_transition` (detail carries `currentStatus`).
- **Audit** `STATUS_CHANGE` · organization · NOTICE (CRITICAL for
  `→ ARCHIVED`: a tenant leaving the active set is a trust event).
- **Implementation decision point, recorded honestly:** extending
  `status_transitions` and its enforcement trigger to `organization` is a
  migration touching the validator's entity-kind CASE — an owner decision at
  implementation time, not a design assumption. Until then the app-level
  graph plus audit is the control; nothing about RLS or write paths depends
  on it.
- **Idempotency** tier 1; rate class `mutation`.

### D-6. `DELETE /api/v1/organizations/{organizationId}`

- **AuthN/AuthZ** `required` · `organization:delete` (`●[R] ✗ ✗ ✗`) ·
  SUPER_ADMIN by cell · **`minAal: 2`** · tenant ← path.
- **Input** body `{ reason: string≤500, confirmSlug: string }` — `confirmSlug`
  must equal the organization's slug, purge-style confirmation.
- **Execution** through the definer RPC `archive_organization(
p_organization_id, p_reason, p_confirm_slug)` — **the one new RPC Phase 5
  adds to the closed set** ([ADR-0029](adr/ADR-0029-archive-organization-definer-rpc.md),
  Proposed): it audits first (`HARD_DELETE`-adjacent CRITICAL row), sets
  `deleted_at/deleted_by`, cascades the soft delete to live memberships, and
  refuses organizations holding live engagements (409 `has_active_children`).
- **Output** `204`. **Errors** `404` · `409 has_active_children` · `409
confirm_slug_mismatch`.
- **Audit** `SOFT_DELETE` · organization · CRITICAL (inside the RPC).
- **Idempotency** tier 1; rate class `sensitive`.

### D-7. `GET /api/v1/organizations/{organizationId}/settings`

- **AuthN/AuthZ** `required` · `organization:read` — _reading_ settings is a
  read of the tenant row's companion, not a settings change (the `manage_`
  capability is reserved for the write; both CLIENT roles may read their
  own settings, authorization §G) · tenant ← path · AAL 1.
- **Output** `200` `OrganizationSettingsDTO` `{ organizationId,
brandPrimaryColor, logoFileId, defaultReportCadence,
notifyOnDeliverableReady, notifyOnReportPublished,
requireApprovalForPublish, timezone, updatedAt }`.
- **Errors** `404`. **Audit** none. Rate class `read`.

### D-8. `PUT /api/v1/organizations/{organizationId}/settings`

- **AuthN/AuthZ** `required` · `organization:manage_settings`
  (`● ● ◑ ✗`) · tenant ← path · AAL 1. PUT (full replace) because settings
  are a policy document — a partial edit of one notification flag should not
  silently carry another caller's half-written state.
- **Input** body = the full `OrganizationSettingsDTO` minus `organizationId`
  and `updatedAt`, all fields required; `logoFileId` must reference a file
  row in this same organization (composite-checked by the service).
- **Output** `200` `OrganizationSettingsDTO`.
- **Errors** `422` any missing field · `409` logo file not visible in tenant.
- **Audit** `UPDATE` · organization_settings · NOTICE.
- **Idempotency** natural (PUT). Rate class `mutation`.

### D-9. `POST /api/v1/organizations/{organizationId}/assign`

- ASSIGN pattern · capability `organization:assign` (`● ● ✗ ✗`) · tenant ←
  path · AAL 1.
- **Input** body `{ accountManagerUserId: uuid }` — must reference an
  `ACTIVE` INTERNAL profile (service check; the accountable account manager
  is an internal staffing fact).
- **Output** `200` `OrganizationDTO`. **Errors** `404` org or manager
  unreachable · `409` target is a CLIENT profile.
- **Audit** `UPDATE` · organization · INFO. Idempotency natural. Rate class
  `mutation`.

---

## E. Clients

**There is no `clients` resource, and there is deliberately no client API.**
In the Growlith domain a _client_ is an organization — the tenant root —
viewed by people whose roles (`CLIENT_ADMIN`, `CLIENT_MEMBER`) are scoped to
it. Inventing a `/api/v1/clients` surface would create a second copy of the
authorization model in URL form, and the second copy is always the one that
is wrong (authorization §K). The brief's "clients" requirement is therefore
satisfied by stating, precisely, how CLIENT actors experience the catalogue:

1. **Discovery.** A client user's tenants come from `GET /api/v1/me`
   (B-1), which carries organization ids, slugs, roles and statuses. There
   is no client-facing organization list endpoint — `GET /organizations`
   answers them 403 by matrix.
2. **Reads.** Every `◑`/`◒` list and detail endpoint in this catalogue is
   callable by client actors _with their own `organizationId`_; the matrix,
   the column grants and RLS narrow the result: engagements minus money,
   services minus fees, visible projects, strictly-gated deliverables,
   published reports, clean visible files, non-internal comments on visible
   subjects, own notifications. The DTO mapper emits the client-shaped DTO
   automatically ([§5](#5-response-and-dto-conventions)) — the client never
   receives a superset to filter.
3. **Writes — the complete list** (authorization §E.2): comments on visible
   projects/deliverables (M-1); file upload/register/download of own or
   visible files (L-2…L-5); the deliverable approve transition (J-8,
   CLIENT_ADMIN only, RPC); organization settings (D-8, CLIENT_ADMIN);
   member management limited to CLIENT_MEMBER grants (C-7…C-9, CLIENT_ADMIN,
   RPC ceilings); invitations for CLIENT_MEMBER seats (C-1…C-5, CLIENT_ADMIN);
   own notification flags (N-3); own profile (B-2). **Nothing else.** Any
   other mutation is 403/404 for a client actor by construction.
4. **Tasks are unnameable.** No client capability exists on `task`, so no
   task endpoint can answer a client caller — the API returns 404 for
   tenant-unreachable context and 403 for capability denial; either way the
   internal work stream is unaddressable from the portal.
5. **Activity** is the projected feed (O-2), never the audit table.

Phase 9's portal is a consumer of exactly this section; no endpoint exists
_for_ the portal that the admin surface does not also use.

---

## F. Engagements

Backing table: `engagements` (21 columns; `contract_value`,
`monthly_retainer`, `notes_internal` are column-restricted from clients).

### F-1. `POST /api/v1/organizations/{organizationId}/engagements`

- **AuthN/AuthZ** `required` · `engagement:create` (`● ● ✗ ✗`) · tenant ←
  path · AAL 1.
- **Input** body `{ code: bounded 2–32 (unique per org), name≤120,
engagementType: 'RETAINER'|'PROJECT'|'ADVISORY', currency: currency_code,
contractValue?: money, monthlyRetainer?: money, startDate: date,
endDate?: date, renewalDate?: date, accountManagerUserId?: uuid,
notesInternal?≤4000 }` strict + `Idempotency-Key`.
- **Output** `201` `EngagementDTO` + `Location`. Staff shape: `{ id,
organizationId, code, name, engagementType, status, currency,
contractValue, monthlyRetainer, startDate, endDate, renewalDate,
accountManagerUserId, signedAt, notesInternal, createdAt, updatedAt }`;
  client shape drops exactly the three column-restricted fields —
  `contractValue`, `monthlyRetainer`, `notesInternal` — not by filtering
  the response but by the client mapper accepting only the
  column-restricted row type (authorization §I.5).
- **Errors** `409 duplicate_code` · `404` org unreachable.
- **Validation** period order (`startDate ≤ endDate`, renewal ≥ start);
  money via `moneyField`; `monthlyRetainer` implies `engagementType =
RETAINER` (refine, mirroring the DB CHECK); account manager must be
  INTERNAL.
- **Audit** `CREATE` · engagement · NOTICE.
- **Idempotency** tier 3 — key **required**. Rate class `mutation`.

### F-2. `GET /api/v1/engagements`

- **AuthN/AuthZ** `required` · `engagement:read` (`● ● ◑[C] ◑[C]`) ·
  tenant ← `organizationId` query (mandatory for CLIENT actors) · AAL 1.
- **Input** query: `organizationId? uuid` · `status? csv(engagement_status)`
  · `engagementType? csv` · `accountManagerUserId? uuid` · pagination.
- **Output** `200` list envelope, audience-shaped `EngagementDTO`.
- **Page/filter/sort** default `createdAt:desc`, alternates `startDate:desc`,
  `renewalDate:asc` (renewal-pipeline view). All four columns indexed.
- **Errors** global. **Audit** none. Rate class `read`.

### F-3. `GET /api/v1/engagements/{engagementId}`

- **AuthN/AuthZ** `required` · `engagement:read` · tenant ← **row** · AAL 1.
- **Output** `200` audience-shaped `EngagementDTO`. **Errors** `404`. Rate
  class `read`.

### F-4. `PATCH /api/v1/engagements/{engagementId}`

- **AuthN/AuthZ** `required` · `engagement:update` (`●[S] ●[S] ✗ ✗`) ·
  tenant ← row · AAL 1. The `[S]` arrives as a `STATE_MACHINE` obligation —
  but **PATCH never carries `status`**; this pattern's contract is that
  mutable fields and transitions are separate surfaces.
- **Input** body ≥ 1: `{ name?, currency?, contractValue?, monthlyRetainer?,
startDate?, endDate?, renewalDate?, accountManagerUserId?,
notesInternal? }`.
- **Output** `200` updated `EngagementDTO` (staff shape only — clients hold
  no `update` cell, so no client mapper is reachable here).
- **Errors** `409` constraint conflicts (period order, retainer/type CHECK,
  currency vs. child services) · `404`.
- **Audit** `UPDATE` · engagement · NOTICE · changed-field diff (diff built
  from the staff view; internal-only values are legitimate content of an
  internal audit).
- **Idempotency** natural. Rate class `mutation`.

### F-5. `POST /api/v1/engagements/{engagementId}/status`

- STATUS-TRANSITION over `engagement_status` (`DRAFT → PENDING_SIGNATURE →
ACTIVE ⇄ PAUSED → COMPLETED | CANCELLED`; the reopening transitions
  `ACTIVE|PAUSED → CANCELLED` seeded SUPER_ADMIN-only are honoured via
  `allowed_roles`). Capability `engagement:update` `[S]` · tenant ← row.
- **Input** `{ status, reason?≤500 }`; `signedAt` is stamped by the service
  on the `PENDING_SIGNATURE → ACTIVE` transition.
- **Errors** `409 invalid_transition` (detail carries `currentStatus`).
- **Audit** `STATUS_CHANGE` · INFO (CRITICAL where the transition row marks
  the reopening class). Idempotency tier 1. Rate class `mutation`.

### F-6. `DELETE /api/v1/engagements/{engagementId}`

- **AuthN/AuthZ** `required` · `engagement:delete` (`● ● ✗ ✗`) · tenant ←
  row · AAL 1. SOFT-DELETE pattern; refuses while live services exist (409
  `has_active_children`).
- **Audit** `SOFT_DELETE` · NOTICE. Rate class `mutation`.

### F-7. `POST /api/v1/engagements/{engagementId}/assign`

- ASSIGN pattern · capability `engagement:assign` (`● ● ✗ ✗`) · body
  `{ accountManagerUserId: uuid }` (must be INTERNAL and ACTIVE — service
  check; RLS write policy is the wall). **Output** `200` `EngagementDTO`.
- **Audit** `UPDATE` · INFO. Idempotency natural. Rate class `mutation`.

---

## G. Services

Backing table: `services` (`fee`, `fee_model` column-restricted). A service
is a _purchased instance_ of a service line under an engagement (ADR-0006);
the catalogue itself (`service_lines`) is seeded reference data compiled into
`src/lib/domain` — it has no write surface in v1.

### G-1. `POST /api/v1/engagements/{engagementId}/services`

- **AuthN/AuthZ** `required` · `service:create` (`● ● ✗ ✗`) · tenant ←
  parent engagement row (loaded through the caller's RLS) · AAL 1.
- **Input** body `{ serviceLine: service_line enum, name≤120,
scopeSummary?≤2000, currency?: currency_code (defaults to the
engagement's), fee?: money, feeModel?: 'RETAINER'|'FIXED'|'HOURLY'|
'PERFORMANCE', startDate?: date, endDate?: date, deliveringTeam?: team
enum (defaults via `SERVICE_LINE_DEFAULT_TEAM`), leadUserId?: uuid }`
  strict + `Idempotency-Key`.
- **Output** `201` `ServiceDTO` `{ id, organizationId, engagementId,
serviceLine, serviceLineLabel, deliveringTeam, name, scopeSummary, status,
currency, fee?, feeModel?, startDate, endDate, leadUserId, createdAt,
updatedAt }` + `Location`. Client shape drops `fee`/`feeModel` (grants).
- **Errors** `404` engagement unreachable · `409` currency disagreement with
  the engagement (mapped from `enforce_service_currency`).
- **Audit** `CREATE` · service · NOTICE. **Idempotency** tier 3 — key
  **required**. Rate class `mutation`.

### G-2. `GET /api/v1/services`

- **AuthN/AuthZ** `required` · `service:read` (`● ● ◑[C] ◑[C]`) · tenant ←
  `organizationId` query (mandatory for CLIENT actors) · AAL 1.
- **Input** query: `organizationId? uuid` · `engagementId? uuid` ·
  `serviceLine? csv` · `status? csv(service_status)` · `deliveringTeam?
csv(team)` · pagination.
- **Output** `200` list envelope of audience-shaped `ServiceDTO`.
- **Page/filter/sort** default `createdAt:desc`, alternate `startDate:desc`.
- **Audit** none. Rate class `read`.

### G-3. `GET /api/v1/services/{serviceId}` · tenant ← row · `200`

audience-shaped `ServiceDTO`. `404` otherwise. Rate class `read`.

### G-4. `PATCH /api/v1/services/{serviceId}`

- Capability `service:update` (`●[S] ●[S] ✗ ✗`) · tenant ← row · body ≥ 1:
  `{ name?, scopeSummary?, currency?, fee?, feeModel?, startDate?, endDate?,
deliveringTeam?, leadUserId? }` · **Output** `200` `ServiceDTO` (staff).
- **Errors** `409` team/status CHECKs (`enforce_active_team`), currency vs.
  engagement · **Audit** `UPDATE` · NOTICE · **Idempotency** natural.

### G-5. `POST /api/v1/services/{serviceId}/status`

- STATUS-TRANSITION over `service_status` (`PLANNED → ACTIVE ⇄ PAUSED →
COMPLETED | CANCELLED`; `COMPLETED → ACTIVE` is the seeded
  SUPER_ADMIN-only reopening). Capability `service:update` `[S]`.
- **Audit** `STATUS_CHANGE` · INFO. Idempotency tier 1. Rate class
  `mutation`.

### G-6. `DELETE /api/v1/services/{serviceId}`

- SOFT-DELETE · capability `service:delete` (`● ● ✗ ✗`) · refuses while live
  projects exist. **Audit** `SOFT_DELETE` · NOTICE. Rate class `mutation`.

### G-7. `POST /api/v1/services/{serviceId}/assign`

- ASSIGN · capability `service:assign` (`● ● ✗ ✗`) · body `{
deliveringTeam?: team, leadUserId?: uuid }` ≥ 1 · **Output** `200`
  `ServiceDTO` · **Audit** `UPDATE` · INFO. Rate class `mutation`.

---

## H. Projects (and project memberships)

Backing tables: `projects`, `project_memberships`. `client_visible` defaults
**true** here (clients see the shape of the work) — the deliverable gate is
the strict one, not this (authorization §E).

### H-1. `POST /api/v1/services/{serviceId}/projects`

- **AuthN/AuthZ** `required` · `project:create` (`● ● ✗ ✗`) · tenant ←
  parent service row · AAL 1.
- **Input** body `{ code: bounded 2–32 (unique per org), name≤120,
description?≤4000, priority?: 'LOW'|'MEDIUM'|'HIGH'|'URGENT' default
'MEDIUM', leadUserId?: uuid, owningTeam?: team (defaults from the
service's delivering team), startDate?: date, targetDate?: date,
clientVisible?: boolean default true }` strict + `Idempotency-Key`.
  `status` is not an input — projects are born `PLANNED`.
- **Output** `201` `ProjectDTO` `{ id, organizationId, serviceId, code,
name, description, status, priority, health, leadUserId, owningTeam,
startDate, targetDate, completedAt, clientVisible, createdAt, updatedAt }`
  - `Location`.
- **Errors** `409 duplicate_code` · `404` service unreachable.
- **Audit** `CREATE` · project · NOTICE. **Idempotency** tier 3 — key
  **required**. Rate class `mutation`.

### H-2. `GET /api/v1/projects`

- **AuthN/AuthZ** `required` · `project:read` (`● ● ◒ ◒`) · tenant ←
  `organizationId` query (mandatory for CLIENT actors) · AAL 1 · the
  `CLIENT_VISIBLE` obligation is recorded; RLS applies the gate regardless.
- **Input** query: `organizationId? uuid` · `serviceId? uuid` · `status?
csv(project_status)` · `priority? csv` · `health? csv(ON_TRACK|AT_RISK|
OFF_TRACK)` · `leadUserId? uuid` · `owningTeam? csv(team)` · pagination.
- **Output** `200` list envelope of `ProjectDTO` — clients see only rows
  with `client_visible = true` (RLS), and never see a flag they could flip:
  `clientVisible` itself is included in the DTO only for staff.
- **Page/filter/sort** default `createdAt:desc`, alternates `targetDate:asc`
  (deadline view), `name:asc`. All filter columns are indexed.
- **Errors** global. **Audit** none. Rate class `read`.

### H-3. `GET /api/v1/projects/{projectId}` · tenant ← row · capability

`project:read` · `200` `ProjectDTO` (404 for invisible-or-missing — the
client gate and the miss are one answer). Rate class `read`.

### H-4. `PATCH /api/v1/projects/{projectId}`

- Capability `project:update` (`●[S] ●[S] ✗ ✗`) · tenant ← row · body ≥ 1:
  `{ name?, description?, priority?, health?, owningTeam?, startDate?,
targetDate?, clientVisible? }`. Flipping `clientVisible` to false on a
  project with client-visible deliverables is allowed — the deliverable gate
  is per-deliverable — and is audited loudly (NOTICE with the flag in the
  diff). **Output** `200` staff `ProjectDTO`. **Audit** `UPDATE` · NOTICE.
  Idempotency natural. Rate class `mutation`.

### H-5. `POST /api/v1/projects/{projectId}/status`

- STATUS-TRANSITION over `project_status` (`PLANNED → IN_PROGRESS ⇄ BLOCKED
→ IN_REVIEW → COMPLETED | CANCELLED`; `COMPLETED → IN_PROGRESS` is the
  seeded SUPER_ADMIN-only reopening). Capability `project:update` `[S]`.
  `completedAt` is stamped on `→ COMPLETED` by the service.
- **Audit** `STATUS_CHANGE` · INFO. Idempotency tier 1. Rate class
  `mutation`.

### H-6. `DELETE /api/v1/projects/{projectId}`

- SOFT-DELETE · capability `project:delete` (`● ● ✗ ✗`) · refuses while
  open deliverables or tasks exist. **Audit** `SOFT_DELETE` · NOTICE. Rate
  class `mutation`.

### H-7. `POST /api/v1/projects/{projectId}/assign`

- ASSIGN · capability `project:assign` (`●[P] ●[P] ✗ ✗`) · `project`
  resolver set so the guard carries the `[P]` obligation · body `{
leadUserId?: uuid, owningTeam?: team }` ≥ 1. **The assignee for
  `leadUserId` must hold a `LEAD` membership on this project** — object
  rule enforced by the service (and RPC-free: the membership row is checked
  through the caller's RLS; the tenancy trigger remains the wall). Setting
  a lead with no membership is 409 `lead_membership_missing`; create the
  membership first (H-9). **Output** `200` `ProjectDTO`. **Audit**
  `UPDATE` · INFO. Rate class `mutation`.

### H-8. `GET /api/v1/projects/{projectId}/members`

- **AuthN/AuthZ** `required` · `project_membership:read`
  (`● ● ◒[C] ◒[C]`) · tenant ← parent project row · AAL 1.
- **Output** `200` list envelope of `ProjectMemberDTO` `{ id, userId,
fullName, avatarPath, projectRole, addedBy, createdAt }` — clients see the
  roster of visible projects, **never `allocationPct`** (column-restricted,
  authorization §F.1).
- **Page/filter/sort** default `createdAt:asc`; filter `projectRole? csv`.
- **Audit** none. Rate class `read`.

### H-9. `POST /api/v1/projects/{projectId}/members`

- **AuthN/AuthZ** `required` · `project:manage_members` (`● ●[P] ✗ ✗`) —
  the route capability of authorization §J.3; the `[P]` is **actor-side**
  here: ADMIN must hold `LEAD` on this project (`can()` evaluates it from
  `projectRoles`), SUPER_ADMIN overrides · `project` resolver set · tenant ←
  parent row · AAL 1.
- **Input** body `{ userId: uuid, projectRole: 'LEAD'|'CONTRIBUTOR'|
'REVIEWER'|'OBSERVER', allocationPct?: int 0–100 }` strict +
  `Idempotency-Key`.
- **Output** `201` `ProjectMemberDTO` (staff shape incl. `allocationPct`) +
  `Location`.
- **Errors** `409` one-live-membership per user×project (and therefore one
  LEAD, partial index) · `404` target user shares no tenant with the project
  (the tenancy trigger's answer, mapped) — client users _may_ hold
  OBSERVER/REVIEWER seats (authorization §5 rule 5: notification targeting,
  no extra read).
- **Audit** `CREATE` · project_membership · NOTICE. **Idempotency** tier 2
  (unique index) — the key is accepted but the conflict answers first. Rate
  class `mutation`.

### H-10. `PATCH /api/v1/projects/{projectId}/members/{membershipId}` ·

`DELETE /api/v1/projects/{projectId}/members/{membershipId}`

- Capability `project:manage_members` (`● ●[P] ✗ ✗`) for both writes — the
  route capability of authorization §1.1/§J.3; the decomposed
  `project_membership:update/delete` matrix cells are what RLS evaluates,
  and the `[P]` actor-side rule (ADMIN needs `LEAD`) applies exactly as in
  H-9 · `project` resolver set · tenant ← parent row. PATCH body ≥ 1: `{
projectRole?, allocationPct? }` (role change to LEAD is 409 if a LEAD
  exists). DELETE → `204`. **Output** `200` `ProjectMemberDTO` / `204`.
- **Audit** `UPDATE` / `SOFT_DELETE` · project_membership · NOTICE.
  Idempotency natural / tier 1. Rate class `mutation`.

---

## I. Tasks

Backing table: `tasks`. **No client capability exists on this resource** —
every endpoint below answers CLIENT actors with 403/404 by construction, and
no client RLS policy exists on the table (an absent policy, not a flag —
authorization §F.3).

### I-1. `POST /api/v1/projects/{projectId}/tasks`

- **AuthN/AuthZ** `required` · `task:create` (`● ● ✗ ✗`) · tenant ← parent
  project row · AAL 1.
- **Input** body `{ title≤200, description?≤4000, deliverableId?: uuid,
priority?: priority default 'MEDIUM', assigneeUserId?: uuid,
assignedTeam?: team, dueDate?: date, estimatedHours?: numeric 0–10000,
position?: int }` strict + `Idempotency-Key`. Status is not an input —
  tasks are born `TODO`.
- **Output** `201` `TaskDTO` `{ id, organizationId, projectId,
deliverableId, title, description, status, priority, assigneeUserId,
assignedTeam, dueDate, startedAt, completedAt, estimatedHours,
actualHours, blockedReason, position, createdAt, updatedAt }` +
  `Location`.
- **Errors** `404` project unreachable · `409` deliverable belongs to a
  different project (`enforce_task_deliverable_project`, mapped).
- **Validation** if `assigneeUserId` is set the assignee must be a live
  member of the project — object rule of authorization §5 rule 1, enforced
  by the service and by `growlith.enforce_task_assignee_membership()`; the
  API surfaces it as 409 `assignee_not_member`.
- **Audit** `CREATE` · task · NOTICE. **Idempotency** tier 3 — key
  **required**. Rate class `mutation`.

### I-2. `GET /api/v1/tasks`

- **AuthN/AuthZ** `required` · `task:read` (`● ● ✗ ✗`) · tenant ←
  `organizationId` query (staff-only surface; the parameter stays optional
  for cross-tenant workload views) · AAL 1.
- **Input** query: `organizationId? uuid` · `projectId? uuid` ·
  `deliverableId? uuid` · `status? csv(task_status)` · `assigneeUserId?
uuid` · `assignedTeam? csv(team)` · `dueFrom?/dueTo? date` · pagination.
- **Output** `200` list envelope of `TaskDTO`.
- **Page/filter/sort** default `createdAt:desc`, alternates `dueDate:asc`
  (the "due this week" admin view of authorization §C.2), `priority:desc`
  (enum-ordinal key).
- **Audit** none. Rate class `read`.

### I-3. `GET /api/v1/tasks/{taskId}` · tenant ← row · `200` `TaskDTO` ·

`404` otherwise. Rate class `read`.

### I-4. `PATCH /api/v1/tasks/{taskId}`

- Capability `task:update` (`●[S] ●[S] ✗ ✗`) · tenant ← row · body ≥ 1:
  `{ title?, description?, deliverableId?, priority?, assignedTeam?,
dueDate?, estimatedHours?, actualHours?, blockedReason?, position? }`.
  `status` and `assigneeUserId` are deliberately not PATCH fields —
  transitions and assignments are I-5/I-6, each with its own capability and
  object rules.
- **Output** `200` `TaskDTO`. **Errors** `409` deliverable/project mismatch.
- **Audit** `UPDATE` · task · INFO. Idempotency natural. Rate class
  `mutation`.

### I-5. `POST /api/v1/tasks/{taskId}/status`

- STATUS-TRANSITION over `task_status` (`TODO → IN_PROGRESS ⇄ BLOCKED →
IN_REVIEW → DONE | CANCELLED`). Capability `task:update` `[S]`.
  `startedAt`/`completedAt` stamped by the service on the corresponding
  transitions; `blockedReason` is _required_ in the body for `→ BLOCKED`
  (422 otherwise) and cleared on exit.
- **Audit** `STATUS_CHANGE` · INFO. Idempotency tier 1. Rate class
  `mutation`.

### I-6. `POST /api/v1/tasks/{taskId}/assign`

- ASSIGN · capability `task:assign` (`●[P] ●[P] ✗ ✗`) · `project` resolver
  set (the `[P]` obligation names the assignee rule) · body `{
assigneeUserId: uuid | null }` — `null` unassigns.
- **Object rule** enforced twice: the service checks the live membership;
  `growlith.enforce_task_assignee_membership()` re-checks in the database.
  409 `assignee_not_member` on failure.
- **Output** `200` `TaskDTO`. **Audit** `UPDATE` · INFO. Rate class
  `mutation`.

### I-7. `DELETE /api/v1/tasks/{taskId}`

- SOFT-DELETE · capability `task:delete` (`● ● ✗ ✗`). **Audit**
  `SOFT_DELETE` · NOTICE. Rate class `mutation`.

---

## J. Deliverables (and versions, reviews, approval, publication)

Backing tables: `deliverables`, `deliverable_versions` (append-only). This
resource carries the **strict client gate** (`client_visible` AND status ≥
`CLIENT_REVIEW` — authorization §E.1) and the only client-driven state
changes in the system.

### J-1. `POST /api/v1/projects/{projectId}/deliverables`

- **AuthN/AuthZ** `required` · `deliverable:create` (`● ● ✗ ✗`) · tenant ←
  parent project row · AAL 1.
- **Input** body `{ title≤200, description?≤4000, deliverableType:
deliverable_type enum, dueDate?: date, ownerUserId?: uuid }` strict +
  `Idempotency-Key`. Status (`DRAFT`) and `clientVisible` (**false** — the
  inverted default) are schema defaults, not inputs.
- **Output** `201` `DeliverableDTO` `{ id, organizationId, projectId, title,
description, deliverableType, status, clientVisible (staff DTO only),
currentVersion, revisionCount, dueDate, submittedAt, approvedAt,
approvedBy, ownerUserId, createdAt, updatedAt }` + `Location`.
- **Errors** `404` project unreachable · `409` owner not a project member
  (object rule, service check).
- **Audit** `CREATE` · deliverable · NOTICE. **Idempotency** tier 3 — key
  **required**. Rate class `mutation`.

### J-2. `GET /api/v1/deliverables`

- **AuthN/AuthZ** `required` · `deliverable:read` (`● ● ◒ ◒`) · tenant ←
  `organizationId` query (mandatory for CLIENT actors) · AAL 1 ·
  `CLIENT_VISIBLE` obligation recorded; RLS gate authoritative.
- **Input** query: `organizationId? uuid` · `projectId? uuid` · `status?
csv(deliverable_status)` · `deliverableType? csv` · `ownerUserId? uuid` ·
  pagination.
- **Output** `200` list envelope of `DeliverableDTO`. CLIENT callers
  receive only rows past the strict gate; staff receive all non-deleted rows
  of reachable tenants.
- **Page/filter/sort** default `createdAt:desc`, alternate `dueDate:asc`.
- **Audit** none. Rate class `read`.

### J-3. `GET /api/v1/deliverables/{deliverableId}` · tenant ← row ·

capability `deliverable:read` · `200` `DeliverableDTO` — for clients, the
gate applies, so an in-progress deliverable is a **404**, exactly like a
missing one. Rate class `read`.

### J-4. `PATCH /api/v1/deliverables/{deliverableId}`

- Capability `deliverable:update` (`●[S] ●[S] ✗ ✗`) · tenant ← row · body
  ≥ 1: `{ title?, description?, deliverableType?, dueDate?, ownerUserId?,
clientVisible? }`. Setting `clientVisible` true while status is below
  `CLIENT_REVIEW` is refused — 409 `visibility_requires_client_state`
  (the `deliverables_client_states_require_visibility` CHECK runs in the DB
  regardless; the API names it first).
- **Output** `200` staff `DeliverableDTO`. **Audit** `UPDATE` · NOTICE.
  Idempotency natural. Rate class `mutation`.

### J-5. `POST /api/v1/deliverables/{deliverableId}/status`

- STATUS-TRANSITION for the **internal half** of the machine
  (`DRAFT → IN_PROGRESS → INTERNAL_REVIEW → SUBMITTED → CLIENT_REVIEW`,
  `REVISION_REQUESTED → IN_PROGRESS`, `… → CANCELLED`). Capability
  `deliverable:update` `[S]`. The client-owned transitions (`CLIENT_REVIEW
→ APPROVED|REVISION_REQUESTED`) and `APPROVED → PUBLISHED` are **not
  reachable here** — they are J-8 and J-9 with their own capabilities and
  RPC/role checks; `status_transitions.allowed_roles` is the single stored
  definition both consult (authorization §13).
- **Audit** `STATUS_CHANGE` · INFO. Idempotency tier 1. Rate class
  `mutation`.

### J-6. `DELETE /api/v1/deliverables/{deliverableId}`

- SOFT-DELETE · capability `deliverable:delete` (`● ● ✗ ✗`) · refuses rows
  at `APPROVED`/`PUBLISHED` (409 `published_rows_not_deletable` — approval
  is a client trust event; removal goes through reopen, SUPER_ADMIN-only).
- **Audit** `SOFT_DELETE` · NOTICE. Rate class `mutation`.

### J-7. `POST /api/v1/deliverables/{deliverableId}/assign`

- ASSIGN · capability `deliverable:assign` (`●[P] ●[P] ✗ ✗`) · `project`
  resolver set · body `{ ownerUserId: uuid | null }` (owner must be a live
  project member — object rule). **Output** `200` `DeliverableDTO`.
  **Audit** `UPDATE` · INFO. Rate class `mutation`.

### J-8. `POST /api/v1/deliverables/{deliverableId}/approve`

- **AuthN/AuthZ** `required` · `deliverable:approve`
  (`●[S] ●[S] ◒[R][S] ✗`) — the client-driven transition, CLIENT_ADMIN only
  at the client end; staff may override · tenant ← row · AAL 1.
- **Input** body — audience-shaped: clients `{ outcome: 'APPROVED'|
'REVISION_REQUESTED', notes?: string≤2000 }`; staff additionally may send
  `outcome: 'REJECTED'` (a staff-recorded rejection, which the RPC maps to
  `REVISION_REQUESTED` and keeps the work alive). `notes` is **required**
  for `REVISION_REQUESTED`/`REJECTED` (422 otherwise — the reason _is_ the
  review; the RPC re-checks) — maps 1:1 to `approve_deliverable(
p_deliverable_id, p_outcome, p_notes)`. The RPC validates the
  `CLIENT_REVIEW` state, stamps `approvedAt/approvedBy` on approval, bumps
  `revisionCount` and appends the version row on the revision path, fans the
  owner notification, and audits — one transaction.
- **Output** `200` `DeliverableDTO` (post-transition).
- **Errors** `404` invisible-or-missing (a client approving a row they
  cannot see is a 404) · `409 invalid_transition` (not at `CLIENT_REVIEW`) ·
  `403` CLIENT_MEMBER attempt (the RPC re-reserves the decision to the
  tenant's CLIENT_ADMIN and staff).
- **Audit** `STATUS_CHANGE` · deliverable · NOTICE — written by the RPC.
- **Idempotency** tier 1 (repeat ⇒ 409 naming the current state). Rate
  class `mutation`.

### J-9. `POST /api/v1/deliverables/{deliverableId}/publish`

- **AuthN/AuthZ** `required` · `deliverable:publish` (`●[S] ●[S] ✗ ✗`) —
  Growlith's act, never the client's · tenant ← row · AAL 1.
- **Input** none (or `{ confirm: true }` deferred — no confirmation token in
  v1; the capability and `[S]` are the gates).
- **Execution** service-layer transition `APPROVED → PUBLISHED` setting
  `client_visible = true` atomically (the CHECK guarantees the pair), then
  notification fan-out.
- **Output** `200` `DeliverableDTO`. **Errors** `409 invalid_transition`
  unless at `APPROVED`. **Audit** `STATUS_CHANGE` · NOTICE. Idempotency
  tier 1. Rate class `mutation`.

### J-10. `POST /api/v1/deliverables/{deliverableId}/reviews`

- **AuthN/AuthZ** `required` · `deliverable:update` (`●[S] ●[S] ✗ ✗`) — the
  matrix has no `review` verb; an internal review _is_ the state-and-version
  update, with the reviewer rule layered on · `project` resolver set ·
  tenant ← row · AAL 1.
- **Input** body `{ outcome: review_outcome ('APPROVED'|
'REVISION_REQUESTED'|'REJECTED'), notes?≤2000, summary?≤2000 }` — maps to
  `submit_deliverable_review(p_deliverable_id, p_outcome, p_notes,
p_summary)`. The RPC's exact rules, surfaced as API contract: staff only;
  the deliverable must be at `INTERNAL_REVIEW` (409 otherwise); `notes`
  required for non-`APPROVED` outcomes (422); `REJECTED` is SUPER_ADMIN-only
  (a kill-call, authorization §A item 5); the reviewer must hold `LEAD` or
  `REVIEWER` on the project (authorization §5 rule 2) — **SUPER_ADMIN is the
  only exemption**, ADMIN included. An `APPROVED` review appends the version
  row and moves the deliverable to `SUBMITTED`; a failed review records no
  version (nothing was released) and returns the deliverable to
  `IN_PROGRESS`.
- **Output** `201` `{ versionNumber, status }` — `versionNumber` is the new
  version on the approval path and `0` on a failed review; the version row
  is append-only and there is no PATCH/DELETE for versions anywhere in v1.
- **Errors** `409 invalid_transition` (state) · `409 reviewer_not_member`
  (rule 2, ADMIN) · `403` REJECTED-by-non-SUPER_ADMIN and client attempts.
- **Audit** `STATUS_CHANGE` · deliverable · INFO — written by the RPC; the
  audit row carries the review notes where the version trail carries none.
- **Idempotency** tier 3 — key **required** (a retried review must not mint
  two version rows). Rate class `mutation`.

### J-11. `GET /api/v1/deliverables/{deliverableId}/versions`

- **AuthN/AuthZ** `required` · `deliverable:read` — versions inherit the
  parent's gate exactly (authorization §B.3) · tenant ← parent row · AAL 1.
- **Output** `200` list envelope of `DeliverableVersionDTO` `{ versionNumber,
summary, status, submittedBy, submittedAt, reviewedBy, reviewedAt,
reviewOutcome, reviewNotes, createdAt }`.
- **Page/filter/sort** fixed `versionNumber:desc`; no filters.
- **Audit** none. Rate class `read`.

---

## K. Reports and metrics

Backing tables: `reports`, `report_metrics` (frozen snapshot, append-only),
`metrics` (raw time series). Reading all three is governed by `report:read`
(authorization §B.4); **writing metrics has no capability and therefore no
endpoint** — ingestion is a reserved surface ([§17](#17-deliberate-absences)).
Reports have **no `status_transitions` machine** — Phase 2 excluded them
deliberately ("a machine with no branches"): publication is the one exposed
transition (K-6, RPC-driven), and the remaining lifecycle moves are not
surfaces of v1 ([§17](#17-deliberate-absences)).

### K-1. `POST /api/v1/organizations/{organizationId}/reports`

- **AuthN/AuthZ** `required` · `report:create` (`● ● ✗ ✗`) · tenant ← path ·
  AAL 1.
- **Input** body `{ title≤200, reportType: 'PERFORMANCE'|
'EXECUTIVE_SUMMARY'|'CAMPAIGN'|'SEO'|'TECHNICAL_AUDIT'|'QBR',
periodStart: date, periodEnd: date, currency?: currency_code,
engagementId?: uuid, serviceId?: uuid, summaryMd?≤20000 }` strict +
  `Idempotency-Key`. `status` (`DRAFT`) and `clientVisible` (false) are
  defaults, not inputs.
- **Output** `201` `ReportDTO` `{ id, organizationId, engagementId,
serviceId, title, reportType, periodStart, periodEnd, status, currency,
summaryMd, publishedAt, publishedBy, clientVisible (staff DTO only),
createdAt, updatedAt }` + `Location`.
- **Errors** `404` org unreachable · `409` engagement/service belongs to
  another tenant (composite FK, mapped).
- **Validation** `periodEnd ≥ periodStart`; `serviceId` implies a matching
  `engagementId` when both present (refine mirroring the FK).
- **Audit** `CREATE` · report · NOTICE. **Idempotency** tier 3 — key
  **required**. Rate class `mutation`.

### K-2. `GET /api/v1/reports`

- **AuthN/AuthZ** `required` · `report:read` (`● ● ◒ ◒`) · tenant ←
  `organizationId` query (mandatory for CLIENT actors) · AAL 1 · client
  gate = `client_visible AND status = 'PUBLISHED'` (RLS).
- **Input** query: `organizationId? uuid` · `engagementId? uuid` ·
  `serviceId? uuid` · `status? csv(report_status)` · `reportType? csv` ·
  `periodFrom?/periodTo? date` · pagination.
- **Output** `200` list envelope of `ReportDTO`.
- **Page/filter/sort** default `createdAt:desc`, alternate `periodEnd:desc`.
- **Audit** none. Rate class `read`.

### K-3. `GET /api/v1/reports/{reportId}`

- **AuthN/AuthZ** `required` · `report:read` · tenant ← row · AAL 1.
- **Output** `200` `ReportDTO` plus `metrics: ReportMetricDTO[]` — `{
metricKey, metricDate, value, unit, currency, source }` — the frozen
  `report_metrics` rows. For a client caller the array exists only when the
  report is published; the row would be invisible otherwise. For a DRAFT
  report read by staff, `metrics` is `[]` — figures freeze at publication
  (K-6), by design.
- **Errors** `404`. Rate class `read`.

### K-4. `PATCH /api/v1/reports/{reportId}`

- Capability `report:update` (`● ● ✗ ✗`) · tenant ← row · body ≥ 1:
  `{ title?, reportType?, periodStart?, periodEnd?, currency?,
engagementId?, serviceId?, summaryMd? }`.
- **Frozen-once-published:** any PATCH of a `PUBLISHED` report is 409
  `report_frozen` (corrections are new reports); `ARCHIVED` rows refuse too.
- **Output** `200` `ReportDTO`. **Audit** `UPDATE` · NOTICE. Idempotency
  natural. Rate class `mutation`.

### K-5. `DELETE /api/v1/reports/{reportId}`

- SOFT-DELETE · capability `report:delete` (`● ● ✗ ✗`) · refuses `PUBLISHED`
  rows (409 `report_frozen` — issued-to-client artifacts are not quietly
  removed; archive via the state machine instead). **Audit** `SOFT_DELETE` ·
  NOTICE. Rate class `mutation`.

### K-6. `POST /api/v1/reports/{reportId}/publish`

- **AuthN/AuthZ** `required` · `report:publish` (`● ● ✗ ✗`) · tenant ← row
  · AAL 1.
- **Input** body `{ clientVisible?: boolean default true }` — maps to
  `publish_report(p_report_id, p_client_visible)`. The RPC freezes
  `report_metrics` **from live `metrics` at the instant of publication**
  (the snapshot that makes corrections non-retroactive), stamps
  `publishedAt/publishedBy`, sets visibility, and emits the notification —
  one transaction.
- **Output** `200` `ReportDTO` (post-transition, with `metrics` populated).
- **Errors** `409 invalid_transition` unless the report is
  `DRAFT|INTERNAL_REVIEW` (RPC check, mapped from its refusal).
- **Honest behaviour note:** the RPC publishes a metric-less period by
  freezing **zero** rows — the audit records `metrics_frozen: 0`, which is
  how an empty publication stays visible in hindsight. Whether that should
  be a refusal is a product decision the design does not take unilaterally;
  if it becomes one, it is a service-layer pre-check on this endpoint.
- **Audit** `STATUS_CHANGE` · report · NOTICE — inside the RPC.
- **Idempotency** tier 1. Rate class `mutation`.

### K-7. `GET /api/v1/reports/{reportId}/download-url`

- **AuthN/AuthZ** `required` · `report:download` (`● ● ◒ ◒`) · tenant ←
  row · AAL 1 · rate class `export`.
- **Input** none. **Output** `200` `{ downloadUrl, expiresAt }` — a 60 s
  signed URL to the report's export object (the `files` row of kind
  `REPORT_EXPORT` attached to the report). **Export generation is not a v1
  surface:** if no export artifact exists yet, the endpoint answers `404
export_not_generated` — honest absence, not a fake pipeline. The artifact
  itself is uploaded through the standard file flow ([§L](#l-files)) by the
  process that produces it.
- **Errors** `404` report invisible or artifact absent · gate as J-3.
- **Audit** `EXPORT` · report · INFO — one of the two reads that audit.
- **Idempotency** natural (minting is side-effect-free apart from audit).

### K-8. `GET /api/v1/metrics`

- **AuthN/AuthZ** `required` · `report:read` — the metrics row of
  authorization §B.4: raw metrics are the client's own performance data,
  organization-wide, **no visibility flag** (`◑ ◑` at the client end) ·
  tenant ← `organizationId` query (mandatory for CLIENT actors) · AAL 1.
- **Input** query: `organizationId? uuid` · `serviceId? uuid` ·
  `serviceLine? csv` · `metricKey? csv(metric_key)` · `from?/to? date`
  (inclusive range on `metric_date`) · pagination.
- **Output** `200` list envelope of `MetricDTO` `{ organizationId,
serviceId, serviceLine, metricKey, metricDate, value, unit, currency,
source, ingestedAt }` — `value` as a decimal string.
- **Page/filter/sort** default `metricDate:desc`, alternate `metricDate:asc`
  (chart-friendly). `(organization_id, service_id, metric_key, metric_date)`
  is the table's spine and covers every filter.
- **Errors** global. **Audit** none. Rate class `read`.

---

## L. Files

Backing table: `files` + `storage.objects`. **Bytes never traverse the API**
(ADR-0016): uploads PUT directly to Storage via signed URLs, downloads GET
the same way. The API handles authorization, metadata and verification.

### L-1. `POST /api/v1/files/upload-url`

- **AuthN/AuthZ** `required` · `file:upload` (`● ● ◑ ◑`) · tenant ←
  **parent row** — the body names exactly one parent, the service loads it
  through the caller's RLS and derives the tenant from it (clients can mint
  URLs only where they can already read the parent) · AAL 1.
- **Input** body `{ fileName: sanitized-base≤255, mimeType: string≤120,
sizeBytes: int 1–(bucket limit), checksumSha256?: hex64,
fileKind: file_kind enum, clientVisible?: boolean default false,
parent: exactly-one of { projectId | deliverableId | deliverableVersionId
| taskId | reportId | commentId } | none (organization-level upload,
CLIENT_ADMIN+ for clients) }` strict + `Idempotency-Key`.
- **Output** `201` `{ uploadUrl, storagePath, expiresAt, fileRegistration:
{ …the fields L-2 expects back… } }`. `storagePath` is server-built as
  `{organization_id}/{entity_type}/{entity_id}/{ulid}-{sanitized-filename}`
  (README §I 🔒) — the caller never chooses a path.
- **Errors** `404` parent unreachable · `415`-shaped refusal as `422
mime_not_allowed` (bucket allowlist: documents/images/video/archives; no
  executables, no `text/html`) · `413` size beyond bucket limit.
- **Validation** XOR parent refine; MIME against the allowlist; extension
  consistent with MIME (service check).
- **Audit** none at minting (the registration below is the audited event);
  rate class `export`.
- **Idempotency** tier 3 — key **required** (a retry must not mint a second
  path for the same logical upload).

### L-2. `POST /api/v1/files`

- **AuthN/AuthZ** `required` · `file:upload` (same capability — registration
  is the second half of one upload, authorization §1.1) · tenant ← parent
  row, re-loaded (never cached from L-1) · AAL 1.
- **Input** body = the `fileRegistration` object from L-1 verbatim
  (`storagePath`, `fileName`, `mimeType`, `sizeBytes`, `checksumSha256?`,
  `fileKind`, `clientVisible`, `parent`) — `.strict()` guarantees it cannot
  be widened.
- **Execution** service layer: HEAD the object through the confined client
  (existence + size agreement; checksum when supplied), insert the `files`
  row (`virus_scan_status = 'PENDING'` until the scan job says otherwise —
  no scanning dependency in v1, risk R-7), answer the DTO.
- **Output** `201` `FileDTO` `{ id, organizationId, storagePath, fileName,
mimeType, sizeBytes, fileKind, clientVisible (staff DTO only),
uploadedBy, virusScanStatus, projectId | deliverableId | taskId |
reportId | commentId | null, createdAt }` + `Location`.
- **Errors** `409 file_not_found_in_storage` (uploaded nowhere or wrong
  path) · `409 size_mismatch` · `409 duplicate_registration` (same path
  registered twice).
- **Audit** `CREATE` · attachment · NOTICE. **Idempotency** tier 3 — key
  **required**; the unique path backstops it. Rate class `mutation`.

### L-3. `GET /api/v1/files`

- **AuthN/AuthZ** `required` · `file:read` (`● ● ◒ ◒`) · tenant ←
  `organizationId` query (mandatory for CLIENT actors) · AAL 1 · client
  gate = `client_visible AND virus_scan_status = 'CLEAN' AND parent visible`
  (RLS via `can_read_storage_object()`'s metadata mirror).
- **Input** query: `organizationId? uuid` · parent filters (at most one):
  `projectId? | deliverableId? | taskId? | reportId? | commentId?` ·
  `fileKind? csv` · `uploadedBy? uuid` · pagination.
- **Output** `200` list envelope of `FileDTO`.
- **Page/filter/sort** default `createdAt:desc`.
- **Audit** none. Rate class `read`.

### L-4. `GET /api/v1/files/{fileId}` · tenant ← row · capability

`file:read` · `200` `FileDTO` (gate as L-3 — an unclean or internal file is
a 404). Rate class `read`.

### L-5. `POST /api/v1/files/{fileId}/download-url`

- **AuthN/AuthZ** `required` · `file:download` (`● ● ◒ ◒`) · tenant ← row
  · AAL 1 · rate class `export`.
- **Output** `200` `{ downloadUrl, expiresAt }` — 60 s signed URL
  (README §I); the object gate and the metadata gate must agree
  (authorization §H.6; pgTAP asserts they never disagree).
- **Errors** `404` gate failure · `409 scan_pending` for a `PENDING`/
  `FAILED` scan on a staff download of an unscanned file is _allowed but
  audited_; for clients it is a 404 by gate.
- **Audit** `FILE_DOWNLOAD` · attachment · INFO. Idempotency natural.

### L-6. `PATCH /api/v1/files/{fileId}` · `DELETE /api/v1/files/{fileId}`

- Capabilities `file:update` / `file:delete` (`● ● ◦ ◦`) — clients may
  rename/reclassify and soft-delete **their own uploads only** (OWN_ROW
  obligation; `enforce_file_uploader_columns` is the DB wall) · tenant ←
  row. PATCH body ≥ 1: `{ fileName?, fileKind?, clientVisible? }` — a
  client setting `clientVisible` is refused (422 unknown-key: the field is
  not in the client PATCH schema); DELETE → `204` (object bytes persist
  until the purge job — immediate hard delete would destroy audit evidence).
- **Audit** `UPDATE` / `SOFT_DELETE` · attachment · INFO. Rate class
  `mutation`.

---

## M. Comments

Backing table: `comments` — exactly one subject (`num_nonnulls(project_id,
deliverable_id, task_id) = 1`), threaded via `parent_comment_id`. Client
comments are never internal and never on tasks (triggers enforce; the API
schemas make both unrepresentable for client callers).

### M-1. `POST /api/v1/comments`

- **AuthN/AuthZ** `required` · `comment:create` (`● ● ◒ ◒`) · tenant ←
  **subject row** (loaded through the caller's RLS) · AAL 1.
- **Input** body `{ body: trimmed 1–4000, subject: exactly-one of {
projectId | deliverableId | taskId }, parentCommentId?: uuid,
isInternal?: boolean }` strict + `Idempotency-Key`. The **client schema
  variant** (chosen by audience before parse) has no `isInternal` field and
  no `taskId` option — unknown-key rejection is the enforcement;
  `enforce_comment_author_scope()` is the DB wall.
- **Output** `201` `CommentDTO` `{ id, organizationId, projectId |
deliverableId | taskId, parentCommentId, authorUserId, body, isInternal
(staff DTO only), editedAt, createdAt }` + `Location`.
- **Errors** `404` subject unreachable/invisible · `409` parent comment has
  a different subject (`enforce_comment_thread_subject`, mapped) · `409`
  parent author/subject mismatch for client threads.
- **Audit** `CREATE` · comment · INFO. **Idempotency** tier 3 — key
  **required** (comment double-posts are the canonical retry accident).
  Rate class `mutation`.

### M-2. `GET /api/v1/comments`

- **AuthN/AuthZ** `required` · `comment:read` (`● ● ◒ ◒`) · tenant ←
  **subject** — exactly one of `projectId | deliverableId | taskId` is
  **required in the query** (422 `subject_required`; comments are always
  read in the context of their subject) · AAL 1.
- **Input** query: the subject (above) · `parentCommentId? uuid` ·
  `authorUserId? uuid` · pagination.
- **Output** `200` list envelope of `CommentDTO`. Client callers never see
  `is_internal = true` rows (RLS) and never see task comments (no task
  visibility exists for them).
- **Page/filter/sort** fixed `createdAt:asc` (thread order — a chat-shaped
  resource; descending views are a client-side reversal of a bounded page).
- **Audit** none. Rate class `read`.

### M-3. `GET /api/v1/comments/{commentId}` · tenant ← row · capability

`comment:read` · `200` `CommentDTO` · `404` otherwise (internal comments are
404s for clients, per gate). Rate class `read`.

### M-4. `PATCH /api/v1/comments/{commentId}`

- Capability `comment:update` (`● ◦ ◦ ◦`) — **author-only** for everyone but
  SUPER_ADMIN (moderation); the SELF branch is evaluated via `subjectUser` ←
  the row's author (row resolver loads it) · tenant ← row.
- **Input** body `{ body: trimmed 1–4000 }` only — edits rewrite `body` and
  stamp `editedAt`; `isInternal` is not editable (reclassification is
  delete-and-repost, audited as such). **Edit window:** 24 h for
  non-SUPER_ADMIN actors (service check → 409 `edit_window_expired`).
- **Output** `200` `CommentDTO`. **Audit** `UPDATE` · comment · INFO.
  Idempotency natural. Rate class `mutation`.

### M-5. `DELETE /api/v1/comments/{commentId}`

- Capability `comment:delete` (`● ● ◦ ◦`) — author, or ADMIN/SUPER_ADMIN on
  tenant rows · SOFT-DELETE pattern (thread children survive, pointing at a
  deleted parent — the thread trigger permits it; renderers show
  "[deleted]"). **Audit** `SOFT_DELETE` · INFO. Rate class `mutation`.

---

## N. Notifications

Backing table: `notifications` — recipient-scoped, self-service reads only.
**No role may create one through the API** (matrix `✗ ✗ ✗ ✗`): emission is
server-side, inside the definer RPCs and services that cause the events.
**No delete endpoint exists:** retention is a job.

### N-1. `GET /api/v1/notifications`

- **AuthN/AuthZ** `required` · `notification:read` (`◦ ◦ ◦ ◦`) — recipient
  only; even SUPER_ADMIN reads only their own inbox · no tenant (self) ·
  AAL 1.
- **Input** query: `unreadOnly? boolean` · `archived? boolean default
false` · `organizationId? uuid` (optional context filter —
  `organization_id` is nullable for platform notices) · pagination.
- **Output** `200` list envelope of `NotificationDTO` `{ id,
notificationType, severity, title, body, subjectEntity, subjectId,
actionUrl, readAt, archivedAt, createdAt }`.
- **Page/filter/sort** fixed `createdAt:desc`.
- **Audit** none. Rate class `read`.

### N-2. `GET /api/v1/notifications/{notificationId}` · SELF (recipient) ·

`200` `NotificationDTO` · `404` for anyone else's row. Rate class `read`.

### N-3. `PATCH /api/v1/notifications/{notificationId}`

- Capability `notification:update` (`◦ ◦ ◦ ◦`) · SELF · body ≥ 1: `{
read?: boolean, archived?: boolean }` — `read: false` clears `readAt`;
  nothing else on this table is mutable.
- **Output** `200` `NotificationDTO`. **Audit** none (presence toggles are
  not business events). Idempotency natural. Rate class `mutation`.

---

## O. Activity

Backing table: `audit_events` (partitioned, append-only). Two surfaces, two
audiences, one rule: **clients never touch the table** (authorization §F.4).

### O-1. `GET /api/v1/admin/activity`

- **AuthN/AuthZ** `required` · `activity:read` (`● ● ✗ ✗`) — internal only
  · no tenant (cross-tenant by role; `organizationId` filters) · AAL 1.
- **Input** query: `organizationId? uuid` · `entityKind? csv(entity_kind)`
  · `entityId? uuid` · `action? csv(audit_action)` · `severity? csv` ·
  `actorUserId? uuid` · `from?/to? timestamp` · pagination.
- **Output** `200` list envelope of `ActivityEventDTO` `{ id, occurredAt,
actorUserId, action, entityKind, entityId, organizationId, severity,
requestId, before, after }` — the `before/after` diff included for staff
  because it is the point of an audit trail.
- **Page/filter/sort** fixed `occurredAt:desc` (partition-pruned by
  `from/to` when supplied).
- **Errors** global. **Audit** none (reading the trail is not an event in
  it; the access log carries it). Rate class `read`.

### O-2. `GET /api/v1/organizations/{organizationId}/activity`

- **AuthN/AuthZ** `required` · capability `organization:read` — **the one
  endpoint whose capability names the scope rather than the table**, by
  explicit design: the matrix denies clients `activity:read`, and this
  surface is not `audit_events` — it is the whitelisted projection of
  `client_activity_feed(p_organization_id, p_limit, p_before)`, which
  returns `occurred_at, entity_kind, entity_id, action, display_title` and
  nothing else: no actor identity, no IP, no diff, only allow-listed
  entity kinds and actions. The capability answers "may this actor see
  account-level summaries of this tenant"; the definer RPC answers "which
  rows qualify". Staff calling this endpoint receive the same projection —
  the full trail is O-1 · tenant ← path · AAL 1.
- **Input** query: `limit` (≤ 50, default 50) · `before? timestamp` (the
  RPC's own cursor — a timestamp, not the base64 codec: the feed is
  append-only and time-ordered, so a bare `before` is honest keyset).
- **Output** `200` `{ data: ClientActivityItem[], pagination: { limit,
hasMore, nextBefore } }` — `ClientActivityItem` `{ occurredAt,
entityKind, entityId, action, displayTitle }`.
- **Errors** `404` org unreachable. **Audit** none. Rate class `read`.

---

## P. Reference data

### P-1. `GET /api/v1/status-transitions`

- **AuthN/AuthZ** `required` · `status_transition:read` (`● ● ● ●`) — all
  four roles: every surface that renders a status label needs the vocabulary
  and its legal moves · no tenant · AAL 1.
- **Input** query: `entityKind? csv(engagement|service|project|deliverable|
task)` — exactly the five machine-bearing entity kinds (D-5 and the §K
  preamble record why organization and report are absent).
- **Output** `200` `{ transitions: [{ entityKind, fromStatus, toStatus,
allowedRoles: Role[] }] }` — the seeded rows, unpaginated (reference set,
  bounded, cached client-side by the Phase 9 app).
- **Audit** none. Rate class `read`.

**Teams and service lines have no endpoints.** They are seeded reference
data compiled into `src/lib/domain` (ADR-0006; the UI imports the constants
directly), and the matrix grants clients no `team_membership:read` — a
`/teams` endpoint would either need a capability that does not exist or
leak internal structure. DTOs carry resolved labels (`serviceLineLabel`,
team labels) so no screen needs a lookup round trip. If a reference API is
ever required, it arrives with its matrix row, not before.

---

## Q. Operational

### Q-1. `GET /api/v1/health` · _implemented, Phase 1_

- `public`; reveals nothing tenant-shaped; rate class `read`. Operational
  infrastructure, not a stub — the only route allowed to exist before its
  service layer (Rule 14).

---

# Part III — Cross-checks

## 16. Coverage assertions

Every capability with at least one `ALLOW` cell maps to exactly one of: a
route in Part II, a documented delegation, or a documented absence. This is
the assertion the contract suite keeps alive after implementation:

| Capability(s)                                       | Where answered                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `organization:create/read/update/delete`            | D-1…D-6                                                                                                         |
| `organization:assign`                               | D-9                                                                                                             |
| `organization:manage_settings`                      | D-8 (read rides on `organization:read`, D-7)                                                                    |
| `organization:manage_members`                       | C-7…C-9 (route capability; `membership:create/update/delete` are what the RPC and RLS see — authorization §1.1) |
| `membership:read`                                   | C-6                                                                                                             |
| `user:create`                                       | **Delegated:** account birth is invitations (C-1) — there is no user-create endpoint by design                  |
| `user:read`                                         | B-1 (self), B-3, B-4                                                                                            |
| `user:update`                                       | B-2 (self profile); A-4 + the MFA routes (SELF branch); B-5…B-8 (status changes, platform-gated)                |
| `user:delete`                                       | B-9 (RPC)                                                                                                       |
| `platform_grant:create/read/delete`                 | C-11, C-10, C-12 (all RPC-backed)                                                                               |
| `invitation:create/read/update`                     | C-1…C-5 · `invitation:delete` is `✗` for everyone — retention job, no endpoint                                  |
| `team_membership:create/read/update/delete`         | C-15, C-13/C-14, C-16, C-17                                                                                     |
| `engagement:*`                                      | F-1…F-7                                                                                                         |
| `service:*`                                         | G-1…G-7                                                                                                         |
| `project:create/read/update/delete/assign`          | H-1…H-7                                                                                                         |
| `project:manage_members`                            | H-9, H-10 (route capability; `project_membership:update/delete` are the RLS-layer verbs)                        |
| `project_membership:read`                           | H-8                                                                                                             |
| `task:create/read/update/delete/assign`             | I-1, I-2/I-3, I-4+I-5, I-7, I-6                                                                                 |
| `deliverable:create/read/update/delete/assign`      | J-1, J-2/J-3/J-11, J-4+J-5, J-6, J-7                                                                            |
| `deliverable:approve/publish`                       | J-8 (RPC), J-9                                                                                                  |
| `deliverable:upload/download`                       | **Delegated** to `file:upload`/`file:download` with a deliverable parent (L-1/L-5) — no separate routes         |
| `report:create/read/update/delete/publish/download` | K-1, K-2/K-3/K-8, K-4, K-5, K-6 (RPC), K-7                                                                      |
| `file:upload/read/update/delete/download`           | L-1+L-2, L-3/L-4, L-6, L-6, L-5 · `file:create` is NA — an upload _is_ the create                               |
| `notification:read/update`                          | N-1/N-2, N-3 · `create`/`delete` are `✗` for every role — emission is server-side, retention is a job           |
| `activity:read`                                     | O-1 · clients get the projection (O-2) under `organization:read`, never the table                               |
| `comment:create/read/update/delete`                 | M-1…M-5                                                                                                         |
| `status_transition:read`                            | P-1                                                                                                             |
| `platform_settings:*`                               | **Reserved:** the table arrives in Phase 7; no route may ship before it                                         |

Matrix cells that are `DENY` for all roles correspond to **no endpoint** —
asserted, not assumed, by the dead-capability test ([§18](#18-verification-strategy)).

## 17. Deliberate absences

Each of these looks plausible and none exists, for a named reason:

1. **Metrics ingestion** (`POST /api/v1/metrics`…) — no capability in the
   matrix backs a metrics write; the ingestion actor (a person? an
   integration?) is an open product question. The read surface (K-8) exists;
   the write surface arrives with its authorization story, not before.
2. **Notification create/delete** — `✗ ✗ ✗ ✗` for create and delete across
   all four roles. Fan-out lives inside the definer RPCs and services that
   cause events; a notification-creation endpoint would be a forgery vector.
3. **Teams / service-lines endpoints** — no capability exists for a pure
   reference read; the vocabulary is compiled (`src/lib/domain`), and the
   `team_membership:read` cells exist for staffing, not for enumeration.
4. **User creation** — sign-up is disabled platform-wide; the only door is
   an invitation (authentication §2). A `POST /users` would be a second
   door.
5. **Platform settings** — capability reserved (Phase 4 §A item 4), table
   Phase 7; the reservation exists precisely so a route cannot ship first.
6. **Search, bulk, and batch endpoints** — no search index, no bulk
   semantics in the matrix, and a batch mutation would need a transaction
   and audit model of its own. Reconsider only with a consumer.
7. **Report export generation** — K-7 serves a signed URL to an artifact
   that must already exist; the generation pipeline is not designed and
   is not faked.
8. **Report lifecycle moves other than publication** — `DRAFT →
INTERNAL_REVIEW` and `PUBLISHED → ARCHIVED` have no v1 endpoint: reports
   sit deliberately outside `status_transitions` (a linear lifecycle),
   publication is the one trust event and has its RPC (K-6), and the other
   moves get a surface when a workflow needs them — with their authorization
   story, not before.
9. **API keys, webhooks, machine clients, CORS, Realtime-over-API** —
   session-cookie, same-origin, human-in-browser is the entire v1 caller
   model (ADR-0014, ADR-0026).

## 18. Verification strategy

| Level | Suite                            | Proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Blocking |
| ----- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------: |
| L1    | `tests/unit/**`                  | cursor codec round-trip per declared sort key; money/date/csv field primitives; enum parity between validation schemas and generated DB types; state-machine module equals `status_transitions` seed                                                                                                                                                                                                                                                                  |    ✅    |
| L2    | `tests/unit/permissions.spec.ts` | unchanged Phase 4 invariants; **plus** the coverage table of [§16](#16-coverage-assertions) encoded as data                                                                                                                                                                                                                                                                                                                                                           |    ✅    |
| L3    | `tests/contract/**`              | every route built with `withRoute` (existing); every `required` route declares a live capability (extend existing `route-capability` suite); **no declared capability is held by zero roles** (dead-capability test); 404-before-403 with a fixture actor outside the tenant; idempotency replay/reuse/not-consumed-on-4xx; DTO audience property test — no internal-only field ever serializes into a client-shaped DTO; list envelope shape + `cursor_mismatch` 422 |    ✅    |
| L4    | `supabase/tests/*.sql` (pgTAP)   | Phase 4's obligations unchanged; Phase 5 adds: `idempotency_keys` expiry and uniqueness; `archive_organization()` ceilings (audit-first, slug confirmation, live-children refusal)                                                                                                                                                                                                                                                                                    |    ✅    |
| L5    | `tests/e2e/**`                   | Phase 8 — full journeys incl. the client-A-vs-client-B negative test through real endpoints                                                                                                                                                                                                                                                                                                                                                                           | Phase 8  |

## 19. Implementation sequence

Ordered so every step is green and testable when it lands:

1. **Field primitives + entity schemas** — `moneyField`, `dateField`,
   `enumField`, `csvField` in `src/lib/validation/`; the sixteen entity
   schema modules of [§7](#7-validation-conventions). Enum parity tests land
   with them. No consumers yet.
2. **`withRoute` seams** — list envelope (`pageResult`), `location` field
   for 201s, the `rateLimit` declaration field (declaration only — the
   limiter is Phase 6), and the idempotency hook position. The four
   existing route families get their `rateLimit` classes and the
   `reactivate` route its `minAal: 2` in the same change.
3. **Migration: `idempotency_keys`** (+ `db:types`), then the idempotency
   service and the ADR-0028 contract tests.
4. **Migration: `archive_organization()`** — with ADR-0029 ratified first
   (the closed RPC set grows only by ADR — authorization §14).
5. **DTO layer** — audience-shaped mappers per resource over narrowed row
   types (authorization §I.5), with the L3 audience property test before
   any route consumes them.
6. **State-machine module** — `src/lib/domain/state-machines.ts` derived
   from the `status_transitions` vocabulary (the ADR register's deferred
   "Phase 5" item), parity-tested against the seed; the STATUS-TRANSITION
   pattern consumes it.
7. **Routes, family by family**, each with its contract tests before the
   next family starts, in dependency order: reference (P) → organizations
   (D) → users/self (B) → access management (C) → engagements (F) →
   services (G) → projects (H) → tasks (I) → deliverables (J) →
   reports/metrics (K) → files (L) → comments (M) → notifications (N) →
   activity (O).
8. **Close-out** — coverage table encoded in L2, README §H status flipped,
   this document's header changed to _implemented_, the compatibility
   contract declared live.

## 20. What Phase 5 deliberately does not build

- **No endpoints, no services, no schemas, no migrations.** This document is
  the design; a stubbed route would read as surface while providing none
  (Rules 8 and 14).
- **No dashboard UI** — Phase 9 consumes Part II and [§E](#e-clients);
  nothing here anticipates a component.
- **No rate limiter implementation** — the hook is designed ([§10](#10-rate-limiting-hooks));
  the mechanism, its store and its dependency decision belong to Phase 6
  (risk R-6).
- **No CSP/HSTS/malware scanning/quota engine** — Phase 6.
- **No seed data** — Phase 7; **no E2E** — Phase 8.
- **No second API version, no deprecation machinery** — `/v1` has no
  consumers outside this deploy until Phase 9; the compatibility contract
  ([§15](#15-versioning-and-the-compatibility-contract)) is the preparation,
  and building more would be speculative.

---

_Conformance: this design implements the Phase 1 API boundary
(`docs/architecture/README.md` §H) without weakening any row of it, resolves
the two decisions that boundary deferred to Phase 5 — the 405 question
(ADR-0027) and CORS (ADR-0014) — and adds two contracts of its own:
idempotency (ADR-0028) and one proposed RPC (ADR-0029). When implementation
completes, `/api/v1` becomes the contract, and this document's header flips
to **implemented**._

> **PHASE 5 API IMPLEMENTATION COMPLETE**
