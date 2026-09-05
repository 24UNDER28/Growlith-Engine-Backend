# Database Schema — Phase 2

**Status:** implemented and verified against PostgreSQL 18.
**Source of truth:** `supabase/migrations/`. This document explains it; the SQL
defines it. Where they disagree, the SQL is right and this file is a bug.

The design rationale lives in the ADR register — [ADR-0005](adr/ADR-0005-denormalized-tenant-key-composite-foreign-keys.md)
(tenancy), [ADR-0006](adr/ADR-0006-service-catalogue-separate-from-instances.md)
(catalogue vs. instance), [ADR-0008](adr/ADR-0008-security-definer-rls-helpers.md)
(RLS helpers), [ADR-0009](adr/ADR-0009-enable-and-force-row-level-security.md)
(RLS posture), [ADR-0012](adr/ADR-0012-sensitive-mutations-through-definer-rpcs.md)
(definer RPCs), [ADR-0020](adr/ADR-0020-append-only-audit-events.md) (audit),
[ADR-0021](adr/ADR-0021-pgtap-is-the-proof-of-rls.md) (verification).

---

## 1. What exists

|                                           | Count                                                             |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Migrations                                | 24                                                                |
| Tables                                    | 23 (+1 partitioned parent, 14 partitions)                         |
| Enum types                                | 36                                                                |
| Foreign keys                              | 104, of which **21 are composite** `(parent_id, organization_id)` |
| CHECK constraints                         | 91                                                                |
| Unique constraints and indexes            | 65                                                                |
| Indexes total                             | 312                                                               |
| Triggers (non-internal)                   | 102                                                               |
| Functions                                 | 37                                                                |
| Relations with RLS enabled **and forced** | 38 (all of them)                                                  |
| Policies                                  | 3 (reference-data reads only — authorization is Phase 4)          |

## 2. The hierarchy

```
organizations ─┬─ organization_settings          (1:1, shared PK)
               ├─ organization_memberships ──── profiles     ← the only cross-org edge
               ├─ invitations
               ├─ files
               ├─ metrics
               ├─ reports ── report_metrics
               └─ engagements
                    └─ services ──────────── service_lines (global)
                         └─ projects ─────── project_memberships
                              └─ deliverables ── deliverable_versions
                                   └─ tasks
                                        ⋮
                  comments  → exactly one of project / deliverable / task
                  files     → at most one owner, or organization-level

GLOBAL (not tenant-scoped)
  profiles · platform_role_grants · staff_team_memberships
  teams · service_lines · status_transitions
  notifications (recipient-scoped; organization_id nullable)
  audit_events  (org-tagged, but no FK — must outlive what it describes)
```

## 3. Tenant isolation, five mechanisms

1. **Denormalized `organization_id`** on all 13 tenant tables, NOT NULL.
2. **Composite foreign keys** `(parent_id, organization_id) → parent(id, organization_id)`
   — 21 of them. A cross-tenant child is a foreign-key violation, not a bug.
   Each parent carries `unique (id, organization_id)` as the FK target.
3. **Derivation, not input.** `growlith.derive_organization_id()` reads the
   tenant key from the parent on INSERT. A client-supplied value that disagrees
   **raises**; it is not silently corrected.
4. **Immutability.** `growlith.freeze_organization_id()` rejects any UPDATE to
   the tenant key. Rows never move between tenants.
5. **Storage path prefix.** `files.storage_path` must begin `{organization_id}/`
   (CHECK), independently mirrored by `can_access_storage_path()` for the Phase 4
   `storage.objects` policies. Two mechanisms that must always agree.

**Never crosses an organization boundary:** engagements, services, projects,
project_memberships, deliverables, deliverable_versions, tasks, comments, files,
reports, report_metrics, metrics.

**Legitimately spans organizations:** `profiles`, and only through
`organization_memberships`. That single edge is audited at CRITICAL severity on
every write.

## 4. Tables

Column and index counts are from the live schema.

| Table                      | Cols | Idx | Purpose                                   |         Soft delete          | Audited |
| -------------------------- | ---: | --: | ----------------------------------------- | :--------------------------: | :-----: |
| `organizations`            |   18 |   8 | The tenant                                |              ✅              |   ✅    |
| `organization_settings`    |   11 |   3 | Per-tenant config, 1:1, shared PK         |              —               |    —    |
| `profiles`                 |   18 |   8 | Identity, 1:1 with `auth.users`           |              ✅              |    —    |
| `platform_role_grants`     |   12 |   7 | SUPER_ADMIN / ADMIN grants, revocable     |            revoke            |   ✅    |
| `organization_memberships` |   15 |  10 | Person ↔ tenant, client roles             |              ✅              |   ✅    |
| `teams`                    |    8 |   3 | Seven delivery teams (reference)          |              —               |    —    |
| `staff_team_memberships`   |   11 |   7 | Internal staff ↔ team                     |              ✅              |    —    |
| `service_lines`            |    8 |   3 | Seven published service lines (reference) |              —               |    —    |
| `engagements`              |   21 |  10 | Commercial relationship                   |              ✅              |   ✅    |
| `services`                 |   20 |  11 | Purchased service-line instance           |              ✅              |   ✅    |
| `projects`                 |   21 |  12 | Delivery container                        |              ✅              |   ✅    |
| `project_memberships`      |   13 |  11 | Project staffing                          |              ✅              |   ✅    |
| `deliverables`             |   21 |  12 | Client-facing output + approval workflow  |              ✅              |   ✅    |
| `deliverable_versions`     |   13 |   8 | Immutable version/review history          |         append-only          |    —    |
| `tasks`                    |   23 |  13 | Atomic internal work                      |              ✅              |   ✅    |
| `comments`                 |   16 |  15 | Threaded discussion, XOR subject          |              ✅              |   ✅    |
| `files`                    |   25 |  23 | Storage object metadata                   |              ✅              |   ✅    |
| `metrics`                  |   14 |   9 | Time-series KPIs                          | — (corrections are new rows) |    —    |
| `reports`                  |   20 |  12 | Published performance report              |              ✅              |   ✅    |
| `report_metrics`           |   11 |   5 | Frozen figures as published               |         append-only          |    —    |
| `notifications`            |   13 |   6 | Per-recipient events                      |      — (retention job)       |    —    |
| `invitations`              |   18 |   9 | Pending access grants, token hash only    |          — (revoke)          |    —    |
| `status_transitions`       |    8 |   2 | Legal state machine (reference)           |              —               |    —    |
| `audit_events`             |   15 |   7 | Append-only trail, partitioned monthly    |            never             |   n/a   |

### Notable modelling decisions

- **`tasks.deliverable_id` is nullable, `project_id` is not** (ADR-0005). A
  trigger enforces same-_project_ when a deliverable is present; the composite FK
  only proves same-_tenant_.
- **`comments` uses three typed nullable FK columns + XOR check**, not a
  polymorphic `(subject_type, subject_id)` pair. Typed columns keep referential
  integrity and cascades; the generic form throws both away.
- **`files` uses six owner columns**, `num_nonnulls(...) <= 1` — a file may also
  be organization-level (contract, brand asset) and own nothing.
- **`report_metrics` is a frozen snapshot**, deliberately not a view over
  `metrics`. A correction to a metric must never retroactively change a report
  already issued to a client.
- **`notifications.subject_id` has no FK, by design.** A notification must
  survive the deletion of what it announces. It is still typed via
  `subject_entity`.
- **`audit_events.before/after` is the only JSONB in the schema**, and ADR-0020
  states the justification. Every queryable dimension is a real typed column.

## 5. Enums (36)

Identity — `platform_role`, `organization_role`, `account_status`,
`membership_status`, `user_type`.
Delivery — `team`, `service_line`.
Organization — `org_status`, `region_code`, `currency_code`.
Commercial — `engagement_type`, `engagement_status`, `fee_model`,
`service_status`, `project_status`, `project_health`, `project_member_role`,
`priority`.
Work — `deliverable_type`, `deliverable_status`, `review_outcome`, `task_status`.
Reporting — `report_type`, `report_status`, `report_cadence`, `metric_key`,
`metric_unit`, `metric_source`.
Files — `file_kind`, `scan_status`.
Access — `invitation_status`.
Notifications — `notification_type`, `notification_severity`.
Audit — `audit_action`, `audit_severity`, `entity_kind`.

`platform_role`, `organization_role`, `team`, `service_line` and `entity_kind`
are asserted equal to `src/lib/domain/` by `tests/unit/schema.spec.ts`.

## 6. Index strategy

Every index answers a query the product actually runs.

| Query                                          | Index                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Every RLS check: "which orgs is this user in?" | `organization_memberships (user_id) where deleted_at is null`                                      |
| Client portal deliverable list                 | `deliverables (organization_id, client_visible, status) where deleted_at is null`                  |
| "My tasks"                                     | `tasks (assignee_user_id, status) where deleted_at is null`                                        |
| Project board                                  | `tasks (project_id, status, position) where deleted_at is null`                                    |
| Unread badge                                   | `notifications (recipient_user_id, created_at desc) where read_at is null and archived_at is null` |
| Metric chart                                   | `metrics (organization_id, metric_key, metric_date desc)`                                          |
| Record history panel                           | `audit_events (entity_kind, entity_id, occurred_at desc)`                                          |
| Renewals dashboard                             | `engagements (renewal_date) where status = 'ACTIVE'`                                               |
| Team workload                                  | `services (delivering_team, status)`, `tasks (assigned_team, status)`                              |
| Comment thread                                 | `comments (deliverable_id, created_at desc) where deliverable_id is not null`                      |

Rules applied:

- **Partial on `deleted_at is null`** for every list index, so hot indexes stay
  proportional to live data rather than to history.
- **Leading column is `organization_id`** on tenant list indexes, matching the
  RLS predicate so one index serves both filter and isolation.
- **Every FK is index-backed**, asserted by migration 24 and by `db:verify`.
  Composite FK indexes are deliberately **not** partial: a referential check must
  see soft-deleted children too.
- **BRIN** for `audit_events.occurred_at` and `metrics.metric_date` —
  append-ordered, large, range-scanned only.
- **Not indexed:** free-text `description`/`body`. Full-text search is a later
  decision; speculative GIN indexes would slow every write for no current query.

## 7. Constraint strategy

Five layers, each catching what the one above cannot.

1. **NOT NULL by default.** Nullable only where "unknown" is a real business
   state (open-ended retainer `end_date`, investigation task `deliverable_id`).
2. **CHECK for intra-row invariants** — 91 of them. Date ordering, non-negative
   money, status→timestamp implications (`APPROVED → approved_at is not null`),
   XOR polymorphism, storage-path prefix, `CLIENT_REVIEW → client_visible`.
3. **Composite FKs for tenancy** (§3).
4. **Triggers for cross-row invariants** a constraint cannot express: task
   same-project, service currency = engagement currency, project member is in the
   same tenant or is staff, notification recipient is entitled to the tenant,
   status-transition legality, tenant derivation and freezing, append-only
   enforcement.
5. **Unique constraints** on all human-facing identifiers, scoped per
   organization and **partial on `deleted_at is null`** — so a code frees up
   after a soft delete.

**Deletion policy.** Soft delete for all tenant business data (contractual
retention, audit evidence). Hard delete only for notifications (retention job),
expired invitations, and a SUPER_ADMIN purge RPC that writes a `HARD_DELETE`
audit event first. `organizations` never cascades.

## 8. RLS posture

- `ENABLE` **and** `FORCE` on all 38 relations, including every audit partition
  (partitions do not inherit row security — see ADR-0009).
- Deny-by-default: `authenticated` has `SELECT` on the tables but **no policies**
  on any tenant table, so it currently sees zero rows.
- Phase 2 ships exactly three policies, all reference-data reads (`teams`,
  `service_lines`, `status_transitions`). Nothing renders without the catalogue.
- Twelve `SECURITY DEFINER` predicate helpers are in place for Phase 4
  (ADR-0008).
- Column-level grants already separate internal-only commercial data
  (`contract_value`, `monthly_retainer`, `notes_internal`, `services.fee`,
  `fee_model`) — revoked from `authenticated` at the GRANT layer, not hidden by
  the UI.
- `DELETE` is revoked from every role, everywhere.

## 9. Verification

```bash
export DATABASE_URL='postgresql://…'   # any PostgreSQL 15+
npm run db:check                       # reset · apply · seed · verify · type-drift
```

- `npm test` — 42 schema tests, no database required (enum parity, RLS
  declarations, composite FKs, pinned `search_path`, no destructive DDL).
- `npm run db:verify` — 91 checks against a live database: structure **and**
  behaviour (cross-tenant writes rejected, illegal transitions refused,
  append-only tables immutable, audit rows correct).
- **Still outstanding:** pgTAP under real JWTs. RLS is _authored, not executed_
  until that runs — risk R-3, ADR-0021.
