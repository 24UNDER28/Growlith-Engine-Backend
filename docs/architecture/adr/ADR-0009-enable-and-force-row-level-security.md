# ADR-0009: `ENABLE` **And** `FORCE` Row Level Security, Asserted By Migration

**Status:** Accepted
**Phase:** 2

## Context

`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` does not apply to the table's owner.
Migrations run as the owner. So do several Supabase internals. A table with
`ENABLE` alone is fully readable by exactly the roles most likely to be used by
mistake.

Separately, a table created without RLS is briefly either fully open or fully
closed depending on grants. Neither is acceptable, even transiently, and "we
will add the policies in the next migration" is how a table ends up in
production with none.

## Decision

Three rules, each mechanically enforced rather than documented.

1. **Every table enables _and_ forces RLS in the migration that creates it.**
   Not a later one.

2. **Migration 23 asserts coverage and fails the migration if any table in
   `public` lacks either flag.** This is not a lint that can be skipped; it is a
   `raise exception` inside the transaction, so a non-compliant schema cannot be
   applied at all.

3. **`tests/unit/schema.spec.ts` asserts the same property by reading the SQL**,
   so the rule is also enforced with no database available.

Rule 2 immediately earned its place. Partition tables do **not** inherit their
parent's row security when queried directly, and PostgREST exposes
`audit_events_202609` as its own resource. The assertion caught fourteen
unprotected partitions on the first clean apply; `ensure_audit_partition()` now
sets both flags on every partition it creates.

## Consequences

- Deny-by-default is the resting state. Phase 2 ships three policies — read
  access to `teams`, `service_lines` and `status_transitions`, which are global
  reference data with nothing to isolate. Every other table returns zero rows to
  `authenticated` until Phase 4 writes its policies.
- That is deliberate. A partial policy set is worse than none, because it looks
  finished.
- 38 relations have RLS enabled and forced: 23 tables, 1 partitioned parent, 14
  partitions.
