# ADR-0028 — `Idempotency-Key` for POST creates; everything else is idempotent by construction

**Status:** Accepted
**Phase:** 5 (contract designed in `docs/architecture/api.md` §13; the store
and enforcement land with the Phase 5 implementation)

## Context

The Phase 5 catalogue's mutations are POST-only (there is no PUT-replace in
v1; PATCH is partial and append-only resources have no PATCH at all —
`api.md` §7). POST creates are the one verb class that is **not** retry-safe
by default: a network timeout between commit and response turns a retry into
a duplicate engagement, a double-posted comment, a second version row. In a
portal where clients approve deliverables and staff create commercial rows
over mobile connections across four bureaus, "retry on timeout" is ordinary
behaviour, not an edge case.

The design constraint is the rest of the architecture: no new dependencies
(Rule 17), no external cache, the envelope and error vocabulary already
fixed, and the single-mutation-path rule (ADR-0013) — whatever is built must
live in `withRoute`'s pipeline so a handler cannot forget it.

## Decision

1. **Three tiers, defined in `api.md` §13:**
   - _Idempotent by construction_ — GETs, all action endpoints
     (`status`/`assign`/`approve`/`publish`/…: a repeat meets the already-
     reached state and answers 409 naming it, or is a no-op), DELETE
     (repeat ⇒ 404, which is the desired end state), logout.
   - _Conflict-guarded creates_ — creates with a natural uniqueness
     constraint (invitations, organization members): a blind retry answers
     409 pointing at the existing row, which _is_ the answer.
   - _`Idempotency-Key` creates_ — every remaining POST create requires the
     header: organizations, engagements, services, projects, project
     memberships, tasks, deliverables, reports, comments, file registration,
     upload-URL minting.
2. **The contract.** Header `Idempotency-Key` (UUID, ≤ 64 chars); scoped
   `(actor_user_id, route, key)`; stored with a SHA-256 hash of the
   validated body and the response envelope; 24 h retention. Same key + same
   body replays the stored response with `Idempotency-Replayed: true`;
   same key + different body is 409 `idempotency_key_reused`; failed first
   attempts (4xx/5xx) do not consume the key; concurrent same-key requests
   serialize on a unique index, the loser receiving 409 `request_in_flight`.
   Missing or malformed header on a tier-3 endpoint is 400
   `idempotency_key_required`.
3. **Position in the pipeline** — after the capability gate, before the
   handler (`api.md` §2). A denied request neither consumes nor reveals a
   key, and the replay check never runs on unauthenticated or unauthorized
   traffic.
4. **The store is a table, not a cache.** `idempotency_keys` arrives as a
   Phase 5 implementation migration: key columns + `request_hash` + stored
   `status`/response + `created_at`, with expiry by job or lazy purge.
   PostgreSQL is the only backend service this application has (README §B);
   a Redis-shaped solution would be a dependency for a problem the database
   already solves.

## Consequences

- Retries are safe across the entire mutation surface by one of the three
  named mechanisms — the property is provable per endpoint, and the
  contract tests (`api.md` §18 L3) assert replay, reuse and
  not-consumed-on-4xx.
- The key is an _actor_ secret in practice (scoped per user), so keys never
  cross tenants and a replayed response can never be served to a different
  caller; the scope triple makes that structural.
- 24 h is a window, not a guarantee: clients that retry after expiry get a
  second create. That is accepted — the window exists to absorb transport
  retries, not to dedupe business intent, and uniqueness constraints remain
  the backstop where they exist.
- Tier assignment is part of each endpoint's contract in Part II of
  `api.md`; adding a future POST create without choosing a tier is a review
  failure, enforced by the contract suite.
