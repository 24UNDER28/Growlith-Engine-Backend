# Phase 4 — Authorization Design

**Status:** designed — **not implemented**, by instruction. No policy, no matrix
constant, no guard and no RPC body ships in this phase. This document is the
Phase 4 contract; the implementation sequence is [§18](#18-implementation-sequence).
**Decisions:** [ADR-0007](adr/ADR-0007-two-authorization-layers.md) (two
independent authorization layers), [ADR-0010](adr/ADR-0010-four-roles-r1-accepted-and-open.md)
(the role model stays at four roles; risk R-1 accepted and left open).
**Inputs:** Phase 1 architecture (`docs/architecture/README.md` §D, §F, §L),
Phase 2 schema (`docs/architecture/schema.md`, 23 tables, 38 RLS-forced
relations, 12 `SECURITY DEFINER` predicate helpers, column-level grants),
Phase 3 authentication (`docs/architecture/authentication.md`, `AuthContext`,
`requireAuthContext()`, `public.auth_context()`), and the role/entity
vocabulary in `src/lib/domain/`.

---

## 0. Summary

Authorization is answered in **four questions, evaluated in a fixed order**, and
enforced by **two independent mechanisms** that share one definition of identity
but not one implementation.

```
 Q1  ORGANIZATION   Does this actor reach this tenant at all?
 Q2  RESOURCE       Is this resource in this role's vocabulary?
 Q3  ACTION         Is this verb granted to this role on that resource?
 Q4  PROJECT        Does the object satisfy the project-membership qualifier?
       ↓
 …then the scope qualifiers that are not role facts at all:
     visibility gate (client_visible + status), state machine, column grants
```

- **Layer 1 — capability matrix, in the application.** One typed constant,
  `src/lib/domain/permissions.ts`, answers Q2 and Q3 for a `(role, resource,
action)` triple. It is pure data, imported unchanged by the API guard, the RSC
  page guards, the UI and the test suite. It answers _"may this actor attempt
  this verb?"_ and nothing else.
- **Layer 2 — Row Level Security, in PostgreSQL.** Answers Q1 and Q4 and the
  visibility gate, on every statement, regardless of which code path issued it.
  It answers _"which rows may this statement touch?"_ and nothing else.
- **Layer 2b — `SECURITY DEFINER` RPCs.** A deliberately small, closed set of
  privilege-changing rules that are not expressible as a predicate over the new
  row (ADR-0012). Enumerated exhaustively in [§14](#14-security-definer-rpcs--the-closed-set).
- **Layer 0 — column `GRANT`s.** Already shipped in Phase 2. A column the role
  cannot select does not need a policy.

**The matrix is never duplicated into SQL, and RLS is never re-expressed in
TypeScript.** That is the single most important structural decision in this
phase: the two layers are complementary, not redundant, so there is no pair of
artefacts that can silently disagree about the same fact. The one fact they do
share — who the caller is, what status they hold, which organizations they reach
— is resolved by the same `SECURITY DEFINER` helpers on both sides (ADR-0011).

Forgetting Layer 1 leaves a caller able to _attempt_ an operation whose rows RLS
will not return or accept. Forgetting Layer 2 leaves a caller able to reach rows
the guard believed it had scoped. Neither omission is silent, and neither alone
is sufficient.

> **Frontend visibility is not the security boundary.** [§11](#k-frontend-permission-awareness)
> specifies how the UI becomes permission-aware, and specifies with equal
> weight that every affordance it hides is independently denied by the API guard
> and by RLS. A hidden button is a courtesy to the user, not a control.

---

# Part I — The model

## 1. Vocabulary

### 1.1 Actions — the eleven verbs

Declared once, in `src/lib/domain/permissions.ts`, as `ACTIONS`.

| Action            | Meaning                                                            | Distinct from                                                                              |
| ----------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `CREATE`          | Bring a new row into existence under a parent the actor can reach  | `ASSIGN` — creating a task is not staffing it                                              |
| `READ`            | Retrieve the row, subject to column grants                         | `DOWNLOAD` — reading file _metadata_ is not fetching the bytes                             |
| `UPDATE`          | Modify mutable, non-privileged fields                              | `APPROVE`/`PUBLISH` — status changes are their own verbs                                   |
| `DELETE`          | Soft delete (`deleted_at`). Hard delete is SUPER_ADMIN purge only  | —                                                                                          |
| `ASSIGN`          | Bind a person or team to a row (assignee, lead, account manager)   | `MANAGE_MEMBERS` — assignment names one accountable party; membership grants access        |
| `APPROVE`         | Record a client's acceptance decision on a deliverable             | `PUBLISH` — approval is the client's act, publication is Growlith's                        |
| `PUBLISH`         | Release a deliverable or report to the client as final             | `UPDATE` of `client_visible` — publication is a state transition with a frozen snapshot    |
| `UPLOAD`          | Mint a signed upload URL and register the metadata row             | `CREATE` on `files` — the metadata row without the object is not an upload                 |
| `DOWNLOAD`        | Mint a signed download URL for object bytes                        | `READ` — see above                                                                         |
| `MANAGE_MEMBERS`  | The composite membership capability at organization/project scope  | `CREATE`/`UPDATE`/`DELETE` on the membership row — see the decomposition note below        |
| `MANAGE_SETTINGS` | Change configuration that alters how the system behaves for others | `UPDATE` — settings are a separate table precisely so this is a policy, not a column grant |

**`MANAGE_MEMBERS` is a composite, and the decomposition is deliberate.** It is
the capability the UI and the API declare; it decomposes to
`CREATE`/`UPDATE`/`DELETE` on `organization_memberships` or
`project_memberships`. Both forms appear in the matrix because they are checked
at different layers: `MANAGE_MEMBERS` is the route capability, the decomposed
verbs are what the RPC and RLS see. They must never disagree, which is why the
matrix derives one from the other rather than listing both by hand.

### 1.2 Resources — the fourteen, and their tables

A "resource" is an authorization subject, not a table. Several resources span
more than one table; every table in the schema belongs to exactly one resource,
which is what makes the coverage assertion in [§16](#16-verification-strategy)
possible.

| Resource             | Backing tables                           | Tenant-scoped | Client-reachable |
| -------------------- | ---------------------------------------- | :-----------: | :--------------: |
| `organization`       | `organizations`, `organization_settings` |  tenant root  |        ✅        |
| `user`               | `profiles`                               |    global     |    partial ᶜ     |
| `membership`         | `organization_memberships`               |      ✅       |        ✅        |
| `platform_grant`     | `platform_role_grants`                   |    global     |        ✗         |
| `invitation`         | `invitations`                            |  ✅ / global  |     partial      |
| `team_membership`    | `staff_team_memberships`, `teams`        |    global     |        ✗         |
| `engagement`         | `engagements`                            |      ✅       |       ✅ ᶜ       |
| `service`            | `services`, `service_lines`              |      ✅       |       ✅ ᶜ       |
| `project`            | `projects`                               |      ✅       |        ✅        |
| `project_membership` | `project_memberships`                    |      ✅       |       ✅ ᶜ       |
| `task`               | `tasks`                                  |      ✅       |      **✗**       |
| `deliverable`        | `deliverables`, `deliverable_versions`   |      ✅       |        ✅        |
| `report`             | `reports`, `report_metrics`, `metrics`   |      ✅       |        ✅        |
| `file`               | `files`, `storage.objects`               |      ✅       |        ✅        |
| `notification`       | `notifications`                          |   recipient   |        ✅        |
| `activity`           | `audit_events` (+ 14 partitions)         |  org-tagged   |     **✗** ᶠ      |
| `comment`            | `comments`                               |      ✅       |        ✅        |
| `status_transition`  | `status_transitions`                     |    global     |   ✅ read-only   |

ᶜ = reachable but column-restricted (Phase 2 grants; [§7](#f-internal-only-data)).
ᶠ = no direct read; a projected feed only ([§7.4](#f4-activity-records-are-not-a-client-resource)).

Seventeen rows for fourteen named resources: `platform_grant`, `invitation` and
`team_membership` are split out of "memberships" because they carry
fundamentally different rules — one is SUPER_ADMIN-only, one is the
pre-membership ledger, one is internal org structure a client must never see. A
single `membership` cell would have had to say "it depends", which is how a
matrix stops being a control.

### 1.3 Capability identifiers

`{resource}:{action}` in lower snake case — `deliverable:approve`,
`organization:manage_settings`. This string is:

- the key of the matrix constant;
- the value of the required `capability` field on every `RouteDefinition` ([§10](#j-api-authorization-strategy));
- the value logged on every allow and every deny;
- the `entity_kind` + `action` pair written to `audit_events` on a denial.

It is a **contract string**. Renaming one is a breaking change to `/api/v1` on
the same terms as renaming an error code.

## 2. The actor

The authorization subject is the Phase 3 `AuthContext` — resolved per request
from PostgreSQL, never from a JWT claim (ADR-0011) — plus two facts Phase 4
adds:

```ts
interface Actor {
  readonly userId: string;
  readonly userType: 'INTERNAL' | 'CLIENT';
  readonly accountStatus: AccountStatus; // gate already applied by Phase 3
  readonly platformRole: PlatformRole | null; // SUPER_ADMIN | ADMIN | null
  readonly memberships: readonly AuthContextMembership[]; // org → role → status
  readonly aal: 'aal1' | 'aal2';
  // Phase 4 additions, resolved by the same auth_context() round trip:
  readonly teams: readonly InternalTeam[]; // staff_team_memberships
  readonly projectRoles: ReadonlyMap<string, ProjectMemberRole>; // projectId → role
}
```

`teams` and `projectRoles` are **added to the existing `auth_context()`
payload**, not fetched separately. Phase 3 already pays for one round trip and
memoises it per request with React `cache()`; a second query for authorization
would double the hot path for facts the first query is already positioned to
return. `projectRoles` is bounded — the schema's unique index guarantees at most
one live membership per `(project, user)` — and is capped at 500 entries with an
explicit overflow flag, so a heavily-staffed internal user degrades to
"consult the database per project" rather than silently truncating.

### 2.1 Effective role

Exactly one role is in effect for any `(actor, organization)` pair:

```
effectiveRole(actor, orgId) =
  actor.platformRole                              if platformRole !== null
  membership.role  where membership.organizationId === orgId
                   and membership.status === 'ACTIVE'
  null                                            otherwise → deny
```

Platform role **outranks and replaces** organization role; it does not merge
with it. An internal staff member who is also a `CLIENT_MEMBER` of a client
organization (a real case — a Growlith employee at a partner company) acts as
their platform role there, and the membership grants nothing additional. Union
semantics were rejected: "the caller gets the most permissive of their roles" is
how an escalation path is built by accident.

There is no role stacking, no role inheritance and no wildcard role. `SUPER_ADMIN`
is not `ADMIN + extra` in the type system — it is a separate column in the
matrix whose cells happen to be a superset. Modelling it as inheritance would
make "ADMIN cannot delete an organization" an exception to a rule instead of a
cell in a table.

## 3. Level 1 — organization (tenant) scope

**The tenant is the organization. Reach is binary, and it is decided before any
capability is consulted.**

```
reachesTenant(actor, orgId) =
     actor.platformRole !== null                 // internal: all tenants
  || actor.memberships.some(m => m.organizationId === orgId
                              && m.status === 'ACTIVE')
```

This is the application-side mirror of the Phase 2 helper
`public.has_org_access(uuid)`, which is what RLS evaluates. They are written to
be the same predicate; the pgTAP suite ([§16](#16-verification-strategy)) proves
they agree, because a mirror that drifts is worse than no mirror.

Three consequences that are properties of the schema, not of policy:

1. **`organization_id` is never accepted from a request.** It is derived
   server-side from the parent row and, independently, by the
   `growlith.derive_organization_id()` trigger, which _raises_ on a disagreeing
   client-supplied value rather than correcting it.
2. **A row cannot move between tenants.** `growlith.freeze_organization_id()`
   rejects any UPDATE of the tenant key.
3. **A cross-tenant child is unrepresentable**, not merely forbidden: 21
   composite foreign keys `(parent_id, organization_id) → parent(id,
organization_id)`.

The full isolation model is [§5](#c-tenant-isolation-model).

## 4. Levels 2 and 3 — resource and action

Q2 and Q3 are a single lookup against the matrix constant. The matrix is
**dense, not sparse**: every `(role, resource, action)` triple has an explicit
cell, and the absence of a cell is a type error rather than a default. A default
of "deny" would be safe but silent; an explicit `DENY` is reviewable in a diff.

```ts
// Shape only — authored in Phase 5's first implementation step, not here.
type Grant =
  | { kind: 'DENY' }
  | { kind: 'NA' } // the verb is not defined for this resource
  | { kind: 'ALLOW'; scope: Scope; qualifiers: readonly Qualifier[] };

type Scope = 'GLOBAL' | 'TENANT' | 'SELF';
type Qualifier =
  | 'CLIENT_VISIBLE' // the row's client_visible gate + state gate
  | 'PROJECT_MEMBER' // level 4 — see §6
  | 'STATE_MACHINE' // status_transitions.allowed_roles must also permit it
  | 'RPC_ONLY' // not reachable by direct PostgREST write
  | 'COLUMN_RESTRICTED' // Phase 2 column grants narrow the row
  | 'OWN_ROW'; // author/uploader/recipient only
```

`Scope` is what the guard checks; `Qualifier` is what the guard **records as an
obligation** and what RLS and the service layer then enforce. The guard does not
evaluate `CLIENT_VISIBLE` itself — it cannot, because it has not loaded the row
yet — but by carrying the qualifier it makes the obligation visible to the
contract test, which asserts that every capability carrying `CLIENT_VISIBLE` has
a matching RLS policy predicate ([§16](#16-verification-strategy)).

## 5. Level 4 — project membership

**Decision: project membership is an _object-side qualifier_, not a subject-side
gate, for internal actors.** `SUPER_ADMIN` and `ADMIN` read and write every
project in every tenant; membership narrows nothing for them. This is the honest
consequence of the four-role model: with no `TEAM_MEMBER` role, gating internal
reads on project membership would mean every ADMIN must be explicitly staffed
onto every project before they can do their job, and the predictable response to
that is a blanket auto-staffing script — a control that exists on paper and not
in fact. See [ADR-0010](adr/ADR-0010-four-roles-r1-accepted-and-open.md).

What membership _does_ decide, in five places, is real and enforced:

| #   | Rule                                                                                                                                                                                                             | Enforced by                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | **A task's assignee must hold a live membership on the task's project.** `task:assign` is granted to ADMIN, but the _object_ must satisfy it                                                                     | Service layer + a new `growlith.enforce_task_assignee_membership()` trigger |
| 2   | **A deliverable version's `reviewed_by` must be a `LEAD` or `REVIEWER` on the project.** An internal review by a non-reviewer is not a review                                                                    | Definer RPC `submit_deliverable_review()`                                   |
| 3   | **`project:manage_members` requires `LEAD` on that project, or a platform role.** A CONTRIBUTOR cannot staff their own project                                                                                   | Matrix qualifier + RPC                                                      |
| 4   | **Notification fan-out and "my work" views are membership-derived.** Not authorization, but the same data, and it must not diverge                                                                               | Service layer, reading `projectRoles`                                       |
| 5   | **A client user may be a project member** (`OBSERVER`/`REVIEWER`) — the Phase 2 tenancy trigger permits it. Membership adds **no read** beyond the client-visibility gate; it drives notification targeting only | `§6`, explicitly                                                            |

Rule 5 is stated because the schema permits something the authorization model
deliberately does not use. `project_memberships` accepts a `CLIENT` profile with
an active organization membership, so a future "narrow this client contact to
two projects" feature is a policy change, not a migration. **Phase 4 does not
build it**, and client reads remain organization-wide within the visibility
gate. Recording the unused capacity is the difference between a decision and an
oversight.

### 5.1 `project_member_role` semantics

| Role          | Grants                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------- |
| `LEAD`        | Satisfies rules 1–3. At most one per project (partial unique index)                      |
| `CONTRIBUTOR` | Satisfies rule 1 as an assignee. Default for staffing                                    |
| `REVIEWER`    | Satisfies rule 2. May be internal or client-side                                         |
| `OBSERVER`    | Satisfies nothing. Membership for visibility of "my projects" and notification targeting |

### 5.2 New predicate helpers (design; authored in the implementation step)

Three additions to the Phase 2 set, same contract: `SECURITY DEFINER`, `STABLE`,
`set search_path = pg_catalog, public, pg_temp`, `execute` granted to
`authenticated` (ADR-0008).

```sql
-- Design sketch. NOT a migration; nothing in this document is applied.
create or replace function public.current_project_ids() returns uuid[] ...
create or replace function public.project_role_in(p_project_id uuid)
  returns public.project_member_role ...
create or replace function public.is_project_member(p_project_id uuid) returns boolean ...
```

`current_project_ids()` is backed by the existing
`project_memberships (user_id) where deleted_at is null` index.

---

# Part II — The deliverables

## A. Role matrix

The four roles, as authorization contracts rather than descriptions. Every
statement below is a cell in [§B](#b-resourceaction-matrix); this table is the
summary a reviewer reads first.

| Dimension                                            | `SUPER_ADMIN`                    | `ADMIN`                | `CLIENT_ADMIN`                                   | `CLIENT_MEMBER`                        |
| ---------------------------------------------------- | -------------------------------- | ---------------------- | ------------------------------------------------ | -------------------------------------- |
| Axis                                                 | platform (global)                | platform (global)      | organization (one tenant)                        | organization (one tenant)              |
| `user_type`                                          | `INTERNAL`                       | `INTERNAL`             | `CLIENT`                                         | `CLIENT`                               |
| Tenant reach                                         | all                              | all                    | own organizations only                           | own organizations only                 |
| Landing surface                                      | `/admin`                         | `/admin`               | `/portal`                                        | `/portal`                              |
| MFA                                                  | **mandatory** (`aal2`)           | **mandatory** (`aal2`) | optional                                         | optional                               |
| Sees internal-only columns                           | ✅                               | ✅                     | ✗ (revoked at GRANT)                             | ✗ (revoked at GRANT)                   |
| Sees `tasks`                                         | ✅                               | ✅                     | ✗ (no policy exists)                             | ✗ (no policy exists)                   |
| Sees internal comments                               | ✅                               | ✅                     | ✗                                                | ✗                                      |
| Grants platform roles                                | ✅ (RPC)                         | ✗                      | ✗                                                | ✗                                      |
| Deletes an organization                              | ✅ (soft) + purge RPC            | ✗                      | ✗                                                | ✗                                      |
| Changes platform settings                            | ✅                               | ✗                      | ✗                                                | ✗                                      |
| Manages organization members                         | ✅                               | ✅                     | ✅ **may only ever grant `CLIENT_MEMBER`** (RPC) | ✗                                      |
| Manages organization settings                        | ✅                               | ✅                     | ✅ (own tenant)                                  | ✗                                      |
| Approves deliverables                                | ✅ (override)                    | ✅ (override)          | ✅ — the intended actor                          | ✗                                      |
| Publishes deliverables/reports                       | ✅                               | ✅                     | ✗                                                | ✗                                      |
| Creates commercial rows (engagement/service/project) | ✅                               | ✅                     | ✗                                                | ✗                                      |
| Comments                                             | ✅ incl. `is_internal`           | ✅ incl. `is_internal` | ✅ client-visible only, never on tasks           | ✅ client-visible only, never on tasks |
| Uploads                                              | ✅                               | ✅                     | ✅ (own tenant)                                  | ✅ (own tenant)                        |
| Downloads                                            | ✅                               | ✅                     | ✅ client-visible + `CLEAN` only                 | ✅ client-visible + `CLEAN` only       |
| Reads activity/audit                                 | ✅ (all)                         | ✅ (all)               | ✗ direct — projected feed only                   | ✗                                      |
| Hard deletes anything                                | ✅ purge RPC only, audited first | ✗                      | ✗                                                | ✗                                      |

**The `SUPER_ADMIN` / `ADMIN` split, stated precisely.** `ADMIN` operates the
machine; `SUPER_ADMIN` holds exactly the operations that are irreversible or
that **change who else holds power**. That is the whole of the distinction, and
it is what makes the split defensible rather than decorative:

1. `platform_grant:create` / `platform_grant:delete` — granting and revoking
   internal roles.
2. `organization:delete` and the purge RPC — irreversible destruction of a
   tenant.
3. `user:delete` — GDPR erasure, which bypasses append-only triggers.
4. Platform settings (a Phase 7 table; the capability is reserved now so the
   route cannot ship without one).
5. The **reopening transitions** already seeded in `status_transitions` with
   `allowed_roles = {SUPER_ADMIN}`: `engagement ACTIVE|PAUSED → CANCELLED`,
   `service COMPLETED → ACTIVE`, `project COMPLETED → IN_PROGRESS`,
   `deliverable APPROVED|PUBLISHED → IN_PROGRESS`. Un-publishing something a
   client has already been shown is a trust event, not an edit.

**The `CLIENT_ADMIN` ceiling, stated precisely.** A `CLIENT_ADMIN` is the client
side's owner and is _still not_ an administrator of the system. Four hard
ceilings, all enforced in the definer RPC because none is expressible as a
predicate over the new row alone:

1. May only ever create or set `role = 'CLIENT_MEMBER'`. `CLIENT_ADMIN`
   elevation requires an internal actor. Rationale: otherwise the first
   compromised client admin permanently owns the tenant.
2. May not modify their own membership row (no self-demotion races, no
   self-elevation).
3. May not remove the last live `CLIENT_ADMIN` of the organization, nor the
   `is_primary_contact` holder without naming a replacement in the same call.
4. May not touch `platform_role_grants`, `staff_team_memberships` or any row of
   another tenant — these are not "denied", they are **not granted to
   `authenticated` at all** at the GRANT layer.

## B. Resource/action matrix

**Legend.** Grant symbol, then bracketed qualifiers.

| Symbol | Meaning                                                                                    |
| :----: | ------------------------------------------------------------------------------------------ |
|  `●`   | Allowed, unconditional within the role's tenant reach                                      |
|  `◑`   | Allowed, **own tenant only** (`has_org_access`)                                            |
|  `◒`   | Allowed, own tenant **and** the client-visibility gate of [§E](#e-client-visibility-model) |
|  `◦`   | Allowed, **own row only** — author, uploader, recipient, or self                           |
|  `✗`   | Denied                                                                                     |
|  `—`   | Action not defined for this resource (a type error, not a runtime deny)                    |

| Qualifier | Meaning                                                                                   |
| :-------: | ----------------------------------------------------------------------------------------- |
|   `[R]`   | Reachable only through a `SECURITY DEFINER` RPC; direct write is revoked at GRANT level   |
|   `[S]`   | Additionally constrained by `status_transitions.allowed_roles`                            |
|   `[P]`   | Project-membership qualifier applies to the object ([§5](#5-level-4--project-membership)) |
|   `[C]`   | Column-restricted — internal-only columns are not granted to `authenticated`              |

### B.1 Identity and access

| Resource          | Action            | `SUPER_ADMIN` | `ADMIN` | `CLIENT_ADMIN` | `CLIENT_MEMBER` | Notes                                                                         |
| ----------------- | ----------------- | ------------- | ------- | -------------- | --------------- | ----------------------------------------------------------------------------- |
| `organization`    | `create`          | `●`           | `●`     | `✗`            | `✗`             | Tenant creation is internal by definition                                     |
| `organization`    | `read`            | `●`           | `●`     | `◑`            | `◑`             | Client sees its own row; `notes_internal`-class columns not granted           |
| `organization`    | `update`          | `●`           | `●`     | `✗`            | `✗`             | Legal name, region, status are contractual facts                              |
| `organization`    | `delete`          | `● [R]`       | `✗`     | `✗`            | `✗`             | Soft delete; purge is a separate SUPER_ADMIN RPC that audits first            |
| `organization`    | `assign`          | `●`           | `●`     | `✗`            | `✗`             | `account_manager_user_id`                                                     |
| `organization`    | `manage_settings` | `●`           | `●`     | `◑`            | `✗`             | `organization_settings` is a separate table so this is a policy, not a grant  |
| `organization`    | `manage_members`  | `●`           | `●`     | `◑ [R]`        | `✗`             | Decomposes to `membership:*`; the `CLIENT_ADMIN` ceiling applies              |
| `user`            | `create`          | `● [R]`       | `● [R]` | `◑ [R]`        | `✗`             | Only by invitation. Sign-up is disabled                                       |
| `user`            | `read`            | `●`           | `●`     | `◑`            | `◑`             | Client sees co-members + staff identities on their work; not the staff roster |
| `user`            | `update`          | `●`           | `● [R]` | `◦`            | `◦`             | ADMIN may not alter a SUPER_ADMIN's account; status changes are RPC + audited |
| `user`            | `delete`          | `● [R]`       | `✗`     | `✗`            | `✗`             | GDPR erasure. Bypasses append-only triggers, so SUPER_ADMIN only              |
| `membership`      | `create`          | `● [R]`       | `● [R]` | `◑ [R]`        | `✗`             | `CLIENT_ADMIN`: `CLIENT_MEMBER` role only                                     |
| `membership`      | `read`            | `●`           | `●`     | `◑`            | `◑`             |                                                                               |
| `membership`      | `update`          | `● [R]`       | `● [R]` | `◑ [R]`        | `✗`             | Four ceilings in [§A](#a-role-matrix)                                         |
| `membership`      | `delete`          | `● [R]`       | `● [R]` | `◑ [R]`        | `✗`             | Soft delete; last-admin and primary-contact rules apply                       |
| `platform_grant`  | `create`          | `● [R]`       | `✗`     | `✗`            | `✗`             | The role-granting operation. SUPER_ADMIN only, CRITICAL audit                 |
| `platform_grant`  | `read`            | `●`           | `◦`     | `✗`            | `✗`             | ADMIN may see its own grant, not the roster of who else holds power           |
| `platform_grant`  | `delete`          | `● [R]`       | `✗`     | `✗`            | `✗`             | Revocation is an UPDATE of `revoked_at`; the table is never deleted from      |
| `invitation`      | `create`          | `●`           | `●`     | `◑`            | `✗`             | `CLIENT_ADMIN`: own org, `CLIENT_MEMBER` branch only                          |
| `invitation`      | `read`            | `●`           | `●`     | `◑`            | `✗`             | Never the token; `token_hash` is not granted                                  |
| `invitation`      | `update`          | `●`           | `●`     | `◑`            | `✗`             | Resend and revoke only; terms are frozen by trigger after issue               |
| `invitation`      | `delete`          | `✗`           | `✗`     | `✗`            | `✗`             | Expired rows are removed by the retention job, not by a person                |
| `team_membership` | `create`          | `●`           | `●`     | `✗`            | `✗`             | Internal delivery structure                                                   |
| `team_membership` | `read`            | `●`           | `●`     | `✗`            | `✗`             | A client must not be able to enumerate Growlith's staff by team               |
| `team_membership` | `update`          | `●`           | `●`     | `✗`            | `✗`             |                                                                               |
| `team_membership` | `delete`          | `●`           | `●`     | `✗`            | `✗`             |                                                                               |

### B.2 Commercial hierarchy

| Resource     | Action           | `SUPER_ADMIN` | `ADMIN` | `CLIENT_ADMIN` | `CLIENT_MEMBER` | Notes                                                                         |
| ------------ | ---------------- | ------------- | ------- | -------------- | --------------- | ----------------------------------------------------------------------------- |
| `engagement` | `create`         | `●`           | `●`     | `✗`            | `✗`             |                                                                               |
| `engagement` | `read`           | `●`           | `●`     | `◑ [C]`        | `◑ [C]`         | `contract_value`, `monthly_retainer`, `notes_internal` **not granted**        |
| `engagement` | `update`         | `● [S]`       | `● [S]` | `✗`            | `✗`             |                                                                               |
| `engagement` | `delete`         | `●`           | `●`     | `✗`            | `✗`             | Soft delete                                                                   |
| `engagement` | `assign`         | `●`           | `●`     | `✗`            | `✗`             | `account_manager_user_id`                                                     |
| `service`    | `create`         | `●`           | `●`     | `✗`            | `✗`             |                                                                               |
| `service`    | `read`           | `●`           | `●`     | `◑ [C]`        | `◑ [C]`         | `fee`, `fee_model` **not granted**                                            |
| `service`    | `update`         | `● [S]`       | `● [S]` | `✗`            | `✗`             |                                                                               |
| `service`    | `delete`         | `●`           | `●`     | `✗`            | `✗`             |                                                                               |
| `service`    | `assign`         | `●`           | `●`     | `✗`            | `✗`             | `delivering_team`, `lead_user_id`                                             |
| `project`    | `create`         | `●`           | `●`     | `✗`            | `✗`             |                                                                               |
| `project`    | `read`           | `●`           | `●`     | `◒`            | `◒`             | `client_visible` defaults **true** — the client may see the shape of the work |
| `project`    | `update`         | `● [S]`       | `● [S]` | `✗`            | `✗`             |                                                                               |
| `project`    | `delete`         | `●`           | `●`     | `✗`            | `✗`             |                                                                               |
| `project`    | `assign`         | `● [P]`       | `● [P]` | `✗`            | `✗`             | `lead_user_id` must hold a `LEAD` membership; `owning_team`                   |
| `project`    | `manage_members` | `●`           | `● [P]` | `✗`            | `✗`             | ADMIN requires `LEAD` on that project (rule 3), SUPER_ADMIN overrides         |

### B.3 Delivery

| Resource             | Action     | `SUPER_ADMIN` | `ADMIN` | `CLIENT_ADMIN` | `CLIENT_MEMBER` | Notes                                                                                |
| -------------------- | ---------- | ------------- | ------- | -------------- | --------------- | ------------------------------------------------------------------------------------ |
| `project_membership` | `create`   | `●`           | `● [P]` | `✗`            | `✗`             | Tenancy trigger already refuses a cross-tenant person                                |
| `project_membership` | `read`     | `●`           | `●`     | `◒ [C]`        | `◒ [C]`         | Roster of a visible project; `allocation_pct` not exposed                            |
| `project_membership` | `update`   | `●`           | `● [P]` | `✗`            | `✗`             |                                                                                      |
| `project_membership` | `delete`   | `●`           | `● [P]` | `✗`            | `✗`             |                                                                                      |
| `task`               | `create`   | `●`           | `●`     | `✗`            | `✗`             |                                                                                      |
| `task`               | `read`     | `●`           | `●`     | **`✗`**        | **`✗`**         | **No client policy exists on `tasks`.** Not a flag — an absent policy                |
| `task`               | `update`   | `● [S]`       | `● [S]` | `✗`            | `✗`             |                                                                                      |
| `task`               | `delete`   | `●`           | `●`     | `✗`            | `✗`             |                                                                                      |
| `task`               | `assign`   | `● [P]`       | `● [P]` | `✗`            | `✗`             | Assignee must be a live project member (rule 1)                                      |
| `deliverable`        | `create`   | `●`           | `●`     | `✗`            | `✗`             |                                                                                      |
| `deliverable`        | `read`     | `●`           | `●`     | `◒`            | `◒`             | `client_visible` **and** status ≥ `CLIENT_REVIEW` — [§E](#e-client-visibility-model) |
| `deliverable`        | `update`   | `● [S]`       | `● [S]` | `✗`            | `✗`             |                                                                                      |
| `deliverable`        | `delete`   | `●`           | `●`     | `✗`            | `✗`             |                                                                                      |
| `deliverable`        | `assign`   | `● [P]`       | `● [P]` | `✗`            | `✗`             | `owner_user_id`                                                                      |
| `deliverable`        | `approve`  | `● [S]`       | `● [S]` | `◒ [R][S]`     | `✗`             | The client-driven transition. `CLIENT_REVIEW → APPROVED \| REVISION_REQUESTED`       |
| `deliverable`        | `publish`  | `● [S]`       | `● [S]` | `✗`            | `✗`             | `APPROVED → PUBLISHED`. Growlith's act, never the client's                           |
| `deliverable`        | `upload`   | `●`           | `●`     | `◒`            | `◒`             | Client feedback attachments; delegates to `file:upload`                              |
| `deliverable`        | `download` | `●`           | `●`     | `◒`            | `◒`             | Delegates to `file:download`                                                         |

`deliverable_versions` is append-only and inherits its parent's read rule
exactly. It has no `update` and no `delete` cell for any role, including
`service_role` — the trigger refuses.

### B.4 Reporting, files, communication, activity

| Resource       | Action           | `SUPER_ADMIN` | `ADMIN` | `CLIENT_ADMIN` | `CLIENT_MEMBER` | Notes                                                                                                                 |
| -------------- | ---------------- | ------------- | ------- | -------------- | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `report`       | `create`         | `●`           | `●`     | `✗`            | `✗`             |                                                                                                                       |
| `report`       | `read`           | `●`           | `●`     | `◒`            | `◒`             | `client_visible` **and** `status = 'PUBLISHED'`                                                                       |
| `report`       | `update`         | `●`           | `●`     | `✗`            | `✗`             | Frozen once published; `report_metrics` is append-only regardless                                                     |
| `report`       | `delete`         | `●`           | `●`     | `✗`            | `✗`             |                                                                                                                       |
| `report`       | `publish`        | `●`           | `●`     | `✗`            | `✗`             | Freezes `report_metrics`; sets `published_at`/`published_by`/`client_visible`                                         |
| `report`       | `download`       | `●`           | `●`     | `◒`            | `◒`             | Export of a published report. Audited as `EXPORT`                                                                     |
| `report`       | `read` (metrics) | `●`           | `●`     | `◑`            | `◑`             | Raw `metrics` are the client's own performance data — organization-wide, no flag                                      |
| `file`         | `upload`         | `●`           | `●`     | `◑`            | `◑`             | Signed URL; path must begin `{organization_id}/`                                                                      |
| `file`         | `read`           | `●`           | `●`     | `◒`            | `◒`             | Metadata. Gate = `client_visible` ∧ parent visible ∧ `scan_status = 'CLEAN'`                                          |
| `file`         | `download`       | `●`           | `●`     | `◒`            | `◒`             | Same gate, plus a 60 s signed URL. Audited as `FILE_DOWNLOAD`                                                         |
| `file`         | `update`         | `●`           | `●`     | `◦`            | `◦`             | Rename/reclassify own upload only                                                                                     |
| `file`         | `delete`         | `●`           | `●`     | `◦`            | `◦`             | Soft delete of own upload; purge is a job                                                                             |
| `comment`      | `create`         | `●`           | `●`     | `◒`            | `◒`             | Clients: never `is_internal`, never on a task (trigger already refuses)                                               |
| `comment`      | `read`           | `●`           | `●`     | `◒`            | `◒`             | Plus `is_internal = false`                                                                                            |
| `comment`      | `update`         | `●`           | `◦`     | `◦`            | `◦`             | Author only, within the edit window; SUPER_ADMIN may moderate                                                         |
| `comment`      | `delete`         | `●`           | `●`     | `◦`            | `◦`             | Soft delete                                                                                                           |
| `notification` | `create`         | `✗`           | `✗`     | `✗`            | `✗`             | **No role may create one.** Server-side emission only, via definer                                                    |
| `notification` | `read`           | `◦`           | `◦`     | `◦`            | `◦`             | `recipient_user_id = auth.uid()`. Even SUPER_ADMIN reads only their own inbox                                         |
| `notification` | `update`         | `◦`           | `◦`     | `◦`            | `◦`             | `read_at` / `archived_at` only                                                                                        |
| `notification` | `delete`         | `✗`           | `✗`     | `✗`            | `✗`             | Retention job                                                                                                         |
| `activity`     | `read`           | `●`           | `●`     | **`✗`**        | **`✗`**         | No client policy on `audit_events`; a projected feed instead ([§7.4](#f4-activity-records-are-not-a-client-resource)) |
| `activity`     | `create`         | `✗`           | `✗`     | `✗`            | `✗`             | Written by trigger and definer only                                                                                   |
| `activity`     | `update`         | `✗`           | `✗`     | `✗`            | `✗`             | Append-only, enforced for **every** role including `service_role`                                                     |
| `activity`     | `delete`         | `✗`           | `✗`     | `✗`            | `✗`             | Idem                                                                                                                  |

**`notification:read` is `◦` for SUPER_ADMIN too.** That is not an oversight and
not an inconsistency: a notification is a personal delivery, and there is no
operational reason to read another person's inbox. The auditable record of what
happened is `audit_events`, which SUPER_ADMIN reads in full. Where a role's
maximum is genuinely lower than "everything", the matrix says so.

## C. Tenant isolation model

Seven mechanisms. Each catches what the ones above it cannot; the first five
exist already (Phase 2), the last two are Phase 4's obligation.

| #   | Mechanism                        | Layer      | What it makes impossible                                                                                        | Status                                        |
| --- | -------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | Denormalized `organization_id`   | schema     | A tenant check that needs a join, and therefore a policy that can recurse                                       | ✅ Phase 2, 13 tables                         |
| 2   | Composite FKs `(id, org_id)`     | constraint | A child row in a different tenant from its parent — a constraint violation, not a bug                           | ✅ Phase 2, 21 of them                        |
| 3   | `derive_organization_id()`       | trigger    | A caller supplying the tenant key. A disagreeing value **raises**; it is not silently corrected                 | ✅ Phase 2                                    |
| 4   | `freeze_organization_id()`       | trigger    | A row moving between tenants after insert                                                                       | ✅ Phase 2                                    |
| 5   | Column `GRANT`s                  | privilege  | A client selecting `contract_value` even under a permissive policy                                              | ✅ Phase 2                                    |
| 6   | **RLS policies**                 | **row**    | **A statement returning or writing a row of another tenant, whatever the calling code believed**                | **⬜ Phase 4 — [§H](#h-rls-policy-strategy)** |
| 7   | **Storage path + object policy** | **object** | **Reading bytes across a tenant prefix, and (new) reading a non-client-visible object within one's own tenant** | **⬜ Phase 4 — [§H.6](#h6-storageobjects)**   |

**The single legitimate cross-organization edge is `organization_memberships`**,
and it is the only place a person meets a tenant. Every write to it is audited
at `CRITICAL` severity and is RPC-only. `project_memberships` looks like a
second such edge and is not: its tenancy trigger refuses any client user without
a live membership in that same organization.

**Never crosses an organization boundary** (12 tables): `engagements`,
`services`, `projects`, `project_memberships`, `deliverables`,
`deliverable_versions`, `tasks`, `comments`, `files`, `reports`,
`report_metrics`, `metrics`.

**Deliberately not tenant-scoped:** `profiles` (a person is global; their
_reach_ is not), `platform_role_grants`, `staff_team_memberships`, `teams`,
`service_lines`, `status_transitions`, `notifications` (recipient-scoped, and
`organization_id` is nullable for platform notices), `audit_events` (org-tagged
but FK-free, because evidence must outlive what it describes).

### C.1 `service_role` is outside the model, and that is the point

`service_role` holds `BYPASSRLS`. No policy constrains it, so its containment is
not an authorization problem but a code-boundary problem, already solved by four
independent controls in ADR-0002: one module may read the key
(`src/server/supabase/client-service.ts`), that module is `server-only`, no
isomorphic module may import it, and a build-time scan fails the client bundle
if it appears. Phase 4 adds one rule: **every new `service_role` call site must
carry a justification comment naming the operation that necessarily exceeds the
caller's own rights**, matching the convention Phase 3 established. The
architecture test asserts the comment exists.

### C.2 Cross-tenant reads that are legitimate, and how they stay honest

Internal staff are cross-tenant by role. An admin list of "all deliverables due
this week" spans tenants by design. Three rules keep that from becoming an
accident:

1. Cross-tenant reads happen **through the user's own JWT client**, so RLS is
   still evaluated — `has_org_access()` returns true for platform staff, which
   is a policy decision, not a bypass.
2. Every response DTO carries `organizationId` explicitly. A list that mixes
   tenants must render the tenant.
3. A cross-tenant _write_ is not a thing: writes derive `organization_id` from
   the parent row, and a request may not name a tenant.

## D. Project-level access model

Specified in [§5](#5-level-4--project-membership). Restated as the deliverable:

| Question                                          | Answer                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Does project membership gate internal **reads**?  | **No.** Platform roles read every project in every tenant                                               |
| Does project membership gate internal **writes**? | **Not the verb — the object.** Five specific rules, [§5](#5-level-4--project-membership) table          |
| Does project membership gate **client** reads?    | **No.** Client reads are organization-wide within the visibility gate                                   |
| May a client user hold a project membership?      | **Yes** (schema permits `OBSERVER`/`REVIEWER`). It grants no read; it targets notifications             |
| What happens when the fifth role arrives?         | `PROJECT_MEMBER` becomes a **subject-side** gate for `TEAM_MEMBER` only — a matrix edit, not a refactor |
| Where is it enforced?                             | Service layer + one new trigger + two definer RPCs. **Not** in RLS, because it is an object rule        |

**Why this is not in RLS.** "The assignee must be a project member" is a
statement about a _referenced_ row, not about the row being written. Expressing
it as a `WITH CHECK` predicate would require a subquery against
`project_memberships` inside a policy on `tasks` — the exact shape ADR-0008
exists to avoid. It belongs in a trigger, where a cross-row invariant already
lives for six other rules.

## E. Client visibility model

**Three gates, ANDed, per resource. Default is deny.** A client sees a row only
when all three pass:

```
 GATE 1  tenant        organization_id ∈ current_org_ids()   (always)
 GATE 2  flag          client_visible = true                 (where the column exists)
 GATE 3  state         status ∈ the resource's released set  (where a workflow exists)
```

| Resource                                       | Gate 1 | Gate 2                               | Gate 3                                                         | Effective client rule                                                      |
| ---------------------------------------------- | :----: | ------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `organizations`                                |   ✅   | —                                    | —                                                              | Own organization row                                                       |
| `organization_settings`                        |   ✅   | —                                    | —                                                              | Own settings; `CLIENT_ADMIN` may write                                     |
| `engagements`                                  |   ✅   | —                                    | —                                                              | All own engagements, **minus internal-only columns**                       |
| `services`                                     |   ✅   | —                                    | —                                                              | All own services, **minus `fee`, `fee_model`**                             |
| `projects`                                     |   ✅   | `client_visible` (default **true**)  | —                                                              | Visible projects                                                           |
| `project_memberships`                          |   ✅   | inherited from project               | —                                                              | Roster of visible projects, minus `allocation_pct`                         |
| `deliverables`                                 |   ✅   | `client_visible` (default **false**) | `CLIENT_REVIEW`, `REVISION_REQUESTED`, `APPROVED`, `PUBLISHED` | **The strict gate.** See below                                             |
| `deliverable_versions`                         |   ✅   | inherited                            | inherited                                                      | History of a visible deliverable                                           |
| `tasks`                                        |   ✗    | —                                    | —                                                              | **Never.** No client policy exists on the table                            |
| `comments`                                     |   ✅   | subject must be visible              | —                                                              | Plus `is_internal = false`                                                 |
| `files`                                        |   ✅   | `client_visible` (default **false**) | `virus_scan_status = 'CLEAN'` + owner row visible              | Visible, scanned attachments of visible parents                            |
| `reports`                                      |   ✅   | `client_visible` (default **false**) | `PUBLISHED`                                                    | Published reports only                                                     |
| `report_metrics`                               |   ✅   | inherited                            | inherited                                                      | Frozen figures of published reports                                        |
| `metrics`                                      |   ✅   | —                                    | —                                                              | Own performance data, organization-wide                                    |
| `notifications`                                |  n/a   | —                                    | —                                                              | Own inbox (`recipient_user_id`)                                            |
| `audit_events`                                 |   ✗    | —                                    | —                                                              | **Never directly.** [§7.4](#f4-activity-records-are-not-a-client-resource) |
| `invitations`                                  |   ✅   | —                                    | —                                                              | `CLIENT_ADMIN` only; never `token_hash`                                    |
| `staff_team_memberships`                       |   ✗    | —                                    | —                                                              | **Never.** Internal org structure                                          |
| `platform_role_grants`                         |   ✗    | —                                    | —                                                              | **Never**                                                                  |
| `teams`, `service_lines`, `status_transitions` |  n/a   | —                                    | —                                                              | Global reference data, already readable (Phase 2)                          |

### E.1 The strict deliverable gate

```sql
-- Design sketch of the client read predicate.
client_visible
  and status in ('CLIENT_REVIEW','REVISION_REQUESTED','APPROVED','PUBLISHED')
```

Both conditions, even though the Phase 2 CHECK
`deliverables_client_states_require_visibility` already implies the first from
the second. The redundancy is the control: the CHECK guarantees
`status ∈ {client states} → client_visible`, but the converse is exactly the
dangerous direction — a `DRAFT` or `INTERNAL_REVIEW` deliverable with the flag
set true by mistake would otherwise be readable. `SUBMITTED` is deliberately
excluded: it means "handed to the account team", not "released to the client".
`CANCELLED` is excluded because a cancelled deliverable is an internal fact.

**A client never sees work in progress.** That is a product decision as much as
a security one: a half-finished deliverable is not fit to be judged, and the
inverted default on `deliverables.client_visible` says so at the schema level.

### E.2 What a client may write

Exhaustively — five things. Anything not on this list is denied to both client
roles:

1. `comments` on a visible project or deliverable, never internal, never on a
   task (already enforced by `growlith.enforce_comment_author_scope()`).
2. `files` — upload into their own tenant prefix, and update/soft-delete their
   own uploads.
3. `deliverables` — `CLIENT_ADMIN` only, and only the approve/request-revision
   transition, through an RPC.
4. `organization_settings` — `CLIENT_ADMIN` only.
5. `organization_memberships` — `CLIENT_ADMIN` only, `CLIENT_MEMBER` role only,
   through an RPC, subject to the four ceilings.
6. `notifications` — their own `read_at` / `archived_at`.

Note what this implies for the Phase 2 GRANT list: `authenticated` currently
holds `insert, update` on `comments`, `files`, `tasks`, `deliverables`,
`projects`, `notifications`, `organization_settings`. For a client role, the
write policies on `tasks` and `projects` will simply **not exist**, so the grant
is inert. `deliverables` gets a client `UPDATE` policy narrow enough to permit
nothing but the approval columns — and even that is belt-and-braces, because the
approval path is an RPC.

## F. Internal-only data

Four separation mechanisms, in order of strength. **None of them is the UI.**

### F.1 Column-level — invisible at the privilege layer

Already shipped in Phase 2 by revoking table-wide `SELECT` and re-granting the
visible columns individually, so **a column added to these tables later is
invisible to clients by default** — the safe direction to fail.

| Table         | Not granted to `authenticated`                         |
| ------------- | ------------------------------------------------------ |
| `engagements` | `contract_value`, `monthly_retainer`, `notes_internal` |
| `services`    | `fee`, `fee_model`                                     |

**Phase 4 extends the same treatment to four more places**, each of which is
commercially or operationally sensitive and currently readable:

| Table                 | To revoke                                  | Why                                                                         |
| --------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `project_memberships` | `allocation_pct`                           | Staffing economics. A client can infer day rates and effort from allocation |
| `tasks`               | (whole table — no client policy)           | `estimated_hours`, `actual_hours`, `blocked_reason` are internal by nature  |
| `invitations`         | `token_hash`, `resent_count`               | The hash is a credential derivative; never granted to any client role       |
| `profiles`            | `last_seen_at`, `phone`, `mfa_enrolled_at` | Presence and contact data of internal staff, exposed by any co-member read  |

The `profiles` case needs the same revoke-and-re-grant treatment the commercial
tables got: a client legitimately reads `full_name`, `display_name`,
`avatar_path` and `job_title` of people on their account, and nothing else.

### F.2 Row-level — the row is not returned at all

- **All of `tasks`.** No client policy is written. This is stronger than a flag,
  because there is no column anyone can flip.
- **All of `staff_team_memberships`** and **all of `platform_role_grants`**.
- **All of `audit_events`** ([§7.4](#f4-activity-records-are-not-a-client-resource)).
- `comments where is_internal = true`.
- `deliverables` below `CLIENT_REVIEW`, `reports` below `PUBLISHED`, `files`
  with `client_visible = false` or `scan_status <> 'CLEAN'`.
- Any row of another tenant, by [§C](#c-tenant-isolation-model).

### F.3 Table-level — the internal-only surface

`platform_role_grants`, `staff_team_memberships`, `teams` (write), `tasks`,
`audit_events`. Five tables on which **no client policy will exist after Phase 4
completes**, and the coverage test in [§16](#16-verification-strategy) asserts
that as a positive property rather than leaving it as an absence nobody checks.

### F.4 Activity records are not a client resource

`audit_events` carries internal actor identity, `actor_ip`, `request_id`, the
`before`/`after` JSONB diff — which contains internal-only column values by
construction — and `PERMISSION_DENIED` events that map the shape of the
authorization system itself. Projecting a safe subset with a policy would mean a
predicate over JSONB contents, which is unauditable.

**Design: clients get no policy on `audit_events`.** Where the portal needs a
"what changed on my account" feed, it is served by a `SECURITY DEFINER` RPC,
`public.client_activity_feed(p_organization_id uuid, …)`, which returns an
explicitly whitelisted projection: `occurred_at`, `entity_kind`, `entity_id`,
`action`, and a resolved display title — no actor identity, no IP, no diff, and
only for entity kinds and actions on an allowlist. A whitelist in a function
body is reviewable; a JSONB predicate in a policy is not.

## G. Client-visible data

The complement of [§F](#f-internal-only-data), stated positively so that "what
does the client actually see?" has an answer that does not require reading
twenty policies. This is the **entire** client surface after Phase 4:

| Domain                   | Visible to `CLIENT_ADMIN` and `CLIENT_MEMBER`                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account                  | Their organization row and settings; their co-members' names, job titles and avatars; their own profile in full                                                |
| Commercial               | Engagements (type, status, currency, dates, renewal date, account manager) and services (line, team, scope, status, dates, lead) — **never money**             |
| Delivery                 | Projects flagged visible: name, code, description, status, health, priority, dates, lead, team, and the roster                                                 |
| Work product             | Deliverables that are flagged visible **and** at `CLIENT_REVIEW` or beyond, with their full version/review history                                             |
| Reporting                | Published reports with their frozen figures; their organization's raw metric time series                                                                       |
| Files                    | Attachments flagged visible, scanned `CLEAN`, whose parent row is itself visible                                                                               |
| Communication            | Non-internal comments on visible projects and deliverables; their own notification inbox                                                                       |
| Reference                | Teams, service lines, and the status vocabulary (needed to render any status label)                                                                            |
| Extra for `CLIENT_ADMIN` | Their organization's pending invitations (never the token hash); the approve / request-revision action; member management limited to `CLIENT_MEMBER`; settings |

Everything else — tasks, internal comments, internal review history before
release, hours, allocations, fees, contract values, internal notes, the staff
roster, platform role grants, the audit trail, and every other tenant — is not
visible, and is not visible because **no policy returns it**, not because no
screen renders it.

## H. RLS policy strategy

### H.1 Posture

Unchanged from Phase 2 and non-negotiable: `ENABLE` **and** `FORCE` on all 38
relations, deny-by-default, `DELETE` revoked everywhere, and the migration-time
assertion that fails the apply if any table in `public` lacks either flag
(ADR-0009). Phase 4 adds policies; it does not relax the posture.

### H.2 Four policy classes, and nothing else

Every policy in the system will be an instance of one of four shapes. A policy
that is not one of these is a review failure, because the shapes are what make
the set auditable at a glance.

**Class 1 — internal-only table.** No client policy exists.

```sql
-- Design sketch.
create policy tasks_staff_all on public.tasks
  for all to authenticated
  using      (public.is_platform_admin() and public.is_active_account())
  with check (public.is_platform_admin() and public.is_active_account());
```

**Class 2 — tenant table, symmetric.** Staff see all; clients see their own
tenant. `has_org_access()` already encodes both halves.

```sql
create policy engagements_read on public.engagements
  for select to authenticated
  using (deleted_at is null and public.has_org_access(organization_id));
```

**Class 3 — tenant table with a visibility gate.** Two policies, deliberately
not one: the staff predicate and the client predicate are different rules and
must be readable as different rules.

```sql
create policy deliverables_read_staff on public.deliverables
  for select to authenticated
  using (public.is_platform_admin() and public.is_active_account());

create policy deliverables_read_client on public.deliverables
  for select to authenticated
  using (
    deleted_at is null
    and public.has_org_access(organization_id)
    and client_visible
    and status in ('CLIENT_REVIEW','REVISION_REQUESTED','APPROVED','PUBLISHED')
  );
```

PostgreSQL ORs permissive policies of the same command, so the two compose
correctly, and each is independently testable. Splitting also means a change to
the client gate cannot accidentally widen the staff gate.

**Class 4 — self-scoped.** `notifications`, own `profiles` row, own uploads.

```sql
create policy notifications_own on public.notifications
  for select to authenticated
  using (recipient_user_id = (select auth.uid()));
```

### H.3 Rules the policies must obey

1. **No policy may query a tenant table directly.** Every predicate is built
   from the `SECURITY DEFINER` helpers (ADR-0008). A subquery in a policy body
   is a review failure — it is how recursion and per-row evaluation get in.
2. **Every policy ANDs `is_active_account()`**, directly or transitively through
   `has_org_access()`. Suspending an account must revoke access at the database,
   not at the login screen.
3. **Every `SELECT` policy on a soft-deletable table ANDs `deleted_at is null`.**
   Restoring a row is a definer operation that reads it with RLS bypassed.
4. **Every `INSERT`/`UPDATE` policy has a `WITH CHECK`**, and it is not assumed
   to be the same as `USING`. An `UPDATE` policy with a `USING` that permits and
   a `WITH CHECK` that does not is how a row is edited out of the caller's own
   visibility.
5. **`auth.uid()` is wrapped as `(select auth.uid())`** so the planner treats it
   as an InitPlan evaluated once per statement rather than once per row.
6. **Policy naming is `{table}_{command}_{audience}`** — `deliverables_read_client`,
   `comments_write_staff`. The name states the audience, so an unnamed audience
   is a visible defect.
7. **One policy per (table, command, audience).** No policy does two jobs.

### H.4 Coverage plan

| Table                                          | Staff policies                     | Client policies                                      |  Class  |
| ---------------------------------------------- | ---------------------------------- | ---------------------------------------------------- | :-----: |
| `organizations`                                | select, insert, update             | select (own)                                         |   2/3   |
| `organization_settings`                        | select, update                     | select, update (`CLIENT_ADMIN`)                      |    3    |
| `profiles`                                     | select, update                     | select (co-members, narrowed), update (self)         |   3/4   |
| `platform_role_grants`                         | select (`SUPER_ADMIN`; ADMIN self) | —                                                    |    1    |
| `organization_memberships`                     | select                             | select (own tenant)                                  |    2    |
| `staff_team_memberships`                       | select, all                        | —                                                    |    1    |
| `teams`, `service_lines`, `status_transitions` | (read policy exists)               | (read policy exists)                                 | Phase 2 |
| `engagements`                                  | select, insert, update             | select (own tenant, columns narrowed)                |    2    |
| `services`                                     | select, insert, update             | select (own tenant, columns narrowed)                |    2    |
| `projects`                                     | select, insert, update             | select (visible)                                     |    3    |
| `project_memberships`                          | select, all                        | select (visible project)                             |    3    |
| `deliverables`                                 | select, insert, update             | select (strict gate), update (approval columns only) |    3    |
| `deliverable_versions`                         | select, insert                     | select (inherited)                                   |    3    |
| `tasks`                                        | all                                | **none**                                             |    1    |
| `comments`                                     | select, insert, update             | select (visible ∧ ¬internal), insert, update (own)   |    3    |
| `files`                                        | select, insert, update             | select (gate), insert (own tenant), update (own)     |    3    |
| `metrics`                                      | select, insert                     | select (own tenant)                                  |    2    |
| `reports`                                      | select, insert, update             | select (published)                                   |    3    |
| `report_metrics`                               | select, insert                     | select (inherited)                                   |    3    |
| `notifications`                                | select, update (self)              | select, update (self)                                |    4    |
| `invitations`                                  | select                             | select (`CLIENT_ADMIN`, own tenant)                  |    3    |
| `audit_events` + 14 parts                      | select                             | **none**                                             |    1    |

Estimated ≈ 60 policies. **Every partition of `audit_events` needs its own
policy** — partitions do not inherit row security when queried directly, and
PostgREST exposes `audit_events_202609` as its own resource. Phase 2's coverage
assertion caught fourteen unprotected partitions; Phase 4 must not reintroduce
the same class of hole by writing a policy only on the parent.
`ensure_audit_partition()` gains the policy alongside the flags it already sets.

### H.5 What RLS deliberately does **not** enforce

Stated so the boundary between the layers is not rediscovered by argument:

- **The capability matrix.** RLS does not know that `ADMIN` may not grant a
  platform role; the GRANT layer and the RPC do.
- **Project-membership object rules.** They are cross-row invariants → triggers
  ([§D](#d-project-level-access-model)).
- **State-machine legality.** Already a trigger reading `status_transitions`.
  Phase 4 adds the **role half**: the trigger begins consulting `allowed_roles`,
  which Phase 2 seeded and marked advisory.
- **Rate, quota and volume.** Phase 6.

### H.6 `storage.objects`

Phase 2 shipped the bucket and `can_access_storage_path()`. **Phase 4 must not
use that helper alone for reads.** It checks tenancy only, so a client with any
membership could fetch every object under their organization's prefix,
including internal working files — the flag lives on `files`, not on the path.

Design: two new helpers and four policies.

```sql
-- Design sketch. Read requires the metadata row to agree.
create or replace function public.can_read_storage_object(p_path text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select public.is_platform_admin()
      or exists (
        select 1 from public.files f
        where f.storage_path = p_path
          and f.deleted_at is null
          and f.client_visible
          and f.virus_scan_status = 'CLEAN'
          and public.has_org_access(f.organization_id)
      );
$$;
```

- `select` → `can_read_storage_object(name)`
- `insert` → `can_access_storage_path(name)` (tenant prefix; the metadata row
  does not exist yet, which is exactly why upload uses the weaker predicate and
  the object stays `PENDING` until verified)
- `update`, `delete` → staff only; clients soft-delete the metadata row, and a
  job reaps the object

**The two mechanisms must always agree**, and the pgTAP suite asserts they never
disagree: an object readable by path but not by `files` row, or vice versa, is a
failure.

## I. Server-side authorization strategy

### I.1 Where it lives

| Module                               | Tier        | Contents                                                                                    |
| ------------------------------------ | ----------- | ------------------------------------------------------------------------------------------- |
| `src/lib/domain/permissions.ts`      | isomorphic  | `ACTIONS`, `RESOURCES`, `CAPABILITIES`, the dense matrix, and the **pure** `can()` function |
| `src/server/auth/authorize.ts`       | server-only | `requireCapability()`, `requireTenant()`, `authorizeOr404()`, denial audit                  |
| `src/server/auth/context.ts`         | server-only | extended `auth_context()` payload — `teams`, `projectRoles` ([§2](#2-the-actor))            |
| `supabase/migrations/…_phase4_*.sql` | database    | policies, new helpers, new triggers, the definer RPCs                                       |

`permissions.ts` is in `src/lib` because the UI must import the same constant.
It is **pure data plus one pure function**: no I/O, no secrets, no `process.env`,
so it satisfies the isomorphic contract and the existing boundary tests without
an exception.

### I.2 The decision function

```ts
// Shape only.
function can(actor: Actor, capability: Capability, scope: ScopeInput): Decision;

type Decision =
  { allowed: true; obligations: readonly Qualifier[] } | { allowed: false; reason: DenyReason };

type DenyReason =
  | 'NO_TENANT_ACCESS' // Q1
  | 'CAPABILITY_NOT_GRANTED' // Q2/Q3
  | 'PROJECT_MEMBERSHIP_REQUIRED' // Q4
  | 'ASSURANCE_LEVEL_TOO_LOW'; // aal2 required
```

`can()` returns **obligations, not just a boolean**. That is what keeps the
guard honest about the difference between "you may attempt this" and "these rows
qualify": the handler receives `CLIENT_VISIBLE` as an obligation and must pass it
to the service layer, which encodes it as a filter — and RLS enforces it anyway.
A boolean would have made the second half invisible.

### I.3 Order of evaluation, and failure semantics

```
 1  authenticated?              → 401 UNAUTHENTICATED        (Phase 3, withRoute)
 2  account ACTIVE?             → 423 / 401 / 403            (Phase 3 status gate)
 3  aal2 where required?        → 403 MFA_REQUIRED
 4  tenant reach (Q1)           → 404 NOT_FOUND     ← never 403
 5  capability (Q2/Q3)          → 403 FORBIDDEN
 6  project qualifier (Q4)      → 403 FORBIDDEN
 7  load row through USER JWT   → RLS applies; miss → 404 NOT_FOUND
 8  state machine + obligations → 409 CONFLICT
```

**Step 4 returns 404, step 5 returns 403, and the difference matters.**
"You cannot reach this tenant" must be indistinguishable from "this does not
exist", or the API becomes a cross-tenant existence oracle (ADR-0019). "You are
in the right tenant but lack the verb" is safe to state plainly, and stating it
plainly is what makes the product usable. The rule: **403 may only be returned
once tenant reach is established.**

Everything fails closed. An unknown capability string, a role absent from the
matrix, a `null` actor, a database error resolving context — all deny. The
matrix being dense means "unknown capability" is a compile error in application
code and a deny at runtime for anything dynamic.

### I.4 Denials are audited

`audit_events.action` already has `PERMISSION_DENIED`. Every step-5 and step-6
denial writes one at `WARNING` severity with the capability, the actor, the
target entity and the `request_id` — which correlates to the Phase 1 structured
log line by the same id. Step-4 denials are logged but **not** audited as
denials, because they are indistinguishable from a typo'd id and would flood the
trail with noise that hides the real signal.

### I.5 The service-layer contract

Unchanged from Phase 1 §D and restated because Phase 4 is where it starts being
load-bearing:

1. Load the parent **through the user-JWT client**, so RLS applies.
2. Derive `organization_id` **from the parent row**, never from the request.
3. Validate the state machine, now including `allowed_roles`.
4. Write the audit event in the same transaction as the mutation.
5. Serialize through an explicit DTO mapper — never a raw row, never a spread.

Step 5 acquires a new obligation in Phase 4: **the DTO for a client audience is
a different type from the DTO for a staff audience.** ADR-0012 already noted
that column grants are invisible in the generated `database.ts`, so a
client-context read of `contract_value` type-checks and fails at runtime.
Phase 4 resolves it by exporting narrowed row types (`ClientEngagementRow`) and
having the client-facing mappers accept only those.

## J. API authorization strategy

### J.1 `withRoute` gains a required `capability` field

`RouteDefinition` already forces `method`, `summary` and `auth` to be declared,
so a route that forgets its posture does not compile. `capability` joins them
under the same rule (ADR-0013):

```ts
readonly capability: TAuth extends 'required' ? Capability | Capability[] : never;
```

Typed conditionally on `auth`, so a public route **cannot** declare a capability
and a protected route **cannot** omit one. Both mistakes become type errors
rather than review comments. An array means "all of these", not "any" — an
endpoint that publishes a report and emails it needs `report:publish` and
`notification:create`, and the permissive reading of a list is how a
partially-authorized action ships.

The check runs in `withRoute` between authentication and the handler:

```
requestId → method → validation → AUTHENTICATION → CAPABILITY → handler → envelope → log
```

Before the handler, so no privileged work happens for a denied request; after
validation, so a malformed request is rejected for the cheaper reason first and
the capability check never runs on unvalidated input.

### J.2 Tenant resolution at the route

The capability check answers Q2/Q3. Q1 needs a tenant, and the tenant comes from
one of exactly three places, in this order:

1. A path parameter that names an organization (`/portal/[orgSlug]/…`,
   `/api/v1/organizations/{id}/…`) — resolved and checked before the handler.
2. The parent row of the target, loaded through the user-JWT client. RLS
   returning nothing is a 404.
3. Nothing — for genuinely global routes (`/api/v1/notifications`,
   `/api/v1/auth/*`), which are marked `tenant: 'none'` explicitly.

`tenant` is also a required field, for the same reason `capability` is.

### J.3 Route taxonomy

| Route family                        | `auth`     | Capability                                  | Tenant source |
| ----------------------------------- | ---------- | ------------------------------------------- | ------------- |
| `/api/v1/health`                    | `public`   | —                                           | none          |
| `/api/v1/auth/**`                   | mixed      | —                                           | none          |
| `/api/v1/organizations`             | `required` | `organization:read` / `organization:create` | none / body   |
| `/api/v1/organizations/{id}/**`     | `required` | per operation                               | path          |
| `/api/v1/engagements/**`            | `required` | `engagement:*`                              | parent        |
| `/api/v1/services/**`               | `required` | `service:*`                                 | parent        |
| `/api/v1/projects/**`               | `required` | `project:*`                                 | parent        |
| `/api/v1/projects/{id}/members`     | `required` | `project:manage_members`                    | parent        |
| `/api/v1/tasks/**`                  | `required` | `task:*`                                    | parent        |
| `/api/v1/deliverables/{id}/approve` | `required` | `deliverable:approve`                       | parent        |
| `/api/v1/deliverables/{id}/publish` | `required` | `deliverable:publish`                       | parent        |
| `/api/v1/reports/{id}/publish`      | `required` | `report:publish`                            | parent        |
| `/api/v1/files/upload-url`          | `required` | `file:upload`                               | body → parent |
| `/api/v1/files/{id}/download-url`   | `required` | `file:download`                             | parent        |
| `/api/v1/comments/**`               | `required` | `comment:*`                                 | parent        |
| `/api/v1/notifications/**`          | `required` | `notification:read` / `:update`             | none (self)   |
| `/api/v1/invitations/**`            | `required` | `invitation:*`                              | body / parent |
| `/api/v1/accounts/{userId}/**`      | `required` | `user:update`                               | none          |
| `/api/v1/admin/**`                  | `required` | per operation + `aal2`                      | varies        |

The four routes that exist today (`invitations`, `accounts/*`) declare
`auth: 'required'` and no capability. **They must be updated in the same change
that adds the field**, or they will not compile — which is the intended
behaviour and the reason the field is required rather than optional.

### J.4 Contract tests

- Every file under `app/api/**/route.ts` is built with `withRoute` — already
  asserted (`tests/architecture/client-server-boundary.spec.ts` §G).
- **New:** every route with `auth: 'required'` declares a non-empty
  `capability`, and every declared capability exists in the matrix.
- **New:** no route declares a capability that no role holds — a dead capability
  is either a typo or an endpoint nobody can call.
- **New:** the 404-before-403 ordering, asserted with a fixture actor outside the
  tenant.

## K. Frontend permission-awareness

> **This section describes a usability mechanism. It is not a security control,
> and nothing in it is trusted by the server.**

### K.1 What the frontend receives

The protected layouts already resolve `AuthContext` server-side (Phase 3). Phase
4 adds a **derived, serializable capability set** computed on the server from
the same matrix:

```ts
interface PermissionSnapshot {
  readonly capabilities: readonly Capability[]; // coarse: role-level grants
  readonly organizationId: string | null; // the tenant in view
  readonly effectiveRole: Role;
}
```

Coarse by design. It answers "may this role ever do this?", never "may this user
do this to row 7?" — a per-row permission map would be a second authorization
implementation living in the browser, and the second implementation is always
the one that is wrong.

### K.2 How it is used

- `can(actor, capability)` — the **same pure function** the server guard uses,
  imported from `src/lib/domain/permissions.ts`. One matrix, two callers, no
  second copy.
- Hide or disable affordances the role cannot use: no "Approve" button for
  `CLIENT_MEMBER`, no "Grant role" for `ADMIN`.
- Render honest empty states rather than fabricated ones: a client whose
  deliverable list is empty because nothing has reached `CLIENT_REVIEW` sees
  "nothing has been shared with you yet", not "no deliverables exist".
- Do **not** branch on `userType` or on the raw role string in components. Every
  branch goes through a capability, so the matrix is the only place the rule
  exists.

### K.3 The invariants

1. **Every hidden affordance is independently denied by the API guard and by
   RLS.** The UI check is the third of three, and the only one an attacker can
   remove — by opening dev tools.
2. **A hidden affordance is not evidence of a control.** A test that asserts a
   button is hidden proves nothing about authorization; the L2 matrix test and
   the L4 pgTAP suite are the proofs.
3. **The client never receives data it may not see, hidden behind a flag.** The
   API returns only what the actor may read; there is no client-side filtering
   of a superset.
4. **A stale snapshot can only over-restrict, never over-permit.** It is derived
   from a role that the server re-resolves from PostgreSQL on the very next
   request (ADR-0011), so a revoked role produces a UI that offers an action the
   API then refuses with 403 — the safe direction.
5. **No dashboard UI is built in this phase.** Phase 9 renders it; Phase 4
   specifies the contract it must consume.

---

# Part III — Supporting decisions

## 12. Risk R-1 — the decision

**Decided: the role model stays at four roles. Risk R-1 is accepted and remains
open.** Recorded in full in [ADR-0010](adr/ADR-0010-four-roles-r1-accepted-and-open.md).

The gap is unchanged and is restated here because acceptance is only honest
while it is visible: with no non-privileged internal role, every SEO specialist,
paid-media buyer, video editor and AI-automation contractor across seven teams
and four bureaus holds cross-tenant `ADMIN`, and one compromised contractor
account exposes every client's pipeline, ROAS and deliverables.

What Phase 4 does about it, given the constraint:

1. **The matrix is data, and `TEAM_MEMBER` is a column in it.** Adding the role
   is one enum value, one matrix column, and the flip of `PROJECT_MEMBER` from
   an object-side qualifier to a subject-side gate for that column only. No
   refactor. This was already true of the schema (`staff_team_memberships`,
   `services.delivering_team`, `projects.owning_team` all exist); Phase 4 keeps
   it true of the authorization layer.
2. **The blast radius is reduced where it can be without a new role:**
   `platform_grant:read` is `SUPER_ADMIN`-only so an ADMIN cannot enumerate who
   else holds power; `user:update` on a SUPER_ADMIN account is denied to ADMIN;
   the five reopening transitions are SUPER_ADMIN-only; MFA is mandatory for
   both platform roles; and every cross-tenant read is audited.
3. **The tripwire stays armed.** `src/lib/domain/roles.ts` and
   `tests/unit/domain.spec.ts` continue to fail the build if a fifth role
   appears while R-1 is still recorded as open in the §M register.

## 13. Relationship to the state machine

`status_transitions.allowed_roles` was seeded in Phase 2 (61 rows) and marked
**advisory**. Phase 4 makes it authoritative, on both sides:

- **Application:** `deliverable:approve` and every status-changing capability
  carries the `STATE_MACHINE` qualifier; the service layer reads the transition
  row and checks `effectiveRole ∈ allowed_roles` before attempting the write.
- **Database:** `growlith.enforce_status_transition()` gains the role check,
  reading `auth_platform_role()` / `org_role_in()` — the same helpers RLS uses.

This is the one place a rule is enforced in both layers from **one stored
definition**, which is precisely why it is safe: there is a single row that both
consult, so they cannot disagree. Duplicating the _matrix_ into SQL would have
no such shared row, which is why [§0](#0-summary) forbids it.

Note what this makes true: `CLIENT_ADMIN` appears in `allowed_roles` for exactly
two transitions in the entire system —
`deliverable CLIENT_REVIEW → APPROVED` and `→ REVISION_REQUESTED`. That is the
complete set of state changes any client may cause.

## 14. `SECURITY DEFINER` RPCs — the closed set

ADR-0012 established that privilege-changing writes go through definer RPCs
because the rule is not expressible as a predicate over the new row. Phase 4
authors exactly these, and the set is **closed**: adding one requires an ADR.

| RPC                            | Caller                | Enforces                                                                                          |
| ------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------- |
| `grant_platform_role()`        | `SUPER_ADMIN`         | Role grant + CRITICAL audit + one-live-grant invariant                                            |
| `revoke_platform_role()`       | `SUPER_ADMIN`         | Revocation; a revoked grant can never be un-revoked                                               |
| `add_organization_member()`    | staff, `CLIENT_ADMIN` | The four `CLIENT_ADMIN` ceilings ([§A](#a-role-matrix))                                           |
| `update_organization_member()` | staff, `CLIENT_ADMIN` | Idem, plus no self-modification, plus last-admin protection                                       |
| `remove_organization_member()` | staff, `CLIENT_ADMIN` | Idem, plus primary-contact replacement                                                            |
| `accept_invitation()`          | invitee               | **Exists (Phase 3).** Token hash + membership + status, atomically                                |
| `approve_deliverable()`        | `CLIENT_ADMIN`, staff | Transition legality + `allowed_roles` + version row + audit, in one transaction                   |
| `submit_deliverable_review()`  | staff                 | Reviewer must be `LEAD`/`REVIEWER` on the project (rule 2)                                        |
| `publish_report()`             | staff                 | Freezes `report_metrics` from `metrics` at the instant of publication                             |
| `purge_organization()`         | `SUPER_ADMIN`         | Hard delete; writes the `HARD_DELETE` audit event **first**                                       |
| `erase_user()`                 | `SUPER_ADMIN`         | GDPR erasure; bypasses append-only triggers by definition                                         |
| `client_activity_feed()`       | client                | Whitelisted projection of `audit_events` ([§F.4](#f4-activity-records-are-not-a-client-resource)) |

Every one: `SECURITY DEFINER`, `set search_path = pg_catalog, public, pg_temp`,
re-checks the caller's authority from the database rather than trusting an
argument, and writes its audit event inside the same transaction as its
mutation.

## 15. Realtime

Supabase Realtime evaluates RLS per subscriber. Two rules, both consequences of
the design above rather than new policy:

1. **Read-only channels only.** No mutation ever originates from a Realtime
   message.
2. **A channel is never finer-grained than a policy.** Subscribing to
   `deliverables` in an organization delivers exactly the rows the `SELECT`
   policy returns — including the strict gate — so a deliverable becomes visible
   to a client at the moment it transitions to `CLIENT_REVIEW`, and not before.

## 16. Verification strategy

RLS is **never reported as validated until it has run** (ADR-0021). Phase 4 is
the phase that owes the execution.

| Level  | Suite                            | Proves                                                                                                   | Blocking |
| ------ | -------------------------------- | -------------------------------------------------------------------------------------------------------- | :------: |
| L1     | `tests/unit/domain.spec.ts`      | Vocabulary parity; the R-1 tripwire                                                                      |    ✅    |
| L2     | `tests/unit/permissions.spec.ts` | **Every** role × resource × action cell is explicit; no `undefined`; the invariants below                |    ✅    |
| L3     | `tests/contract/**`              | Every protected route declares a real capability; 404-before-403; denial audit is written                |    ✅    |
| **L4** | `supabase/tests/*.sql` (pgTAP)   | **The only real proof:** two seeded organizations × four roles × every table, rows returned and rejected |  **✅**  |
| L5     | `tests/e2e/**`                   | Client A cannot reach client B, end to end through the running stack                                     | Phase 8  |

**L2 invariants** — properties of the matrix itself, not of individual cells:

1. Every `(role, resource, action)` triple has an explicit grant. No holes.
2. No client role holds any capability on `task`, `staff_team_membership`,
   `platform_role_grant` or `activity`.
3. `CLIENT_MEMBER`'s grants are a strict subset of `CLIENT_ADMIN`'s.
4. `ADMIN`'s grants are a strict subset of `SUPER_ADMIN`'s.
5. The five SUPER_ADMIN-exclusive capabilities are exactly the list in [§A](#a-role-matrix).
6. Every capability carrying `CLIENT_VISIBLE` names a table that has a
   client-audience policy; every capability carrying `RPC_ONLY` names a table on
   which `authenticated` holds no direct write grant.
7. Every table in `src/types/database.ts` maps to exactly one resource.

**L4 obligations** — the pgTAP suite must assert, per role, per organization:

- A `CLIENT_MEMBER` of Acme sees zero rows of Globex on all 13 tenant tables.
- A `CLIENT_ADMIN` of Acme sees zero `tasks`, zero internal comments, zero
  `audit_events`, zero `staff_team_memberships`, zero `platform_role_grants`.
- A `DRAFT` deliverable with `client_visible = true` is **not** visible to a
  client (the strict gate's whole purpose).
- A `SUSPENDED` account sees zero rows on every table — the `is_active_account()`
  conjunct.
- A revoked platform grant takes effect on the next statement, with no session
  change.
- A `CLIENT_ADMIN` cannot insert an `organization_memberships` row with
  `role = 'CLIENT_ADMIN'`, by any path.
- `storage.objects` and `files` never disagree about one object.
- Every partition of `audit_events` returns zero rows to every client role.

Risk R-3 closes only when this suite runs green in CI under Docker. **Until
then, Phase 4's RLS is reported as _authored, not executed_** — the same
standard Phase 2 held itself to.

## 17. Risks introduced or carried by this design

| ID  | Risk                                                                                                 | Sev | Mitigation                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------- |
| R-1 | **Carried.** No non-privileged internal role; all staff hold cross-tenant `ADMIN`                    | 🔴  | Accepted, ADR-0010. Blast radius reduced ([§12](#12-risk-r-1--the-decision)); tripwire armed; matrix ready                |
| R-3 | **Carried.** RLS authored but not executed until pgTAP runs in CI                                    | 🔴  | [§16](#16-verification-strategy) L4 is a release gate for Phase 4, not a follow-up                                        |
| A-1 | **New.** `can_access_storage_path()` checks tenancy only — insufficient for client reads             | 🟠  | Found during this design. `can_read_storage_object()` ([§H.6](#h6-storageobjects)) joins `files`; pgTAP asserts agreement |
| A-2 | **New.** `profiles` has no column grants, so a client co-member read exposes `phone`, `last_seen_at` | 🟠  | [§F.1](#f1-column-level--invisible-at-the-privilege-layer) applies revoke-and-re-grant to `profiles`                      |
| A-3 | **New.** ~60 policies is a large surface; one wrong `USING` is invisible                             | 🟠  | Four fixed shapes ([§H.2](#h2-four-policy-classes-and-nothing-else)); naming convention; per-policy pgTAP assertion       |
| A-4 | **New.** `projectRoles` in the auth context grows with staffing                                      | 🟡  | Capped at 500 with an explicit overflow flag → per-project database check                                                 |
| A-5 | **New.** The matrix and the RLS policy set can drift — they encode different halves of one intent    | 🟠  | L2 invariant 6 binds them: a `CLIENT_VISIBLE` capability with no client policy fails the build                            |
| A-6 | **New.** `deliverables` client `UPDATE` policy must permit approval columns and nothing else         | 🟡  | Approval goes through an RPC; the policy is belt-and-braces and is column-scoped, with a pgTAP negative test              |
| A-7 | **New.** Audit volume from `PERMISSION_DENIED` events could be used to flood the trail               | 🟡  | Step-4 (tenant) denials are logged, not audited ([§I.4](#i4-denials-are-audited)); rate limiting lands in Phase 6         |

## 18. Implementation sequence

Ordered so that every step is verifiable when it lands, and nothing is
observable to a user until the layer beneath it is proven.

1. `src/lib/domain/permissions.ts` — actions, resources, the dense matrix, pure
   `can()`. **No consumers yet.**
2. `tests/unit/permissions.spec.ts` — the seven L2 invariants. Must pass before
   anything imports the matrix.
3. Extend `public.auth_context()` with `teams` and `projectRoles`; extend the
   `AuthContext` type and its Zod shape.
4. `src/server/auth/authorize.ts` — `requireCapability()`, the 404-before-403
   ordering, the denial audit.
5. `withRoute`: add the required `capability` and `tenant` fields; update the
   four existing routes in the same commit (they will not compile otherwise).
6. Migration — new predicate helpers (`current_project_ids`, `project_role_in`,
   `is_project_member`, `can_read_storage_object`, `can_write_storage_path`).
7. Migration — column grants for `profiles`, `project_memberships`,
   `invitations`.
8. Migration — the policy set, **one table per commit**, each with its pgTAP
   file. A table without its test does not land.
9. Migration — `storage.objects` policies.
10. Migration — the definer RPCs of [§14](#14-security-definer-rpcs--the-closed-set),
    plus the role half of `enforce_status_transition()` and the task-assignee
    trigger.
11. pgTAP suite green in CI under Docker → **risk R-3 closes**, and only then is
    RLS reported as executed.
12. `PermissionSnapshot` derivation for the layouts ([§K](#k-frontend-permission-awareness)).
    Consumed by Phase 9; no UI is built here.

## 19. What Phase 4 deliberately does not build

- **No policies, no matrix constant, no guard, no RPC bodies.** This phase is
  design, by instruction. A stubbed guard reads as a control while providing
  none (Rules 8 and 14).
- **No dashboard UI**, and no components. [§K](#k-frontend-permission-awareness)
  is a contract for Phase 9 to consume.
- **No fifth role.** [§12](#12-risk-r-1--the-decision).
- **No per-row permission API for the browser.** [§K.1](#k1-what-the-frontend-receives).
- **No client-side narrowing by project membership.** The schema permits it; the
  model does not use it ([§5](#5-level-4--project-membership), rule 5).
- **No attribute-based or policy-engine abstraction.** Four roles and seventeen
  resources do not justify a rules engine, and one would move the authorization
  logic out of the two places that are currently provable (Rules 15–17).
- **No rate limiting, quota or abuse control.** Phase 6.
- **No permission caching beyond the existing per-request memoisation.** A cache
  is a staleness window, and ADR-0011 exists to eliminate exactly that.
