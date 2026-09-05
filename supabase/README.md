# Supabase

Empty in Phase 1 by design: the schema does not exist yet, and inventing
migrations before the architecture was settled would have guaranteed rework.
Phase 2 populates this directory.

## Planned layout

```
supabase/
├── config.toml        local stack: signup DISABLED, SMTP, storage limits, JWT expiry
├── migrations/        forward-only, hand-written, numbered  YYYYMMDDHHMMSS_name.sql
├── seed.sql           synthetic local-dev data only — never production data (Rule 13)
└── tests/             pgTAP suites: the executable proof of tenant isolation
```

## Migration conventions

- **Forward-only.** A migration is never edited after it has been applied
  anywhere. Fixing a mistake means writing a new migration.
- **Hand-written SQL.** No ORM generates these (ADR-0004). The constructs that
  enforce tenancy — composite foreign keys, `SECURITY DEFINER` helpers, column
  grants, triggers — are exactly what generators handle worst.
- **Ordered so RLS is never absent.** Tables are created with `ENABLE ROW LEVEL
SECURITY` in the same migration that creates them. A table that exists without
  policies is briefly either fully open or fully closed depending on grants;
  neither is acceptable, even transiently.
- **Idempotent guards** (`if not exists`, `or replace`, `drop policy if exists`)
  so a re-run during local development is harmless.
- **`search_path` is pinned** on every function. Supabase's own linter flags a
  mutable search path, and it is a genuine hijack vector.

## Database connection strings (Phase 2)

This directory's tooling needs a PostgreSQL connection. The _application_ never
does. That asymmetry is deliberate, and it is why neither connection string
appears in `src/server/env.ts` or `.env.example` during Phase 1: a variable joins
the application contract only once application code reads it (ADR-0023 rule 6).
Both were declared in the first draft and removed by the Phase 1 architecture
review, because nothing consumed them and no code path ever could. Phase 2 adds
them back in the same change that introduces the migration runner which reads
them.

| Variable                 | Used by                                       | Why                                                                                                                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_DB_URL_DIRECT` | `supabase db push`, CI migrations, pgTAP runs | Migrations execute DDL, which needs a **session-mode** connection. Supavisor's transaction mode cannot reliably carry `CREATE TABLE`, `ALTER TYPE`, advisory locks or `SET` — a prepared statement or session setting can land on a different backend part-way through a migration. Port 5432. |
| `SUPABASE_DB_URL_POOLED` | nothing planned                               | Supavisor (port 6543) exists for serverless runtimes that would otherwise exhaust the connection limit. This application has no direct connection to pool, because every query goes through Supabase's API. Declaring it would advertise an architecture that does not exist.                  |

Both are **credentials**. Neither is ever prefixed `NEXT_PUBLIC_`, logged, or
committed, and the `.env.example` placeholder convention (a visibly fake
`REPLACE_WITH_…` password, asserted by test) applies to whichever is added.

The application reaches the database through `NEXT_PUBLIC_SUPABASE_URL` plus a
key: the anon key for tenant-scoped, RLS-filtered access, and the service-role key
for the confined cross-tenant operations in
`src/server/supabase/client-service.ts`. Giving application code a direct
connection would bypass RLS by accident rather than by decision, and would exhaust
the connection limit from serverless functions. If a future phase genuinely needs
one, that is an ADR — not an environment variable.

## Why the pgTAP suite is non-negotiable

Row Level Security cannot be proven by a unit test. The only evidence that
tenant isolation works is a query executed against a real PostgreSQL under a real
JWT, asserting which rows come back. `supabase/tests/` does exactly that: for
each role, and for two seeded organizations, it asserts visibility, writability,
cross-tenant denial, `client_visible` filtering, column-grant restrictions,
composite-FK rejection of a tenant mismatch, trigger-derived `organization_id`,
audit immutability, RPC authorization, and Storage prefix isolation.

These run in CI under Docker and locally via `supabase test db`.

> **Risk R-3.** The Phase 1 sandbox had no Docker, no Supabase CLI, no
> PostgreSQL and no network route to Supabase, so these policies could be
> authored but not executed there. Until they have actually run, RLS is reported
> as _authored, not executed_ — never as validated.
