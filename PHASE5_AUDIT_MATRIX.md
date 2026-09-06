# Phase 5 — API Contract & Security Audit: Endpoint Matrix

Scope: every `/api/v1/**` route (`app/api/v1`), audited against `docs/architecture/api.md`,
the permission matrix (`src/lib/domain/permissions.ts`) and the migration/RLS layer.
Basis: full source review of the route wrapper, authorization core, every service and
route, plus 27 new regression tests in 5 new spec files. Full suite: **29 files / 604
tests green**; `typecheck`, `lint`, `build`, client-exposure scan all green.

Legend: **PASS** = contract-conformant after the fixes below (code review + regression
tests). **PASS\*** = conformant with a documented residual (see §3). **FAIL** = confirmed
defect fixed this phase (see §1 for the fix). **NOTE** = observation, no defect.

## 1. Confirmed defects fixed this phase

| #   | Defect                                                                                                                                                                                                                                                             | Impact before fix                                                                                                                       | Fix (files)                                                                                                                                                                                                                               | Regression tests                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| F1  | Project-membership child routes addressed a membership only by `membershipId`; an ADMIN/LEAD of project P could PATCH/DELETE a membership row of project Q through P's path                                                                                        | Cross-project mutation inside the same tenant                                                                                           | `projects.ts` loads the membership and 404s when `project_id ≠` the path project before mutate/audit; route forwards `projectId`                                                                                                          | `project-member-scope.spec.ts`      |
| F2  | Same pattern on **organization** memberships (definer RPCs `update_/remove_organization_member` had no org check)                                                                                                                                                  | Org A manager could mutate org B's membership by id                                                                                     | `memberships.ts` + org member route: verify `organization_id ===` path org → 404 before RPC                                                                                                                                               | `org-member-scope.spec.ts`          |
| F3  | `listLive` keyset cursor used the caller's `keyOf` (`created_at`) instead of the actual sort column for alternate sorts; NULL sort values had no ordered placement or tail bound; raw cursor keys interpolated into PostgREST `or(...)` without grammar validation | Skipped/duplicated rows across pages for `sort=dueDate`-style lists; NULL-heavy pages repeated; crafted cursor could rewrite the filter | `crud.ts`: key = value of the real sort column, `nullsFirst:false`, NULL-tail `is null AND id.lt`, cursor key/id validated (`page.ts`) before any DB call                                                                                 | `crud-list.spec.ts`                 |
| F4  | `sqlSortColumn` silently fell back to `created_at` for unmapped text sorts (`name`, `title`) → wrong ordering claimed while docs advertised text sorts                                                                                                             | Wrong result order; unsupported contract                                                                                                | `SORT_COLUMNS` closed map; unmapped key = loud 500 (deployment bug); text keys removed from users/orgs listers                                                                                                                            | `crud-list.spec.ts`                 |
| F5  | `listGrants` (staff activity/grants feed) interpolated cursor into `or(...)` unguarded; a `key: null` cursor on a NOT-NULL column was accepted                                                                                                                     | Filter-grammar injection vector (RLS-contained); forged null-key cursors                                                                | `grants.ts` validates cursor + rejects null-key as forged; shared `assertKeysetPayloadForFilter`                                                                                                                                          | `crud-list.spec.ts` (shared helper) |
| F6  | `PATCH /files/{id}` allowed a CLIENT to set `clientVisible=true` on its own upload after the parent became visible                                                                                                                                                 | Internal attachment published to the whole client audience (doc L-6: field is staff-only)                                               | `files.ts` refuses `clientVisible` for non-staff actors (422 before write)                                                                                                                                                                | `files-patch-client.spec.ts`        |
| F7  | `/users` list accepted staff-only directory filters (`q`, `status`, `userType`, `team`) from CLIENT actors; documented `ids` lookup unsupported; `q` values with `, ( ) "`/control chars reached PostgREST `or(ilike)` raw                                         | Client enumeration oracle for staff presence/account states; schema-invalid search could corrupt filter grammar                         | `users.ts` (422 for staff-only filters on client calls; `ids` csv ≤50 via RLS), `searchQueryField` in `common.ts`/`resources.ts`                                                                                                          | `phase5-validation.spec.ts`         |
| F8  | Ascending sort keys documented for rosters/deadline/board views were impossible: `listLive` ordered everything DESC — `sort=position` returned a kanban board in reverse order                                                                                     | Wrong order on 8 list endpoints                                                                                                         | `crud.ts` ascending keyset support (bound/id-tiebreak/NULL-tail all direction-aware); wired to members rosters (C-6, C-14, H-8), `targetDate` (H-2), `dueDate` (I-2/J-2), `position` (I-2), `expiresAt` (C-2), default `metricDate` (K-8) | `crud-list.spec.ts` (asc bounds)    |
| F9  | `createReport` accepted `periodEnd < periodStart` (doc K-1 validation missing)                                                                                                                                                                                     | Backwards-dated report periods                                                                                                          | `.superRefine` on `createReportBodySchema`                                                                                                                                                                                                | `phase5-validation.spec.ts`         |

## 2. Endpoint matrix

Conventions: AAL floors, audit rows, idempotency, rate classes, error mapping and body
limits are enforced structurally by `withRoute` (all routes). **cap** = capability +
tenant/project/subject resolution verified; **iso** = tenant isolation (404-before-403,
ADR-0019); **val** = schema validation incl. `.strict()` (mass-assignment) — verified for
every row below unless a cell says otherwise.

### A. Auth & session (`auth/*`)

| Endpoint                                                                   | Methods  | Auth     | AuthZ                           | iso | val                                           | Verdict |
| -------------------------------------------------------------------------- | -------- | -------- | ------------------------------- | --- | --------------------------------------------- | ------- |
| `POST /auth/login`                                                         | POST     | public   | n/a                             | n/a | login schema; uniform 401 (no account oracle) | PASS    |
| `POST /auth/logout`                                                        | POST     | public   | session-bound                   | n/a | —                                             | PASS    |
| `GET /auth/session`                                                        | GET      | public   | session-bound                   | n/a | —                                             | PASS    |
| `POST /auth/password`                                                      | POST     | required | `user:update` SELF + capability | —   | pwd schema                                    | PASS    |
| `POST /auth/password-recovery`                                             | POST     | public   | n/a                             | n/a | email schema                                  | PASS    |
| `POST /auth/mfa/enroll` `/challenge` `/unenroll` · `GET /auth/mfa/factors` | POST/GET | required | SELF + minAal where declared    | —   | MFA schema                                    | PASS    |

### B. Identity (`me`, `users`, `accounts`, `admin/users`)

| Endpoint                                                            | Verdict | Notes                                                                                                           |
| ------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /me`, `PATCH /me`                                              | PASS    | profile update SELF-scoped; whitelist schema                                                                    |
| `GET /users`                                                        | PASS    | F7 fixed (client filter denial + `ids`); sort `createdAt` only (doc aligned); output audience via column grants |
| `GET /users/{userId}`                                               | PASS    | shared-org tenant resolver; invisible ⇒ 404                                                                     |
| `POST /accounts/{userId}/{suspend,reinstate,deactivate,reactivate}` | PASS    | platform-gated, SUPER_ADMIN floor on reactivate, minAal2, audited CRITICAL, session/ban revoke                  |
| `POST /admin/users/{userId}/erase`                                  | PASS    | definer RPC, last-SUPER_ADMIN lockout, CRITICAL audit                                                           |
| `users.ts patchUser` (service)                                      | NOTE    | unreachable dead code (no route) — cleanup candidate                                                            |

### C. Invitations · membership · platform power

| Endpoint                                                         | Verdict | Notes                                                       |
| ---------------------------------------------------------------- | ------- | ----------------------------------------------------------- |
| `POST /invitations`, `GET /invitations`, `GET /invitations/{id}` | PASS    | RPC-backed; org-scoped; `expiresAt:asc` alternate added     |
| `POST /invitations/{id}/resend` `/revoke`                        | PASS    | definer RPC + audit                                         |
| `GET/POST /organizations/{id}/members`                           | PASS    | POST via definer `add_organization_member`                  |
| `PATCH/DELETE /organizations/{id}/members/{membershipId}`        | PASS    | **F2 fixed** (org-scope pre-check, 404, no RPC on mismatch) |
| `GET/POST /admin/platform-grants` · `POST …/{userId}/revoke`     | PASS    | SUPER_ADMIN-only cells, minAal2, definer RPCs               |
| `GET /admin/teams`, `GET /admin/teams/{team}/members`            | PASS    | internal-only capability; roster asc (F8)                   |
| `POST /admin/team-memberships`, `PATCH/DELETE …/{membershipId}`  | PASS    | staff-only; audit                                           |

### D–K. Tenant object graph (orgs → engagements → services → projects → tasks/deliverables → reports/metrics)

Row-level detail (each route uses tenant ← path / row-through-RLS / list-query as documented; state moves only via dedicated status routes with `assertTransitionAllowed` + trigger):

| Route group                                                                                                                                                                                                    | Verdict | Notes                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `POST/GET /organizations`; `GET/PATCH/DELETE /organizations/{id}`; `PUT/GET …/settings`; `POST …/status`; `POST …/assign`                                                                                      | PASS    | client list ⇒ 404 no-tenant (doc aligned); org DELETE = SUPER_ADMIN RPC, minAal2, slug confirm; settings whitelist                   |
| `GET …/activity`, `GET /admin/activity`                                                                                                                                                                        | PASS    | client feed via definer RPC; staff keyset on `occurred_at` (tie-break id noted below)                                                |
| `POST /organizations/{id}/engagements`, `GET/PATCH/DELETE /engagements/{id}`, `POST …/status`, `POST …/assign`, `POST …/services`, `GET/POST /services`, `PATCH/DELETE /services/{id}`, `POST …/status/assign` | PASS    | parent org inherited from path/parent row; FK layer enforces parent-org consistency (409); alternates `startDate`/`renewalDate` desc |
| `GET/POST /projects` (child `…/{id}/projects`), `GET/PATCH/DELETE /projects/{id}`, `POST …/status`, `POST …/assign`, `GET/POST …/members`, `PATCH/DELETE …/members/{membershipId}`                             | PASS    | **F1 fixed**; project org inherited from parent service row; H-2 `targetDate:asc` (F8)                                               |
| `GET/POST /tasks`, `GET/PATCH/DELETE /tasks/{id}`, `POST …/status`, `POST …/assign`                                                                                                                            | PASS    | project load + org inherit; `dueDate:asc`, `position:asc` (F8)                                                                       |
| `GET/POST /deliverables`, `GET/PATCH/DELETE /deliverables/{id}`, `POST …/{status,assign,approve,publish,reviews}`, `GET …/versions`                                                                            | PASS    | client gate via RLS + obligations; approve/publish definer RPCs; J-2 `dueDate:asc` (F8)                                              |
| `GET/POST …/reports` (under org), `GET/PATCH/DELETE /reports/{id}`, `POST …/publish`, `GET …/download-url`, `GET /metrics`                                                                                     | PASS    | **F9 fixed**; publish RPC audited; download-url mints signed URL from the `REPORT_EXPORT` file row                                   |
| `GET /status-transitions`                                                                                                                                                                                      | PASS    | reference data, all roles                                                                                                            |

### L–Q. Files · comments · notifications · health

| Route group                                                                                                      | Verdict | Notes                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /files/upload-url` · `POST /files` · `GET /files` · `GET/PATCH/DELETE /files/{id}` · `POST …/download-url` | PASS\*  | **F6 fixed**; parent-scoped tenant; storage-path prefix check; signed URLs 60s. Residual: L-1 object HEAD verification absent (see §3.1) |
| `GET/POST /comments`, `GET/PATCH/DELETE /comments/{id}`                                                          | PASS    | exactly-one-subject enforcement; author-edit window; internal/client split; staff delete per matrix                                      |
| `GET /notifications`, `GET/PATCH /notifications/{id}`                                                            | PASS    | recipient-scoped (service + RLS); SELF read/mark                                                                                         |
| `GET /health`                                                                                                    | PASS    | public, no data                                                                                                                          |

## 3. Documented residuals (non-blocking, open)

1. **L-1 object verification**: `registerFile` does not HEAD the storage object (size/checksum/existence), so the documented `409 file_not_found_in_storage / size_mismatch` paths are not emitted; a row can reference a missing/foreign object path (same-org prefix required). Requires Storage API capability; tracked for Phase 6 hardening. Row reads stay gated by RLS + parent visibility.
2. **Staff activity keyset** (`GET /admin/activity`) keys only on `occurred_at`; identical-timestamp boundary rows could skip/duplicate in rare concurrent-commit cases (no id tie-break in the view projection). Low risk; noted.
3. **`statusChangeBodySchema`** accepts any ≤64-char token; an unknown/misspelled label yields `409` via the transition catalogue rather than `422` — matches the documented error contract (409 only).
4. **`DELETE` with optional reason body** (org member) requires a JSON body `{}`; body-less DELETE is 400 by the shared body reader. Documented shape accepts an empty body; DX deviation only.
5. **Rate limiting** is declaration-only (`rateLimit.class`) — enforced in Phase 6 by design.
6. Client `clientVisible` at _registration_ time remains allowed (per L-1); parent-visibility gate in RLS contains it; PATCH-time flip (the real leak) is now refused (F6).
7. Output shaping of staff-only profile fields relies on the DB column-grant layer (§F.1), not the DTO mapper — verified present in migrations; runtime verification requires a live Postgres (not available in this environment).

**Final gates:** `npm run typecheck` ✅ · `npm run lint` ✅ · `npm test` 604/604 ✅ (29 files; incl. 5 new regression specs) · `npm run build` ✅ · `check:client-exposure` ✅

PHASE 5 VALIDATED
