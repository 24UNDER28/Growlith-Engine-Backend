# Domain Model

The vocabulary below is implemented in `src/lib/domain/` and is the single source
of truth for roles, teams, service lines and the entity hierarchy. Phase 2 turns
it into tables and enums; Phase 4 turns it into a permission matrix; Phase 9 turns
it into labels. Nothing is duplicated between those layers.

---

## 1. The entity hierarchy

```
Organization  →  Engagement  →  Service  →  Project  →  Deliverable  →  Task
```

Implemented in `src/lib/domain/entities.ts` as `HIERARCHY_PARENT`, which is the
authoritative containment statement that Phase 2 encodes as composite foreign
keys.

| Entity           | What it is                                                                                                                                             | Tenant root? | Notes                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------- |
| **Organization** | A client company — the tenant. Everything below belongs to exactly one                                                                                 | ✅           | Carries region (NYC/LDN/SYD/DIFC), industry, status, a unique slug used in `/portal/[orgSlug]` |
| **Engagement**   | A commercial relationship: retainer, project-based or advisory. Has currency, value, dates, status, and an accountable account manager                 |              | An organization may hold several over time (renewals, upsells). This is the contracting unit   |
| **Service**      | A **purchased instance** of a service line under one engagement — scope, fee, dates, status, delivering team                                           |              | Distinct from the _catalogue_; see §3                                                          |
| **Project**      | A delivery container under a service: "Site rebuild Q4". Has a lead, a team, dates, priority, status                                                   |              | Where internal work is organized                                                               |
| **Deliverable**  | A concrete output presented to the client: report, page template set, campaign, video, automation. Versioned, and carries the review/approval workflow |              | The unit the client actually judges. Has `client_visible`                                      |
| **Task**         | An atomic unit of work                                                                                                                                 |              | Assignable to internal staff. See the parentage trade-off below                                |

Supporting entities: **Comment** (attached to exactly one of project, deliverable
or task), **Attachment** (a Storage object plus its metadata row), **Metric**
(time-series KPI), **Notification**, **AuditEvent** (cross-entity, append-only).

### The `task` parentage trade-off (ADR-0005)

The stated hierarchy puts `Task` under `Deliverable`, and that remains
authoritative. But real work is not always attached to a deliverable —
investigation, internal meetings, maintenance.

Phase 2 resolves this by making `tasks.deliverable_id` **nullable** while
`tasks.project_id` stays **not null**, with a constraint ensuring that when a
task has a deliverable, that deliverable belongs to the same project. The
hierarchy stays intact; the persistence model is deliberately one step looser.
The doc comment on `HIERARCHY_PARENT` in `entities.ts` records this so the
difference reads as a decision rather than an accident, and
`tests/unit/domain.spec.ts` locks the chain so the edge cannot be altered
silently.

---

## 2. Actors and roles

Implemented in `src/lib/domain/roles.ts`. Two distinct axes exist and must never
be conflated.

### Platform roles — global, internal Growlith staff

| Role          | Scope  | Contract                                                                                                                                                                                                              |
| ------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPER_ADMIN` | Global | Unrestricted, including operations that are **irreversible or that change who else holds power**: deleting an organization, granting roles, platform settings, destructive purges. Held by a named few; MFA mandatory |
| `ADMIN`       | Global | Operates the machine across all tenants — organizations, engagements, services, projects, deliverables, tasks, staff, teams. **Cannot** grant roles, delete an organization, or change platform settings              |

### Organization roles — always scoped to exactly one organization

| Role            | Scope            | Contract                                                                                                                                                                                                      |
| --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLIENT_ADMIN`  | One organization | Full read of that organization; approves or requests revisions on deliverables; uploads attachments; manages the organization's own members — but may only ever grant `CLIENT_MEMBER`, never an internal role |
| `CLIENT_MEMBER` | One organization | Read and collaborate: view client-visible work, comment, upload. No approvals, no member management                                                                                                           |

There is no such thing as a global `CLIENT_ADMIN`: the role is meaningless
without an organization. The same person can be `CLIENT_ADMIN` of one
organization and have no relationship with another.

> ### ⚠️ Known gap — risk R-1 (owner decision required)
>
> These four roles **cannot express a non-privileged internal actor**. `ADMIN` is
> cross-tenant, so every SEO specialist, paid-media buyer, video editor and
> AI-automation contractor across seven teams and four bureaus must hold
> cross-tenant `ADMIN` simply to do their job. One compromised contractor account
> would expose every client's pipeline, ROAS and deliverables.
>
> For a firm whose proposition is _"first-party data, you own the stack"_ and
> which publishes a data-processing agreement, this is the most serious
> architectural risk in the brief.
>
> **Recommendation:** add a fifth platform role, `TEAM_MEMBER` — internal,
> non-cross-tenant, authorized only for entities whose delivering team matches
> one of the actor's `staff_team_memberships`, or whose task is assigned to them.
>
> This gap has **not** been silently closed. It is documented on `ROLES` in
> `src/lib/domain/roles.ts` and guarded by a tripwire test in
> `tests/unit/domain.spec.ts`, which fails when a fifth role appears while risk
> R-1 is still open in the register. The permission layer is being built as data
> so that adding the role is a matrix edit plus one migration rather than a
> refactor. Phase 4 must not ship without an explicit decision.

---

## 3. Service lines and internal teams

Two concepts that correspond closely today but are **deliberately modelled
separately** (ADR-0006).

- A **service line** is _what the client bought_.
- An **internal team** is _who delivers it_.

`src/lib/domain/service-lines.ts` and `src/lib/domain/teams.ts`.

| Service line (catalogue) | Label                | Default team         |
| ------------------------ | -------------------- | -------------------- |
| `PROGRAMMATIC_SEO`       | Programmatic SEO     | `SEO`                |
| `PRECISION_PAID_MEDIA`   | Precision Paid Media | `PAID_MEDIA`         |
| `WEB_CORE`               | Sub-Second Web Core  | `WEB_DEVELOPMENT`    |
| `LIFECYCLE_CRM`          | Lifecycle CRM        | `CRM_LIFECYCLE`      |
| `AI_AUTOMATIONS`         | AI Automations       | `AI_AUTOMATION`      |
| `VIDEO_MULTIMEDIA`       | Video & Multimedia   | `VIDEO_MULTIMEDIA`   |
| `ACCOUNT_MANAGEMENT`     | Account Management   | `ACCOUNT_MANAGEMENT` |

Internal teams: `ACCOUNT_MANAGEMENT`, `SEO`, `PAID_MEDIA`, `WEB_DEVELOPMENT`,
`CRM_LIFECYCLE`, `AI_AUTOMATION`, `VIDEO_MULTIMEDIA`.

**Why not merge them.** The 1:1 correspondence is real and is seeded as the
default, but it is a _default_, not an identity. A Web Core engagement may later
be delivered jointly by `WEB_DEVELOPMENT` and `SEO`. Expressing the relationship
as a mapping (`SERVICE_LINE_DEFAULT_TEAM`) rather than a single merged enum keeps
that option open at zero cost, while a `services` row may always override the
default.

**Why the catalogue is separate from the instance.** Collapsing "the seven
offerings" into "what this client bought" would force per-client duplication of
the catalogue and make cross-client reporting impossible. So Phase 2 creates
`service_lines` (reference data, seven rows, identical for every client) _and_
`services` (children of `engagement`, carrying scope, fee, dates, status and the
delivering team).

---

## 4. Multi-tenancy

**The tenant is the Organization.** Every tenant-scoped row carries
`organization_id`, including descendants several levels down.

This denormalization is deliberate (ADR-0005). RLS policies must be able to
answer "may this actor touch this row?" with a single indexed column. Resolving
tenancy through joins — `task → deliverable → project → service → engagement →
organization` — would be slow, and worse, joins inside policies are a classic
source of infinite policy recursion.

Drift is prevented **structurally**, not by discipline:

```sql
-- requires UNIQUE (id, organization_id) on projects
alter table tasks
  add constraint tasks_project_tenant_fk
  foreign key (project_id, organization_id)
  references projects (id, organization_id);
```

A task in a different tenant from its project is not "discouraged"; it is
unrepresentable. A `BEFORE INSERT` trigger additionally derives
`organization_id` from the parent row, so the value cannot be supplied — and
therefore cannot be spoofed — by a caller.

---

## 5. Money, time and identity

| Concern            | Decision                                                                                                                                              | Reason                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monetary values    | `numeric(14,2)` + an explicit `currency` column CHECKed against `USD, GBP, EUR, AED, AUD`                                                             | Floats must never represent money. Clients span four currency zones                                                                                  |
| FX conversion      | **Out of scope.** Reporting aggregates per currency only                                                                                              | Conversion introduces a rate table, a rate history and a rounding policy — none of which is a stated requirement (risk R-13, confirmation requested) |
| Timestamps         | `timestamptz`, always UTC, trigger-maintained                                                                                                         | The team operates 24/7 across four bureaus; local-time storage would make every cross-region report ambiguous                                        |
| Primary keys       | UUID, generated by PostgreSQL                                                                                                                         | Client-side generation leaks sequence information and complicates offline creation                                                                   |
| Public identifiers | Organization `slug`, engagement/project `code` — unique **per organization**, with partial unique indexes so a code can be reused after a soft delete | Humans read codes; UUIDs are for machines                                                                                                            |
| Deletion           | Soft delete (`deleted_at`) for tenant data                                                                                                            | Contractual retention obligations under `/terms-of-engagement`; hard delete destroys audit evidence                                                  |

---

## 6. What Phase 2 must add

Not modelled in Phase 1, because doing so before the schema exists would guarantee
drift (ADR-0004):

- **Status values and their transitions.** The state machine is a business rule
  set: `deliverable` needs `draft → submitted → client_review → approved |
revision_requested → published`, and each transition has an allowed-role set.
  Phase 5 implements it as a `status_transitions` reference table validated by a
  trigger, so the database and the API agree by construction.
- **Field-level entity types.** Generated from the schema via `npm run db:types`.
- **Metrics.** The public site's proof points (pipeline engineered, blended ROAS,
  P75 LCP, LTV:CAC, pages indexed, CAPI match rate, lead response time) imply the
  client dashboard's core value is _measurement truth_. `metrics` must therefore
  be first-class time-series data — `(date, service_line, metric_key, value,
currency)` — not free text inside a report body.
- **Internal-only fields.** Cost, margin and internal notes must be separated by
  _column or table_, never hidden by UI. A `client_visible` flag plus column-level
  grants is the mechanism; "the client cannot see that button" is not.
