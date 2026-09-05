# Supabase

Phase 2 populated this directory: 24 migrations creating 23 tables, 36 enums,
104 foreign keys and 312 indexes, with RLS enabled and forced on every relation.
See [`docs/architecture/schema.md`](../docs/architecture/schema.md) for the
schema reference and the ADR register for the reasoning.

## Layout

```
supabase/
├── migrations/        forward-only, hand-written, YYYYMMDDHHMMSS_name.sql  (24 files)
├── seed.sql           synthetic local-dev data only — never production data (Rule 13)
├── config.toml        local stack config                        ← Phase 3 (auth)
└── tests/             pgTAP suites: the executable proof of RLS  ← Phase 4
```

`config.toml` and `tests/` are still absent, and deliberately so. `config.toml`
configures Auth (signup disabled, SMTP, JWT expiry) which Phase 2 does not
implement. `tests/` proves RLS policies, and Phase 2 ships three
reference-data policies rather than the tenant policy set — a pgTAP suite
asserting "the default-deny state denies" would be theatre.

## Applying the migrations

Two paths, one file set.

```bash
# Canonical, on Supabase or the local stack (needs Docker):
supabase db push

# Docker-free, against any PostgreSQL 15+:
export DATABASE_URL='postgresql://…'
npm run db:apply       # transactional, checksum-ledgered, skips applied files
npm run db:check       # reset · apply · seed · verify · type-drift check
```

`scripts/db-apply.mjs` records a SHA-256 of each applied file and **refuses to
proceed if an already-applied migration has changed**. Forward-only is enforced,
not just documented.

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

| Variable                 | Used by                                                           | Why                                                                                                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_DB_URL_DIRECT` | `supabase db push`, `scripts/db-*.mjs`, CI migrations, pgTAP runs | Migrations execute DDL, which needs a **session-mode** connection. Supavisor's transaction mode cannot reliably carry `CREATE TABLE`, `ALTER TYPE`, advisory locks or `SET` — a prepared statement or session setting can land on a different backend part-way through a migration. Port 5432. |
| `SUPABASE_DB_URL_POOLED` | nothing planned                                                   | Supavisor (port 6543) exists for serverless runtimes that would otherwise exhaust the connection limit. This application has no direct connection to pool, because every query goes through Supabase's API. Declaring it would advertise an architecture that does not exist.                  |

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

## Verification today

Three layers, described in
[ADR-0021](../docs/architecture/adr/ADR-0021-pgtap-is-the-proof-of-rls.md):

| Layer                                  | Needs                 | Proves                                                                                                                                                                                                |
| -------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/schema.spec.ts` (42 tests) | nothing               | enum parity with `src/lib/domain/`, RLS declared on every table, composite FKs present, `search_path` pinned, no destructive DDL                                                                      |
| `scripts/db-verify.mjs` (91 checks)    | a PostgreSQL          | structure **and behaviour**: cross-tenant writes rejected, tenant key derived and frozen, illegal transitions refused, append-only tables immutable, audit rows correct, internal columns not granted |
| `supabase/tests/` pgTAP                | Docker + Supabase CLI | **outstanding** — the only layer that runs queries as a real role under a real JWT                                                                                                                    |

Layer 2 earned its place during Phase 2 by catching two defects that inspection
and layer 1 both missed: fourteen audit partitions with no row security
(partitions do not inherit it), and 22 composite foreign keys whose single-column
indexes did not satisfy them, turning every cascade into a sequential scan.

## Why the pgTAP suite is non-negotiable

Row Level Security cannot be proven by a unit test. The only evidence that
tenant isolation works is a query executed against a real PostgreSQL under a real
JWT, asserting which rows come back. `supabase/tests/` does exactly that: for
each role, and for two seeded organizations, it asserts visibility, writability,
cross-tenant denial, `client_visible` filtering, column-grant restrictions,
composite-FK rejection of a tenant mismatch, trigger-derived `organization_id`,
audit immutability, RPC authorization, and Storage prefix isolation.

These run in CI under Docker and locally via `supabase test db`.

> **Risk R-3 — still open.** The Phase 2 sandbox had PostgreSQL but no Docker,
> so the migrations were applied and verified against a real PostgreSQL 18 while
> the pgTAP suite could not be run. Phase 2's three policies cover global
> reference data only, so there is no tenant policy to validate yet. When Phase 4
> writes them, RLS stays reported as _authored, not executed_ until pgTAP has
> actually run in CI.
