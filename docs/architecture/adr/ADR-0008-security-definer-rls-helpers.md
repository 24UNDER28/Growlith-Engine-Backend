# ADR-0008: RLS Predicates Are `SECURITY DEFINER` Helpers With A Pinned `search_path`

**Status:** Accepted
**Phase:** 2

## Context

Almost every policy needs the same facts: does the caller hold a platform role,
which organizations do they belong to, is their account still active. Written
inline, each becomes a correlated subquery inside a policy predicate.

That fails three ways.

**Recursion.** A policy on `organization_memberships` whose predicate selects
from `organization_memberships` recurses infinitely. This is not hypothetical;
it is the first thing that happens when the membership table gets its own
policy.

**Per-row evaluation.** A `VOLATILE` predicate is re-evaluated for every
candidate row. On a list query over a large table that is the difference between
an index scan and an outage.

**Duplication.** The same predicate copy-pasted into forty policies will drift,
and the drifted copy is the one that grants too much.

## Decision

Every RLS predicate is a function in `public`, declared:

- **`SECURITY DEFINER`** — runs as the owner, so it reads the membership table
  with RLS bypassed and returns a plain value. This is what breaks the recursion.
- **`STABLE`** — the planner may evaluate it once per statement rather than once
  per row.
- **`set search_path = pg_catalog, public, pg_temp`** — a mutable `search_path`
  on a `SECURITY DEFINER` function is a genuine hijack vector: an attacker who
  can create a schema earlier in the path can substitute their own
  `organization_memberships`. Supabase's own linter flags this, and
  `tests/unit/schema.spec.ts` fails the build if any function in a migration
  omits it.

The helpers created in Phase 2 are `auth_platform_role()`, `is_super_admin()`,
`is_platform_admin()`, `is_active_account()`, `current_org_ids()`,
`org_role_in()`, `has_org_access()`, `is_client_admin_of()`,
`current_team_codes()`, `is_on_team()`, `storage_path_org_id()` and
`can_access_storage_path()`.

Trigger bodies live in a separate `growlith` schema with `usage` revoked from
`public`, so PostgREST cannot expose them as RPC endpoints. The RLS predicates
live in `public` because policies and, later, the application must call them.

## Consequences

- `auth_platform_role()` honours revocation, expiry _and_ account status, so
  suspending an account revokes access at the database rather than at the login
  screen.
- `has_org_access()` is backed by `organization_memberships (user_id) where
deleted_at is null` — the hottest index in the schema, read on effectively every
  authenticated statement.
- No policy may be written without one of these helpers. A predicate that
  queries a tenant table directly is a review failure.
