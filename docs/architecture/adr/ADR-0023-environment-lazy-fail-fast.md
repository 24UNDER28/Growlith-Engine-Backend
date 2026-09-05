# ADR-0023: Environment Lazy Fail Fast

**Status:** Accepted
**Phase:** 1

## Context

The application needs two disjoint sets of configuration: values that are safe
to inline into the browser bundle, and values that must never leave the server —
above all `SUPABASE_SERVICE_ROLE_KEY`, which holds `BYPASSRLS`.

Two failure modes had to be avoided: reading configuration at import time, which
makes `next build` depend on production secrets being present; and discovering a
missing variable at first use, deep inside a request, as an unexplained 500.

## Decision

1. **Two contracts, two locations.**
   `src/lib/env/client-env.ts` (`CLIENT_ENV_KEYS`) for browser-exposed values,
   `src/server/env.ts` (`SERVER_ENV_KEYS`) for server-only values. Both are Zod
   schemas; both export their key list so the contract is inspectable.

2. **Lazy parsing.** `process.env` is read on first _access_, never at import
   time, so `next build` succeeds without secrets present.

3. **Fail fast at boot.** `instrumentation.ts` calls `reportEnvStatus()` once
   when the server process starts. With `APP_ENV=production` an incomplete
   environment throws and the process refuses to serve; otherwise it logs a
   warning listing every problem, keeping local development and image builds
   usable.

4. **Complete failure reports.** `EnvironmentError` carries a multi-line report
   of _every_ invalid variable, so an operator fixes configuration in one pass
   instead of one restart per missing key.

5. **The logger must not depend on the env contract.** `logger.ts` reads
   `LOG_LEVEL` directly. Otherwise a missing service-role key would throw while
   trying to log the warning about that same missing key, destroying the one
   diagnostic that explains the failure. An observability system that depends on
   the thing it reports on is not observable.

6. **No speculative variables.** A variable is declared only once something in
   this repository reads it. Auth and rate-limit configuration arrive with Phase
   3 and Phase 6, so `.env.example` never advertises a capability the code cannot
   honour (Rule 14).

   **Applied during the Phase 1 review.** The first draft of this contract
   declared `SUPABASE_DB_URL_POOLED` and `SUPABASE_DB_URL_DIRECT` as optional
   server variables. An audit found no consumer anywhere — not in `src/`, `app/`,
   `instrumentation.ts`, `scripts/`, or `.github/workflows/` — and no code path
   that could ever have one, because the application never opens a PostgreSQL
   connection: every query goes through Supabase's API with RLS as the
   enforcement point. Both were `z.url().optional()`, so they validated a value
   nothing read, and their presence in `.env.example` implied the application
   connects directly to the database — a misleading claim about the architecture.

   They are removed. Phase 2 reintroduces them alongside the migration runner
   that consumes them, at which point they are _tooling_ configuration read from
   the shell, not application configuration read through `getServerEnv()`. The
   reasoning about which connection string migrations require is recorded in
   `supabase/README.md` so it survives the removal.

   The key lists are now **derived from the schemas**
   (`Object.keys(schema.shape)`) instead of being hand-written beside them. Two
   hand-maintained statements of one contract can disagree silently, and the
   disagreement would be invisible: the parity test in rule 7 reads the list, so
   a variable added to the schema but missing from the list would escape every
   check while remaining unvalidated in practice. Derivation makes that class of
   drift unrepresentable, and makes this rule mechanically enforced rather than
   aspirational.

7. **The template cannot rot.** `tests/architecture/env-contract.spec.ts` asserts
   `.env.example` and `CLIENT_ENV_KEYS ∪ SERVER_ENV_KEYS` are exactly equal in
   both directions — which, given the derivation in rule 6, means exactly equal
   to the union of the two schemas, that no server-only key is `NEXT_PUBLIC_`-prefixed, and that
   every value in the template is an obvious placeholder.

8. **One sanctioned read site.** `process.env` is read only in the two env
   contracts, the logger's level, `instrumentation.ts`'s `NEXT_RUNTIME` guard,
   and Node build tooling. ESLint forbids it everywhere else in isomorphic code.

## Consequences

- `APP_ENV` uses `.catch('development')`: a typo degrades safely instead of
  preventing boot.
- A build artifact is bound to one environment, because `NEXT_PUBLIC_*` values
  are inlined at build time. Artifacts must never be promoted across
  environments.

## Alternatives rejected

- **Validating at import time**: breaks `next build` in CI, where secrets are
  often absent.
- **`@t3-oss/env-nextjs`**: a good library, but it adds a dependency for roughly
  the eighty lines above, and its schema lives outside the
  `src/lib` / `src/server` wall that ADR-0002 depends on (Rule 17).
