# ADR-0007: Two Authorization Layers That Enforce Different Questions, Never The Same One Twice

**Status:** Accepted
**Phase:** 4 (design; implementation follows `docs/architecture/authorization.md` §18)

## Context

Phase 1 proposed "two authorization layers — capability matrix (app) and RLS
(database); both must pass" and left the shape of each open. The obvious reading
of "defence in depth" is that both layers enforce the same rules, so that
forgetting one still leaves the other. That reading is wrong in a specific and
expensive way.

If the capability matrix and the RLS policy set both encode "a `CLIENT_ADMIN`
may approve a deliverable", then the same business rule exists twice, in two
languages, maintained by two different mechanisms, with no structural force
keeping them equal. They will drift. When they do, the drifted copy is the
permissive one — because a too-restrictive copy produces a bug report within a
day, and a too-permissive one produces nothing at all until an incident.

There is also a practical constraint: PostgREST exposes tables directly, so a
rule enforced only in a route handler is enforced only for callers who use that
route handler. And conversely, RLS cannot express "this role may not grant a
platform role", because that is a statement about a verb, not about a row.

## Decision

**The two layers enforce different questions, and the questions do not overlap.**

| Layer                                               | Question it answers                    | Sees                                   |
| --------------------------------------------------- | -------------------------------------- | -------------------------------------- |
| Capability matrix (`src/lib/domain/permissions.ts`) | _May this actor attempt this verb?_    | role, resource, action — no rows       |
| RLS policies (PostgreSQL)                           | _Which rows may this statement touch?_ | rows — no verbs, no capability strings |

Three consequences follow, and each is a rule:

1. **The matrix is never translated into SQL, and RLS predicates are never
   re-expressed in TypeScript.** There is no pair of artefacts encoding the same
   fact, therefore no pair that can silently disagree.
2. **The one fact both layers need — who the caller is, whether their account is
   active, which organizations they reach — is resolved by the same
   `SECURITY DEFINER` helpers on both sides** (`is_active_account()`,
   `has_org_access()`, `auth_platform_role()`). The application mirror
   `reachesTenant()` and the SQL `has_org_access()` are asserted equal by the
   pgTAP suite rather than assumed equal by convention.
3. **Where a rule genuinely must be enforced in both layers, it is enforced from
   one stored definition.** The only such rule is the state machine:
   `status_transitions.allowed_roles` is a table row that the service layer and
   `growlith.enforce_status_transition()` both read. A shared row cannot drift
   from itself.

Two supporting layers complete the set, and both predate this ADR:

- **Column `GRANT`s** (Phase 2). A column the role cannot select needs no
  policy. This is strictly stronger than a policy and is used wherever the
  sensitive unit is a column rather than a row.
- **`SECURITY DEFINER` RPCs** (ADR-0012). A deliberately closed set of twelve
  operations whose rule is not expressible as a predicate over the new row —
  "a `CLIENT_ADMIN` may add a member, but only as `CLIENT_MEMBER`, and not
  themselves, and not the last admin". Enumerated exhaustively in
  `authorization.md` §14; adding one requires an ADR.

### Failure semantics

Both layers fail closed, and they fail with **different status codes on
purpose**:

- Tenant reach fails → **404**, never 403. A 403 would confirm that a resource
  exists in another tenant (ADR-0019).
- Capability fails, once tenant reach is established → **403**.

The ordering rule — _403 may only be returned after tenant reach is proven_ — is
what keeps the API from becoming a cross-tenant existence oracle while still
giving an entitled user an honest error.

## Consequences

**Positive**

- Neither layer duplicates the other, so there is nothing to keep in sync by
  discipline.
- Each layer is testable by the mechanism suited to it: the matrix by a pure
  unit test that enumerates every cell (L2), RLS by pgTAP executing real queries
  as real roles under real JWTs (L4). Neither test can be faked by the other.
- Forgetting a capability declaration is a **compile error**, because
  `withRoute` makes `capability` a required field conditional on `auth`.
  Forgetting a policy is a **zero-row result**, because RLS is deny-by-default
  with `ENABLE` + `FORCE`.
- A rule can be moved between layers deliberately (e.g. `TEAM_MEMBER` would move
  project membership from an object-side qualifier to a subject-side gate)
  without touching the other layer.

**Negative / accepted costs**

- A developer must know which layer owns a given rule. Mitigated by
  `authorization.md` §H.5, which states explicitly what RLS does _not_ enforce,
  and by the four fixed policy shapes in §H.2 — a policy that is not one of the
  four is a review failure.
- The application guard can allow an attempt whose rows RLS then refuses,
  producing a 404 where a 403 might have read more clearly. Accepted: that is
  the correct outcome under ADR-0019, and it is the direction that leaks
  nothing.
- Approximately sixty policies is a large surface (risk A-3). Mitigated by the
  fixed shapes, the `{table}_{command}_{audience}` naming convention, and a
  pgTAP assertion per policy rather than per table.

**Verification.** `tests/unit/permissions.spec.ts` asserts the matrix is dense
and self-consistent (seven invariants, `authorization.md` §16). Invariant 6 is
the one that binds the layers: every capability carrying the `CLIENT_VISIBLE`
qualifier must name a table that has a client-audience policy, and every
capability carrying `RPC_ONLY` must name a table on which `authenticated` holds
no direct write grant. A matrix cell that implies a policy which does not exist
fails the build.

## Alternatives rejected

- **One layer only — RLS.** Cannot express verb-level rules ("ADMIN may not
  grant roles"), cannot produce a useful 403, and pushes every composite
  operation into a definer RPC.
- **One layer only — the application guard.** PostgREST exposes tables
  directly; a rule held only in a handler is held only for callers who use it.
  This is the failure mode the entire schema design (ADR-0005, ADR-0009,
  ADR-0012) exists to prevent.
- **Both layers enforcing the same rules ("true" defence in depth).** Rejected
  for the drift argument above. Redundancy between two hand-maintained copies is
  not depth; it is two chances to be wrong and one of them silent.
- **A policy engine (OPA, Casbin, or an ABAC rules DSL).** Four roles and
  seventeen resources do not justify it, and it would move authorization out of
  the two places that are currently provable — a typed constant a unit test can
  enumerate, and SQL that pgTAP can execute — into a runtime interpreter that
  neither can (Rules 15–17).
