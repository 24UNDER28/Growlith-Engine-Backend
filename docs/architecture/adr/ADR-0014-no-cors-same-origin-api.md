# ADR-0014 — No CORS: the API is same-origin with the dashboards

**Status:** Accepted
**Phase:** 5 (proposed in Phase 1; authored here, where the API surface it
governs is designed — `docs/architecture/api.md`)

## Context

`/api/v1` carries tenant-scoped, RLS-filtered data authenticated exclusively
by `HttpOnly` session cookies (ADR-0026). Phase 1 recorded the decision as
**Proposed** and deferred the ADR to the phase that designs the API, because
the CORS posture is only meaningful once the surface, its authentication and
its caller model exist. They now exist, and they point one way:

- The only intended callers are the two dashboards in **this same
  application** — RSC server code and the browser fetch wrapper
  (`src/lib/auth/api-client.ts`). Both are same-origin by construction.
- The credential is a cookie the browser attaches automatically. Every
  cross-origin surface that exists for that cookie — CORS negotiation,
  `Access-Control-Allow-Credentials`, preflight handling — is attack surface
  with zero consumers: a CSRF-adjacent primitive waiting for a misconfigured
  allow-list.
- The API exposes no machine-to-machine authentication (no API keys, no
  bearer tokens) in v1 (`api.md` §3). There is therefore no legitimate
  cross-origin or non-browser caller that a CORS policy would be admitting.

## Decision

1. **The application emits no CORS headers at all.** No
   `Access-Control-*` response header, no `OPTIONS` handler, no
   origin allow-list configuration. A browser making a cross-origin request
   to `/api/v1` fails on its own same-origin-policy terms; the server never
   negotiates.
2. **No CSRF-token layer in v1.** The posture that replaces it, stated so it
   is a decision and not an oversight: `SameSite=Lax` cookies + JSON-only
   bodies (a cross-origin form cannot forge `application/json` without a
   preflight, which item 1 ensures never succeeds) + no state change on
   GET/HEAD + same-origin callers only. Authentication §13 recorded this
   bundle as the Phase 3 position; Phase 5 adopts it for the whole surface.
   If the caller model ever widens (API keys, partner integrations), the
   change arrives with its own ADR and its own threat model — not by
   quietly widening headers.
3. **This is a compatibility-contract item.** Adding CORS headers later is a
   reviewable widening of the security perimeter; removing them is breaking
   for any consumer that grew to depend on them. Neither happens without a
   version conversation (`api.md` §15).

## Consequences

- One fewer configuration dimension that can drift between environments;
  there is no `ALLOWED_ORIGINS` env, and the env contract
  (ADR-0023) gains nothing to police.
- Integration requests from other origins fail silently from the server's
  point of view (the browser blocks the read). That is acceptable: v1 has no
  integration story, and the failure is loud on the caller side.
- The decision is trivially reversible while no external consumer exists —
  which is exactly why it is taken now, cheaply, rather than rediscovered
  under integration pressure when reversing it would cost a threat review.
