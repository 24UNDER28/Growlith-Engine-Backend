# ADR-0027 — 405 responses are framework-generated; the envelope waiver is contract

**Status:** Accepted
**Phase:** 5 (resolves the open item Phase 1 recorded in
`docs/architecture/README.md` §H: "Resolution is deferred to Phase 5, when
routes exist to decide it against.")

## Context

Phase 1 verified against a running production build that Next.js rejects a
method a route file does not export **before** the handler runs: the response
is `405 Method Not Allowed` with an empty body, no `x-request-id` and no
`Allow` header, and the request never reaches `withRoute` nor the server log.
The error envelope therefore does not hold for 405, and Phase 1 left the
question open with two viable options: (a) export every method per route file
so every 405 is ours, or (b) accept the framework behaviour and document it.

Phase 5 is the deciding phase because it is the phase with routes: the
catalogue now numbers 114 endpoints (`docs/architecture/api.md`), and the
typed API client exists (`src/lib/auth/api-client.ts`) to be designed
against.

## Decision

1. **Option (b): 405 remains framework-generated.** A route file exports only
   the methods it serves; unsupported verbs are answered by the framework
   with a body-less 405. This is now a stated term of the `/api/v1`
   contract, not a known defect.
2. **Clients must tolerate a body-less or unparseable 405.** The typed
   client maps "no parseable error envelope" to a generic method/transport
   failure rather than throwing; the Phase 9 UI therefore has one handling
   path for the case.
3. **`withRoute`'s method check is retained, re-scoped in documentation to
   what it actually catches:** a declaration/export mismatch (a route file
   exporting `GET` built from `withRoute({ method: 'POST' })`) — a
   copy-paste bug that would otherwise serve wrong semantics on the wrong
   verb. It is defence against our own error; it is not, and its contract
   test does not claim it is, the primary 405 mechanism.

## Rejected alternative

Option (a) — exporting every verb with a boilerplate 405 handler — was
rejected on three grounds:

- It would add ~100+ exported handlers whose only behaviour is to emit an
  error for a case that is rare in practice and harmless when it occurs
  (a wrong verb is a caller bug, not a data-integrity event).
- Every exported-but-unsupported method would still need declaration,
  review and a test to prove it refuses — ceremony around a non-surface,
  which the repository's rules treat as worse than absence (Rules 8 and 14:
  nothing stands in for a thing that does not exist).
- Envelope uniformity buys nothing here that the typed client cannot provide
  cheaper: one branch on "unparseable error body" covers 405 *and* any other
  framework-level response (e.g. edge rewrites) the application does not
  control.

## Consequences

- The envelope contract (`docs/architecture/api.md` §6) carries an explicit
  waiver row for 405; monitoring and client SDKs are written against the
  waiver rather than discovering it.
- `Allow` headers on 405 are forfeited. No consumer exists that probes
  methods for discovery (the API is consumed through generated types), so
  the loss is theoretical; if discovery ever matters, it gets a real surface
  (e.g. a documented method manifest), not retrofitted 405s.
