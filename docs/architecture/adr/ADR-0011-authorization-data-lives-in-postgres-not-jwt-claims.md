# ADR-0011 — Authorization data lives in PostgreSQL, not in JWT claims

**Status:** Accepted (Phase 3 design; implementation pending — see
`docs/architecture/authentication.md`)
**Phase:** 3 · **Supersedes the registered proposal** of the same number
("platform role travels in `app_metadata` and is re-verified against the
database for privileged operations"), amended during design for the reasons
below. The amendment is recorded here rather than silently in the register.

## Context

Phase 1's architecture table left the claims question open and the ADR
register proposed an answer: carry the platform role in GoTrue `app_metadata`
(so middleware could gate `/admin` without a database hit) and re-verify
against the database for privileged operations. Phase 2 then delivered the
raw material that makes a better option cheap:

- `SECURITY DEFINER` helpers with pinned `search_path` and `STABLE`
  (`auth_platform_role()`, `is_active_account()`, `current_org_ids()`) —
  the database already has a fast, recursion-free definition of "who holds
  what";
- an indexed, hot-path-shaped schema (`organization_memberships_user_idx`)
  for exactly these lookups;
- the Phase 1 rule that middleware is a routing gate, never a security
  boundary.

The claims-based proposal has two costs that only became concrete once Phase 2
landed:

1. **Revocation latency.** A role or account state written to the database
   does not rewrite issued JWTs. A claims-based design has a staleness window
   bounded by the access-token TTL (up to an hour) unless it also revokes
   sessions on every administrative change — turning a cheap status flip into
   a distributed operation whose failure modes are worse than the problem.
2. **Two sources of truth.** Even with re-verification, the claim must exist,
   must be maintained by every grant/revoke path, and must be _documented as
   wrong_ wherever it disagrees with the database. Authorization systems die
   by ambiguity, and ambiguity is exactly what a second copy of the answer is.

## Decision

1. **No authorization data in JWTs.** Roles, statuses, organization
   memberships and permissions are never written into access-token
   `app_metadata` or `user_metadata`, and are never read from a token.
2. **The database is the single authority.** Every request that needs to know
   "who is this and what may they touch" resolves it per request through the
   `SECURITY DEFINER` function `growlith.auth_context()` — called with the
   caller's own JWT through the request-scoped client — which reuses the same
   Phase 2 predicates (`auth_platform_role()`, `is_active_account()`,
   `current_org_ids()`) that Phase 4 RLS policies will use. Application guard
   and RLS therefore cannot disagree: they read the same definition.
3. **Exactly one exception, non-authoritative.** `app_metadata.user_type`
   (`INTERNAL` | `CLIENT`) is written once at invitation time and is used only
   for coarse landing/routing hints in `middleware.ts`. A stale or absent hint
   can send a user to the wrong landing page; it can grant nothing, because
   every authoritative surface re-resolves from the database.
4. **`user_metadata` remains untrusted** for any authorization purpose (Phase
   1 rule), being user-writable; it is read only by the profile-creation
   trigger for a display-name fallback.

## Consequences

**Positive**

- Revocation is immediate: suspending an account or revoking a role takes
  effect at the next request with no token rewrite, no session revocation and
  no race window.
- One definition of authorization exists, in SQL, shared by the application
  guard and (in Phase 4) by RLS policies. Drift is unrepresentable rather
  than forbidden.
- A stolen token carries no privilege beyond "is this a live session", which
  shrinks what a leak is worth.

**Negative / accepted costs**

- One extra database round trip per authenticated request. Mitigated: it is a
  single indexed read behind a `STABLE` definer function, issued on the same
  connection as the request's other work, and memoised per request via
  `withRoute`/`cache()`.
- Middleware cannot gate on roles and cannot distinguish an internal from a
  client user except via the `user_type` hint. Accepted: that is all middleware
  was ever allowed to do (Rule 8).
- If a future feature needs per-request authorization decisions at high fan-in
  (e.g. per-row UI affordances), it still resolves from `auth_context()`
  output memoised for the request — not from claims. This is a shape that
  Phase 4's capability matrix is designed around.

**Verification at implementation:** the architecture test suite gains a rule
that no module writes role/status/organization data into `auth.updateUser`
metadata, and the contract suite asserts `requireAuthContext()` is the only
session-resolution path.
