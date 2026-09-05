# ADR-0012: Privilege-Changing Writes Go Through `SECURITY DEFINER` RPCs, Never Direct `UPDATE`

**Status:** Accepted
**Phase:** 2 (schema preparation); RPCs authored in Phase 4

## Context

PostgREST exposes tables directly. Any rule enforced only in a route handler is
enforced only for callers who use that route handler. For most data a `WITH
CHECK` policy is sufficient. For a small set of operations it is not, because
the rule is not expressible as a predicate over the new row:

- granting or revoking a platform role;
- a `CLIENT_ADMIN` adding a member — allowed, but only ever as `CLIENT_MEMBER`,
  which is a comparison against the _old_ row plus the actor's own role;
- accepting an invitation, which must atomically check a token hash, create a
  membership and mark the invitation used;
- hard deletion for GDPR erasure, which must bypass append-only triggers.

## Decision

These operations are `SECURITY DEFINER` RPCs. Phase 2 prepares the schema so
that they are the _only_ path:

- `DELETE` is revoked from `authenticated` on every table. Deletion is a
  soft-delete `UPDATE`; hard deletion runs inside the purge RPC.
- `INSERT`/`UPDATE` is granted on only seven tables — the ones the application
  legitimately writes on a user's behalf. `platform_role_grants`,
  `organization_memberships` and `invitations` are not among them.
- Internal-only columns (`contract_value`, `monthly_retainer`, `notes_internal`,
  `services.fee`, `fee_model`) have table-wide `SELECT` revoked and the visible
  columns re-granted individually. Any column added to those tables later is
  therefore invisible to clients until someone deliberately grants it — failing
  in the safe direction.
- Structural invariants that an RPC might forget are enforced by trigger
  regardless: invitation terms are immutable after issue, a grant's subject and
  granter are immutable after insert, a revoked grant cannot be un-revoked.

## Consequences

- A compromised client session cannot escalate by crafting a PostgREST call,
  because the tables it would need are not writable by its role at all.
- The RPC bodies themselves are Phase 4 work; writing them now, before the
  permission matrix exists, would mean authoring the authorization rules twice.
- Column-level grants are invisible in the generated types: `database.ts`
  describes the schema, not the caller's privileges. A client-side read of
  `contract_value` therefore type-checks and fails at runtime. Phase 4 should
  expose narrowed row types for client contexts.
