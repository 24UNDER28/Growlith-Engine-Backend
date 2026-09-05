# ADR-0005: Denormalized Tenant Key, Made Tamper-Proof By Composite Foreign Keys

**Status:** Accepted
**Phase:** 2

## Context

The tenant is the Organization, and the hierarchy runs six levels deep:

```
Organization → Engagement → Service → Project → Deliverable → Task
```

Every RLS policy must answer one question per row: _may this actor touch it?_
There are two ways to make the tenant reachable from a deep row.

**Resolve by join.** `tasks` keeps only `project_id`; tenancy is found by
walking `task → deliverable → project → service → engagement → organization`.
Normalized, and wrong here for two reasons. It puts a five-table join inside
every policy predicate, evaluated per row; and the joined tables are themselves
under RLS, so the predicate depends recursively on the policies it is part of.
That is fragile in a way that fails closed on a good day and open on a bad one.

**Denormalize.** Every tenant-scoped row carries `organization_id`. Policies
become `organization_id = any(current_org_ids())` — one indexed column, no
joins, no recursion. The standard objection is drift: two copies of a fact will
eventually disagree, and here disagreement means a row visible to the wrong
tenant.

## Decision

Denormalize `organization_id` onto every tenant-scoped table, and eliminate the
drift risk **structurally** rather than by discipline. Three mechanisms:

1. **Composite foreign keys.** Each child references its parent through both
   columns:

   ```sql
   constraint tasks_project_fkey
     foreign key (project_id, organization_id)
     references public.projects (id, organization_id)
   ```

   This requires `unique (id, organization_id)` on every parent — present on all
   nine composite-FK targets. A child whose tenant differs from its parent's is
   now a foreign-key violation. Not a bug to catch in review: a write that
   cannot complete.

2. **Derivation, not input.** A `BEFORE INSERT` trigger reads `organization_id`
   from the parent row. A client-supplied value that _disagrees_ raises; a value
   that is absent is filled in. The column is therefore never client input, which
   removes the entire class of "attacker posts a different organization id".

   The first implementation silently overwrote a mismatch. That was wrong, and
   `scripts/db-verify.mjs` caught it: an operator attaching a project to the
   wrong service would have had the row quietly re-homed into another tenant and
   returned as success. A misdirected write must fail loudly.

3. **Immutability.** A `BEFORE UPDATE` trigger rejects any change to
   `organization_id`. Moving a row between tenants is never a valid operation;
   the correct action is create-in-target plus soft-delete-in-source, which
   leaves both audit trails intact.

### The `task` parentage trade-off

The stated hierarchy puts Task under Deliverable, and `HIERARCHY_PARENT` in
`src/lib/domain/entities.ts` still says so. But real work is not always attached
to a deliverable — investigation, internal meetings, maintenance. So
`tasks.deliverable_id` is **nullable** while `tasks.project_id` is **NOT NULL**.

The composite FK proves same-_tenant_ only. Same-_project_ needs a trigger, and
`growlith.enforce_task_deliverable_project()` provides it: when a deliverable is
present it must belong to the task's project. Without that, a task could hang
off a deliverable in a sibling project and every rollup would be quietly wrong.

The hierarchy remains authoritative; the persistence model is deliberately one
step looser at exactly this edge, and the difference is enforced rather than
merely noted.

## Consequences

- Tenant isolation is a property of the storage layer, not of application code.
  A cross-tenant write fails whether it comes from a route handler, a direct
  PostgREST call, or a mistake.
- Cost: one extra `uuid` column and one extra unique index per tenant table, and
  21 composite foreign keys.
- Every composite FK needs an index whose leading columns match it. This was
  initially missed — the single-column indexes did not satisfy the two-column
  FKs — and turned every cascade into a sequential scan. Migration 24 fixes it
  and asserts the property so it cannot regress.
- `metrics` and `reports` have optional parents, so their derivation triggers
  fall back to a caller-supplied value validated by a direct FK to
  `organizations`.
