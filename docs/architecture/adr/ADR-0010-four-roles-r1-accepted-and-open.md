# ADR-0010: The Role Model Stays At Four Roles; Risk R-1 Is Accepted And Remains Open

**Status:** Accepted
**Phase:** 4
**Supersedes the registered proposal** of the same number ("Roles are data, so a
fifth internal role (`TEAM_MEMBER`) is a configuration change — awaiting owner
decision"). The decision the register was waiting for has been taken: **do not
add the role in Phase 4.** The proposal's _premise_ — that roles are data and a
fifth role is configuration — is confirmed and is now a design obligation.

## Context

Phase 1 raised risk R-1 and refused to close it silently. Phase 2 encoded the
refusal into the schema (`platform_role` has two values, with a comment naming
the gap), and Phase 3 left it untouched. `docs/architecture/domain-model.md`
states that "Phase 4 must not ship without an explicit decision", and
`tests/unit/domain.spec.ts` enforces that by failing the build if a fifth role
appears while R-1 is still recorded as open in the §M risk register.

The gap itself:

> `SUPER_ADMIN` and `ADMIN` are both cross-tenant. There is no vocabulary for
> "internal staff limited to their own team and their own assigned work". Every
> SEO specialist, paid-media buyer, video editor and AI-automation contractor
> across seven teams and four bureaus must therefore hold cross-tenant `ADMIN`
> simply to do their job. One compromised contractor account exposes every
> client's pipeline, ROAS and deliverables.

For a firm whose proposition is _"first-party data, you own the stack"_ and
which publishes a data-processing agreement, this is the most serious
architectural risk in the brief. Nothing about that assessment has changed.

The Phase 4 brief specifies exactly four roles. Adding a fifth would be
inventing scope, and it would be doing so in the one area where inventing scope
is most expensive: a role is a permanent part of the data model, it appears in a
PostgreSQL enum (where values can be added but never removed), and every policy
and matrix cell written against it becomes migration debt if the owner later
wants different semantics.

## Decision

**Four roles: `SUPER_ADMIN`, `ADMIN`, `CLIENT_ADMIN`, `CLIENT_MEMBER`. Risk R-1
is accepted and stays open in the register. The tripwire stays armed.**

Three obligations follow, and all three are discharged by the Phase 4 design:

### 1. The authorization layer must keep the fifth role cheap

`TEAM_MEMBER` must remain a configuration change, not a refactor. Concretely,
adding it later is:

- one `alter type public.platform_role add value 'TEAM_MEMBER'`;
- one column in the matrix constant in `src/lib/domain/permissions.ts`;
- flipping the existing `PROJECT_MEMBER` qualifier from an **object-side**
  qualifier to a **subject-side** gate, for that column only;
- one additional predicate in the Class 1 and Class 2 policy bodies —
  `is_on_team(delivering_team)` — using `current_team_codes()` and
  `is_on_team()`, which Phase 2 already created and granted for exactly this
  purpose;
- updating the tripwire test and the §M register in the same change.

No table changes. `staff_team_memberships`, `services.delivering_team`,
`projects.owning_team`, `tasks.assigned_team` and `project_memberships` all
already exist and carry the facts the role would need. This is why the matrix is
authored as dense data with an explicit cell per triple rather than as
role-hierarchy inheritance: inheritance would make the new role's semantics an
exception to a rule instead of a column in a table.

### 2. The blast radius must be reduced wherever it can be without a new role

The design does five things that are only worth doing _because_ R-1 is open:

| Control                                                                    | Effect                                                                 |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `platform_grant:read` is `SUPER_ADMIN`-only; ADMIN sees only its own grant | An ADMIN cannot enumerate who else holds power — no target list        |
| `user:update` on a `SUPER_ADMIN` account is denied to `ADMIN`              | An ADMIN cannot suspend or alter the accounts that could revoke them   |
| The five reopening transitions are `SUPER_ADMIN`-only                      | Un-publishing something a client has seen is not an ADMIN-level edit   |
| MFA (`aal2`) is mandatory for both platform roles                          | Raises the cost of the credential compromise this risk is about        |
| Every cross-tenant read is audited; denials are audited at `WARNING`       | The exposure is at least _detectable_, which it otherwise would not be |

None of these closes R-1. Together they mean a compromised `ADMIN` account
cannot quietly escalate to `SUPER_ADMIN`, cannot disable the accounts that could
stop it, and cannot act without leaving a trail.

### 3. The acceptance must stay visible

An accepted risk that stops being visible has been forgotten, not accepted.
Three mechanisms keep it visible, and all three must survive Phase 4:

- the R-1 row in `docs/architecture/README.md` §M, still marked
  **"Owner decision required"**;
- the doc comment on `ROLES` in `src/lib/domain/roles.ts`;
- the tripwire in `tests/unit/domain.spec.ts`, which fails in **both**
  directions — adding a fifth role without updating the register, or closing the
  register entry without adding the role.

## Consequences

**Positive**

- Phase 4 delivers exactly the specified scope. No role is invented, and no
  irreversible enum value is added on the designer's authority.
- The gap remains a decision the owner can take with full information, rather
  than one that was quietly made for them.
- The permission layer is provably ready: the matrix's shape, the
  `PROJECT_MEMBER` qualifier and the Phase 2 team helpers exist specifically so
  the change is small when it comes.

**Negative / accepted costs**

- **The risk is real and is not mitigated, only reduced.** Every internal
  specialist holds cross-tenant `ADMIN`. A compromised contractor account still
  reads every client's data. This is the accepted cost, stated plainly.
- Least privilege is not achieved for internal staff. The design compensates
  with detection (audit) rather than prevention, and detection is strictly
  weaker.
- Project membership cannot serve as a least-privilege mechanism for internal
  reads. With only cross-tenant roles available, gating internal reads on
  project membership would require staffing every ADMIN onto every project,
  whose predictable outcome is a blanket auto-staffing script — a control that
  exists on paper and not in fact. So membership is an object-side qualifier
  (five specific write rules) rather than a subject-side gate. That trade-off is
  a direct consequence of this ADR and is documented in `authorization.md` §5
  and §D.

**Recommendation to the owner, unchanged from Phase 1 and now costed:** add
`TEAM_MEMBER` — internal, non-cross-tenant, authorized only for entities whose
delivering team matches one of the actor's `staff_team_memberships`, or whose
task is assigned to them. On the Phase 4 design as specified, the change is one
enum value, one matrix column, one qualifier flip and one policy predicate. It
does not get cheaper by waiting, and the exposure compounds with every client
onboarded.
