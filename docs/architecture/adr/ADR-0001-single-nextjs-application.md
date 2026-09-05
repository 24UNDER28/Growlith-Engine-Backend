# ADR-0001: Single Nextjs Application

**Status:** Accepted
**Phase:** 1

## Context

The repository is named `Growlith-Engine-Backend`, but its README defines it as
"a portal for both clients and administrators", and the project execution order
places dashboard UI in Phase 9 of the same sequence. Two dashboards (admin and
client) plus a server-side API must therefore be delivered.

## Decision

Ship **one Next.js application** containing the admin dashboard, the client
portal, and the `/api/v1/**` route handlers. Route groups separate the
experiences: `(admin)` → `/admin`, `(portal)` → `/portal/[orgSlug]`,
`(auth)` → `/login`.

## Consequences

- One deployment, one dependency graph, one authorization code path to audit.
- A single `src/server/**` wall protects both dashboards.
- Trade-off: a UI defect can affect API availability (risk R-15). Accepted under
  Rule 16 (avoid premature microservices); revisit only if traffic justifies it.
- The repository name remains misleading (risk R-12). Renaming is cheap now and
  expensive later; the name is documented in `README.md` until an owner decides.

## Alternatives rejected

- **Monorepo with two apps** (`apps/admin`, `apps/portal`): duplicates auth,
  layout and API-client code, and doubles the CI surface, with no isolation
  benefit that route groups do not already provide.
- **Separate backend service**: adds a network hop, a second deployment and CORS
  (see ADR-0014) before there is any scaling pressure to justify it.
