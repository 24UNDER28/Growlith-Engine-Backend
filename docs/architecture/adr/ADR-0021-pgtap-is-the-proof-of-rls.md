# ADR-0021: Executable Verification Is The Proof; RLS Is Never Reported As Validated Until It Has Run

**Status:** Accepted
**Phase:** 2

## Context

Row Level Security cannot be proven by a unit test. A test that reads migration
text proves the policy was _written_; only a query executed against a real
PostgreSQL, under a real role, asserting which rows come back, proves it
_works_. The Phase 1 plan named pgTAP under `supabase test db` as that proof.

The Phase 2 sandbox had PostgreSQL available but no Docker, and the Supabase CLI
requires Docker for both `supabase test db` and `supabase gen types --local`.
The choice was to skip verification and mark the phase done, or to build a
verification path that needs only a connection string.

## Decision

Three layers, each proving what the one below cannot.

1. **`tests/unit/schema.spec.ts`** — reads the migration SQL as text. Runs in
   `npm test` with no infrastructure. Catches enum drift against
   `src/lib/domain/`, missing RLS declarations, missing composite FKs, unpinned
   `search_path`, and destructive DDL. This is the layer that catches the silent,
   expensive mistake: editing a TypeScript vocabulary that production enum rows
   already reference.

2. **`scripts/db-verify.mjs`** — applies to a live PostgreSQL and asserts both
   structure (every table has a PK; every FK is index-backed; every tenant table
   carries `organization_id` and a composite FK; internal-only columns are not
   granted) and **behaviour** (cross-tenant writes rejected; tenant key derived
   and frozen; illegal status transitions refused; append-only tables immutable;
   audit rows written with the right action and severity). 91 checks.

   Structure alone is not evidence. A composite FK that exists but is never
   violated in a test proves nothing about whether it points where it should.

3. **pgTAP under `supabase test db`** — still required, still Phase 4's
   obligation, because none of the above executes a query _as a specific role
   under a real JWT_. That is the only thing that proves a `CLIENT_MEMBER` of
   Acme cannot read Globex.

`scripts/db-apply.mjs` and `scripts/db-types.mjs` exist for the same reason: the
Supabase CLI remains canonical (`npm run db:types`), and these are
Docker-free equivalents reading the same catalog, so a missing Docker daemon
never becomes a reason to hand-write a generated file.

## Consequences

- **Risk R-3 remains open.** Phase 2's policies are three reference-data reads;
  the tenant policies do not exist yet. When Phase 4 writes them, RLS is reported
  as _authored, not executed_ until the pgTAP suite has actually run in CI under
  Docker.
- `npm run db:check` is the full gate: reset, apply, seed, verify, type-drift
  check. It runs against any PostgreSQL 15+.
- Two findings were caught by layer 2 during Phase 2 itself: unprotected audit
  partitions, and 22 composite foreign keys with no matching index. Both were
  invisible to inspection and to layer 1.
