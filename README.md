# Growlith Engine

The portal for both **clients** and **administrators** of
[Growlith Academy](https://growlithacademy.com) — a multi-tenant delivery system
organised as Organization → Engagement → Service → Project → Deliverable → Task.

> **Repository name.** This repo is called `…-Backend`, but it holds one Next.js
> application containing both dashboards _and_ the server-side API
> ([ADR-0001](docs/architecture/adr/ADR-0001-single-nextjs-application.md)). The
> name predates that decision; renaming is cheap now and expensive later.

**Current status: Phase 1 (Architecture) complete and validated.**
Authentication, authorization, business APIs, seed data and dashboard UI are
later phases and are deliberately absent — no stubs stand in for them.

---

## Stack

Next.js 16 (App Router, Node runtime) · TypeScript 5.9 strict · Supabase
(PostgreSQL + Auth + Storage) · PostgreSQL Row Level Security · Zod · Vitest.

Versions were pinned on evidence rather than on `latest` — see
[ADR-0022](docs/architecture/adr/ADR-0022-dependency-versions-pinned-on-evidence.md),
which records why TypeScript 7 and ESLint 10 were both rejected after reproducing
concrete failures.

## Quick start

```bash
nvm use                      # Node 22, per .nvmrc
npm ci                       # exactly what package-lock.json pins
cp .env.example .env.local   # then fill in the values
npm run dev                  # http://localhost:3000
```

Phase 1 runs **without a Supabase project**: configuration is parsed lazily and
only at first use, so the dev server, tests, build and health probe all work with
an empty `.env.local`.

```bash
npm run validate             # typecheck → lint → test → build → exposure scan
curl -i localhost:3000/api/v1/health
```

Full details: [docs/runbooks/local-development.md](docs/runbooks/local-development.md).

## The boundary that matters most

Supabase's `service_role` key carries PostgreSQL's **`BYPASSRLS`** attribute. If
it reaches a browser bundle, tenant isolation is gone for every client
organization at once — and the application keeps working normally, so the leak is
invisible.

The codebase is therefore split in two, and the split is enforced by **four
independent controls** rather than by convention:

| Directory     | Contract                                                              |
| ------------- | --------------------------------------------------------------------- |
| `src/lib/`    | Isomorphic. Provably secret-free. No database access, no React        |
| `src/server/` | Secret-bearing. Every module begins with `import 'server-only'`       |
| `components/` | UI (Phase 9). May import `@/lib` only                                 |
| `app/`        | Routing and HTTP surface. Thin — business logic lives in `src/server` |

1. **ESLint** — `src/lib` and `components` may not import `@/server/*`, may not
   import `server-only`, and may not read `process.env` (one sanctioned
   exception). `src/server` may not import UI. Raw `console.*` is banned outside
   the logger.
2. **`server-only`** — `next build` fails if a client graph reaches a server
   module, and reports the whole import chain.
3. **Architecture tests** — assert the properties that are invisible when they
   break, such as a server module that lost its `import 'server-only'`.
4. **Bundle scan** — `npm run check:client-exposure` greps the emitted
   `.next/static` artifacts for service-role keys, JWTs, connection strings and
   symbols from `client-service.ts`.

Each control was verified with a deliberate violation before being trusted;
[ADR-0002](docs/architecture/adr/ADR-0002-client-server-boundary-wall.md) records
the results.

## Authorization model

Two layers, both mandatory — a request is authorized only if **both** pass:

- **Application capability check** — a typed role → capability matrix enforced by
  `withRoute`. Answers _may this role perform this operation?_ (Phase 4)
- **PostgreSQL RLS** — evaluated inside the database on every statement,
  independently of application code. Answers _may this actor touch these rows at
  all?_ (Phase 2)

Frontend route protection, hidden buttons and `middleware.ts` are **UX
affordances, never security boundaries**. Every one of them has a server-side
twin.

Roles: `SUPER_ADMIN` and `ADMIN` (internal, global), `CLIENT_ADMIN` and
`CLIENT_MEMBER` (client-side, always scoped to exactly one organization).

> ⚠️ **Open decision (risk R-1).** These four roles cannot express a
> non-privileged internal actor, so every specialist across the seven delivery
> teams would need cross-tenant `ADMIN`. A fifth role (`TEAM_MEMBER`) is
> recommended. The gap is documented on `ROLES` in `src/lib/domain/roles.ts`
> and **guarded by a tripwire test** (`tests/unit/domain.spec.ts`) rather than
> resolved unilaterally.

## Documentation

| Document                                                                             | Contents                                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [docs/architecture/README.md](docs/architecture/README.md)                           | The canonical architecture: boundaries, data flow, security layers, risks |
| [docs/architecture/domain-model.md](docs/architecture/domain-model.md)               | Entities, roles, teams, service lines, tenancy, money and time            |
| [docs/architecture/adr/](docs/architecture/adr/README.md)                            | Decision register — every architecturally significant choice              |
| [docs/runbooks/local-development.md](docs/runbooks/local-development.md)             | Setup, commands, and how to read a failure                                |
| `src/lib/README.md`, `src/server/README.md`, `tests/README.md`, `supabase/README.md` | Per-directory contracts                                                   |

## Phase roadmap

| Phase | Scope                                                    | Status                        |
| ----- | -------------------------------------------------------- | ----------------------------- |
| 1     | Architecture                                             | ✅ **Complete and validated** |
| 2     | Database — schema, migrations, RLS, pgTAP                | Not started                   |
| 3     | Authentication — sessions, invites, MFA, middleware      | Not started                   |
| 4     | Authorization — capability matrix, guards, RLS hardening | Not started                   |
| 5     | APIs — resources, services, repositories                 | Not started                   |
| 6     | Security — headers, rate limiting, storage, audit        | Not started                   |
| 7     | Seed data                                                | Not started                   |
| 8     | Testing — L4 RLS integration, L5 E2E                     | Not started                   |
| 9     | Dashboard UI — admin and client                          | Not started                   |

Each phase must leave the repository buildable, and does not begin until the
previous one is validated.

## Known limitations of the current phase

Stated plainly, so nothing here is mistaken for more than it is:

- **No authentication or authorization exists.** Every route is currently
  unauthenticated. The only route is `/api/v1/health`, which is intentionally
  public and reveals nothing.
- **No database schema, no RLS.** Row Level Security is designed and documented,
  not written. It cannot be proven by unit tests — only by executing SQL under a
  real JWT (risk R-3).
- **No business endpoints.** No stubs or fixtures stand in for them.
- **`src/types/database.ts` declares empty collections.** That is load-bearing: a
  typed client will not compile a query against a table that does not exist yet.
- **No CSP or HSTS.** The baseline headers that are always safe are set; CSP and
  HSTS are Phase 6, because a CSP written before any UI exists would be either
  too loose to matter or strict enough to break Phase 9.
