# ADR-0004: No Orm Generated Types

**Status:** Accepted
**Phase:** 1

## Context

The system's authorization lives in PostgreSQL: Row Level Security policies,
`SECURITY DEFINER` helper functions, composite foreign keys, column-level
grants, triggers and RPCs. An ORM's value is abstracting the database; here the
database is exactly what must not be abstracted.

## Decision

No ORM. Hand-written, forward-only SQL migrations in `supabase/migrations/`,
with TypeScript types **generated** from the live schema via
`supabase gen types typescript` into `src/types/database.ts` (committed).

## Consequences

- Full, unmediated control over the constructs that enforce tenancy.
- `src/types/database.ts` is generated, committed, and checked for drift in CI, so
  schema and types cannot diverge silently.
- In Phase 1 the generated file declares empty `Tables`/`Views`/`Functions`
  records. This is load-bearing, not a placeholder: a typed
  `SupabaseClient<Database>` will not compile a query against a table that does
  not exist yet, so the boundary could be built now without inventing a
  persistence model that Phase 2 would contradict.
- Trade-off: hand-written SQL is more verbose than ORM calls. Accepted — the
  verbosity is where the security guarantees are written down.

## Alternatives rejected

- **Prisma**: its migration model conflicts with hand-authored RLS, and it
  cannot express composite foreign keys or column-level grants.
- **Drizzle**: closer to SQL, but still adds a query layer whose type inference
  would compete with the generated `Database` type rather than reuse it.
