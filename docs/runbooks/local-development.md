# Local Development Runbook

## Prerequisites

| Tool         | Version    | Notes                                                                                     |
| ------------ | ---------- | ----------------------------------------------------------------------------------------- |
| Node.js      | 22.x       | Pinned in `.nvmrc` and `package.json` → `engines`. Next 16 requires `>=20.9.0`            |
| npm          | 10.x       | The only supported package manager. `package-lock.json` is committed and CI uses `npm ci` |
| Docker       | any recent | **Phase 2 onward** — the local Supabase stack and the pgTAP RLS tests                     |
| Supabase CLI | latest     | **Phase 2 onward** — `supabase start`, `db reset`, `gen types`, `test db`                 |

Phase 1 needs only Node and npm.

## First-time setup

```bash
nvm use                      # selects Node from .nvmrc
npm ci                       # install exactly what the lockfile pins
cp .env.example .env.local   # then fill in the values
```

`.env.local` is gitignored; `.env.example` is the only tracked env file and must
contain placeholders only.

**Phase 1 can run without any Supabase project.** Environment parsing is lazy
(ADR-0023): nothing reads configuration until it is used, so the dev server, the
tests, the build and the health probe all work with an empty `.env.local`. With
`APP_ENV` unset the boot check logs a warning listing what is missing rather than
failing.

## Everyday commands

```bash
npm run dev                      # dev server on http://localhost:3000
npm run typecheck                # tsc --noEmit, strict
npm run lint                     # eslint (includes the client/server wall rules)
npm run format                   # prettier --write
npm test                         # vitest run — unit, contract, architecture
npm run test:watch               # vitest in watch mode
npm run build                    # production build
npm run check:client-exposure    # scan emitted client bundles for secrets
npm run validate                 # everything above, in gate order
```

Smoke-test a running server:

```bash
curl -i http://localhost:3000/api/v1/health
# → 200, {"data":{"status":"ok"},"meta":{"requestId":"…","tookMs":N}}
# → response carries x-request-id, which is the same id in the server log
```

## Phase 2 additions (not yet available)

Once migrations exist:

```bash
supabase start                        # local stack (Docker)
supabase db reset                       # re-apply all migrations + seed.sql
supabase test db                        # pgTAP — the RLS proof (level L4)
npm run db:types                        # regenerate src/types/database.ts
```

`npm run db:types` output is **committed**. CI fails if the generated file
differs from what the migrations produce, so schema and types cannot drift
silently (ADR-0004).

## Understanding a failure

| Symptom                                                           | First place to look                                                                                                                                                        |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `next build` fails mentioning `server-only`                       | A client graph reaches `src/server/**`. The error names the whole import chain. See ADR-0002                                                                               |
| `check:client-exposure` fails                                     | A credential reached `.next/static`. The output names the exact chunk and shows surrounding bytes                                                                          |
| `Environment configuration is invalid` at boot                    | The multi-line report lists every invalid variable at once; fix all of them before restarting                                                                              |
| An architecture test fails                                        | A structural invariant broke — e.g. a new `src/server/**` file is missing its `import 'server-only'`, or an isomorphic module reads `process.env`. The test names the file |
| Lint reports `no-restricted-imports` in `src/lib` or `components` | The wall was crossed. Move shared code to `src/lib`, or do the work in a route handler                                                                                     |
| `404` from an API route that should exist                         | Route params are delivered asynchronously in Next 15+; confirm the folder naming. Note `_`-prefixed folders are **private** and excluded from routing                      |

## Conventions that are enforced mechanically

Do not rely on remembering these — each has a test or a lint rule behind it:

- Every module under `src/server/**` begins with `import 'server-only';`.
- `src/lib/**` and `components/**` never import `@/server/*` and never read
  `process.env` (except `src/lib/env/client-env.ts`).
- `src/server/**` never imports UI.
- No raw `console.*` outside `src/server/logging/`.
- No `any` anywhere.
- Every `app/api/**/route.ts` is built with `withRoute`.
- No barrel file in `src/server/supabase/`.
- The runtime dependency list is exactly the approved set — adding one requires
  editing `tests/architecture/configuration-conventions.spec.ts`, which is the
  point (Rule 17).

## Editor setup

`.editorconfig` and `.prettierrc.json` define formatting; `npm run format:check`
runs in CI, so formatting disagreements are settled by the tool rather than in
review. Enable "format on save" with Prettier as the formatter and ESLint run
separately — do not use ESLint as a formatter.
