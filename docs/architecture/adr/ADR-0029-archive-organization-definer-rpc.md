# ADR-0029 — `archive_organization()` joins the closed definer-RPC set

**Status:** Proposed — ratified in the Phase 5 implementation step that
authors the RPC (the closed set grows only by ADR — authorization §14).
**Phase:** 5

## Context

The Phase 4 capability matrix grants `organization:delete` as `●[R] ✗ ✗ ✗`
— SUPER_ADMIN only, and marked `[R]`: reachable only through a
`SECURITY DEFINER` RPC, because the direct write is not the sanctioned path.
The annotation explains why: _"Soft delete; purge is a separate SUPER_ADMIN
RPC that audits first."_

Phase 4 implemented the purge half (`purge_organization()` in the workflow
RPCs migration) but not the soft-delete half — the matrix row predates the
endpoint that would consume it, and no Phase 4 route deleted organizations.
Phase 5 designs that endpoint (`api.md` D-6: `DELETE
/api/v1/organizations/{organizationId}`) and therefore has to answer the
question the `[R]` marker poses: through what definer does the soft delete
run?

The honest options are two. A service-layer soft delete through the user-JWT
client is _possible_ (RLS allows SUPER_ADMIN the UPDATE) but contradicts the
matrix cell's own `[R]` qualifier, and — worse — splits an irreversible-class
operation across layers: the audit-first requirement, the slug confirmation
and the live-children refusal would live in application code, where they can
be bypassed by any future code path holding a SUPER_ADMIN session. The
alternative is the one Phase 4's purge already established as the pattern
for tenant destruction.

## Decision

1. **Add `public.archive_organization(p_organization_id uuid, p_reason text,
p_confirm_slug text)` to the closed definer-RPC set** (authorization §14),
   authored in the Phase 5 implementation migrations.
2. **Behaviour, in one transaction:** verify the caller is an active
   SUPER_ADMIN (re-checked from the database, never from an argument);
   verify `p_confirm_slug` equals the organization's `slug` (the purge
   pattern — destruction requires typing the tenant's name); refuse while
   live engagements exist (the organization is archived _down_ the
   hierarchy, never out from under live work — 409 `has_active_children`);
   **write the CRITICAL `SOFT_DELETE` audit row first**; then set
   `deleted_at`/`deleted_by` and cascade the soft delete to the
   organization's memberships.
3. **The set stays closed.** This ADR is the change record authorization §14
   demands for adding an RPC; no further RPC joins the set in Phase 5. The
   endpoint D-6 is the RPC's only consumer, and its capability cell
   (`organization:delete`) is unchanged.

## Consequences

- The matrix's `[R]` annotation becomes true rather than aspirational: every
  tenant-destruction path — soft and hard — now runs through a definer that
  audits first, inside the database, where a forgotten application check
  cannot skip it.
- pgTAP obligations (`api.md` §18 L4): audit-first ordering, slug
  confirmation refusal, live-children refusal, and ADMIN/client denial.
- The RPC reuses the purge precedent's shape closely enough that reviewers
  can diff the two; their deliberate difference (soft vs. hard, cascade
  scope) is documented in both function comments.
- Risk register: this closes the gap implicitly carried by the Phase 4
  matrix row — no new risk is opened, because the endpoint did not exist
  before this design.
