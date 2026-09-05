# `src/lib` — isomorphic layer

**This directory must be provably secret-free.** Everything here can end up in a
browser bundle, so nothing here may hold a credential, touch the database, or
depend on a server-only module.

Enforced three ways: an ESLint restriction, an architecture test, and a
post-build bundle scan. See
[`ADR-0002`](../../docs/architecture/adr/ADR-0002-client-server-boundary-wall.md).

## Rules

1. **Never import `@/server/*` or `server-only`.** Lint error and test failure.
2. **Never read `process.env`** — the single exception is
   `env/client-env.ts`, which reads only `NEXT_PUBLIC_*` values and validates
   them. A bare `process.env.FOO` here compiles to `undefined` in the browser:
   a silent failure that is miserable to trace.
3. **No database access.** Queries belong in `src/server`.
4. **No React.** This layer is UI-agnostic so route handlers and tests can use it.
5. **No browser-only APIs.** "Isomorphic" means the module must be _safe to run
   on both sides_, not merely safe to import. Nothing here may touch `document`,
   `window`, `localStorage`, or any other API that exists only in a browser —
   such a module cannot be called from a Server Component, a route handler, or
   middleware, so it does not belong in this tier.

## Layout

| Path                | Purpose                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `domain/`           | Vocabulary: roles, internal teams, service lines, the entity hierarchy. Data, not behaviour |
| `env/client-env.ts` | The browser environment contract (`CLIENT_ENV_KEYS`)                                        |
| `errors/`           | Error types shared across the wall                                                          |
| `pagination/`       | Keyset cursor codec and page-size policy                                                    |
| `types/`            | API envelope, error codes, pagination, HTTP                                                 |
| `utils/`            | Request-id correlation                                                                      |
| `validation/`       | Shared Zod primitives and issue formatting                                                  |

## Deliberately absent

**Entity types and entity schemas.** Field-level entity types are **generated**
from the database in Phase 2 (`npm run db:types` → `src/types/database.ts`), and
entity validation schemas arrive with their endpoints in Phase 5. Writing either
now would guarantee drift (ADR-0004, ADR-0017).

**A browser Supabase client factory.** `createBrowserClient` reads and writes
`document.cookie`, which violates rule 5, and Phase 1 has no consumer for it. Its
placement is decided in Phase 3 alongside the first component that needs it — the
options and the reasoning are recorded in `docs/architecture/README.md` §E.
Supabase clients in this repository therefore live in `src/server/supabase/`
only, until a browser-only tier exists.

`domain/roles.ts` documents the known role-model gap (risk R-1) on `ROLES`, and
`tests/unit/domain.spec.ts` fails the moment a fifth role appears without the risk
register being updated in the same change. The gap is recorded, not resolved
unilaterally.
