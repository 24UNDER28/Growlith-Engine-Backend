# ADR-0013: Single Mutation Path

**Status:** Accepted
**Phase:** 1

## Context

Next.js offers two server-side mutation paths: Route Handlers and Server
Actions. Each is a place where authentication, validation, authorization and
audit must be correctly applied.

## Decision

**One mutation path: `/api/v1/**` Route Handlers**, every one built with
`withRoute` (`src/server/api/with-route.ts`). Server Actions are permitted only
as thin delegators into the same service layer, never as an independent write
path.

`withRoute` enforces, in a fixed order: request id → method check →
param/query/body validation → handler → envelope → response headers →
structured log. A handler author cannot skip a step, because the steps are not
in their code.

## Consequences

- One authorization surface to test, audit and reason about.
- Phase 4 adds a required `capability` field to `RouteDefinition`; the contract
  test then asserts every route declares one, so a route cannot silently ship
  unauthorized.
- `tests/architecture/client-server-boundary.spec.ts` §G already asserts that
  every `app/api/**/route.ts` is built with `withRoute`.
- Trade-off: browser forms need an explicit fetch rather than a bare action.
  Accepted — the reduction in authorization surface is worth more than the
  ergonomics.
- The Phase 1 wrapper contains **no** authentication or capability check. A
  placeholder that looks enforced but is not would be worse than an honest
  absence (Rules 8 and 14); the extension point is documented in the module.

## Alternatives rejected

- **Server Actions as the primary path**: no stable URL, no versioning, harder to
  contract-test, and a second place to forget a guard.
- **tRPC / GraphQL**: end-to-end typesafety is already obtained from Zod schemas
  shared with the client, so these would add a dependency and a schema layer
  without adding a guarantee (Rules 15 and 17).
