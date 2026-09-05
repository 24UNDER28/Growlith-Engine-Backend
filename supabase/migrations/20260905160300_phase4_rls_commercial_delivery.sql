-- Migration 27 — Phase 4 (3/6): RLS policies for the commercial hierarchy and
-- delivery. Same four shapes, same rules (§H.2–§H.3); see migration 26's
-- header for the reading contract.

-- ---------------------------------------------------------------------------
-- engagements — Class 2, symmetric
-- ---------------------------------------------------------------------------
-- One symmetric read: has_org_access() ORs the staff-all and own-tenant
-- branches. The client-visibility here is COLUMN-LEVEL (§E: "all own
-- engagements, minus internal-only columns") and was handled by the GRANT
-- layer in migration 23 — contract_value, monthly_retainer, notes_internal
-- are simply not select-privileges of the role, no matter what this policy
-- returns.

drop policy if exists engagements_select_tenant on public.engagements;
create policy engagements_select_tenant
  on public.engagements for select
  to authenticated
  using (
    deleted_at is null
    and public.has_org_access(organization_id)
  );

drop policy if exists engagements_insert_staff on public.engagements;
create policy engagements_insert_staff
  on public.engagements for insert
  to authenticated
  with check (public.is_platform_admin() and public.is_active_account());

drop policy if exists engagements_update_staff on public.engagements;
create policy engagements_update_staff
  on public.engagements for update
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  )
  with check (public.is_platform_admin() and public.is_active_account());

-- ---------------------------------------------------------------------------
-- services — Class 2, symmetric
-- ---------------------------------------------------------------------------

drop policy if exists services_select_tenant on public.services;
create policy services_select_tenant
  on public.services for select
  to authenticated
  using (
    deleted_at is null
    and public.has_org_access(organization_id)
  );

drop policy if exists services_insert_staff on public.services;
create policy services_insert_staff
  on public.services for insert
  to authenticated
  with check (public.is_platform_admin() and public.is_active_account());

drop policy if exists services_update_staff on public.services;
create policy services_update_staff
  on public.services for update
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  )
  with check (public.is_platform_admin() and public.is_active_account());

-- ---------------------------------------------------------------------------
-- projects — Class 3
-- ---------------------------------------------------------------------------
-- The client read gate is `client_visible` alone (default TRUE — the client
-- sees the shape of the work, §B.3) ANDED with tenancy through the same
-- has_org_access() that guards every other row.

drop policy if exists projects_select_staff on public.projects;
create policy projects_select_staff
  on public.projects for select
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  );

drop policy if exists projects_select_client on public.projects;
create policy projects_select_client
  on public.projects for select
  to authenticated
  using (
    deleted_at is null
    and client_visible
    and public.has_org_access(organization_id)
  );

drop policy if exists projects_insert_staff on public.projects;
create policy projects_insert_staff
  on public.projects for insert
  to authenticated
  with check (public.is_platform_admin() and public.is_active_account());

drop policy if exists projects_update_staff on public.projects;
create policy projects_update_staff
  on public.projects for update
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  )
  with check (public.is_platform_admin() and public.is_active_account());

-- ---------------------------------------------------------------------------
-- project_memberships — Class 3
-- ---------------------------------------------------------------------------
-- Reads: staff tenant-wide; clients the ROSTER OF VISIBLE PROJECTS (§E —
-- inherited visibility, via the parent gate helper, never a re-expression).
-- allocation_pct is invisible at the GRANT layer (migration 25). Writes are
-- staff-shaped at the policy layer because the [P] qualifier is a STATEMENT
-- about the actor, not the row — RLS does not enforce it (§H.5); the service
-- layer consults project_role_in() and, for the overflow case, the database.

drop policy if exists project_memberships_select_staff on public.project_memberships;
create policy project_memberships_select_staff
  on public.project_memberships for select
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  );

drop policy if exists project_memberships_select_client on public.project_memberships;
create policy project_memberships_select_client
  on public.project_memberships for select
  to authenticated
  using (
    deleted_at is null
    and public.project_is_client_visible(project_id)
  );

drop policy if exists project_memberships_insert_staff on public.project_memberships;
create policy project_memberships_insert_staff
  on public.project_memberships for insert
  to authenticated
  with check (public.is_platform_admin() and public.is_active_account());

drop policy if exists project_memberships_update_staff on public.project_memberships;
create policy project_memberships_update_staff
  on public.project_memberships for update
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  )
  with check (public.is_platform_admin() and public.is_active_account());

-- ---------------------------------------------------------------------------
-- tasks — Class 1, internal-only
-- ---------------------------------------------------------------------------
-- The single most deliberate absence in the policy set: tasks have NO client
-- policy. An ADMIN task list containing "prep the client call about the
-- client's complaint" is not a visibility flag problem — the table is simply
-- not part of the client's world (§B.3, §F). The Phase 2 GRANT that lets the
-- `authenticated` ROLE insert/update tasks (migration 23) is inert for a
-- client human: with no matching WITH CHECK policy, the write fails. This is
-- the two-layer design working as intended — the GRANT is coarse (role), the
-- policy is coarse (audience class), and the precision that matters lives in
-- the matrix on the other side of the service boundary.

drop policy if exists tasks_select_staff on public.tasks;
create policy tasks_select_staff
  on public.tasks for select
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  );

drop policy if exists tasks_insert_staff on public.tasks;
create policy tasks_insert_staff
  on public.tasks for insert
  to authenticated
  with check (public.is_platform_admin() and public.is_active_account());

drop policy if exists tasks_update_staff on public.tasks;
create policy tasks_update_staff
  on public.tasks for update
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  )
  with check (public.is_platform_admin() and public.is_active_account());

-- ---------------------------------------------------------------------------
-- deliverables — Class 3, the strict gate
-- ---------------------------------------------------------------------------
-- The client read predicate is E.1 verbatim — flag AND status, both, even
-- though the CHECK makes one imply the other. The UPDATE policy for
-- CLIENT_ADMIN exists ONLY to make the approval path expressible at all; the
-- transition itself is gated by (a) growlith.enforce_status_transition()
-- reading allowed_roles, (b) growlith.enforce_deliverable_client_columns()
-- (migration 29) locking every column except the approval set, and (c) the
-- sanctioned path being the definer RPC of migration 31 in the first place.
-- Three independent mechanisms guarding one verb is the point: the RPC is the
-- door, the trigger is the lock, the policy is the frame.

drop policy if exists deliverables_select_staff on public.deliverables;
create policy deliverables_select_staff
  on public.deliverables for select
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  );

drop policy if exists deliverables_select_client on public.deliverables;
create policy deliverables_select_client
  on public.deliverables for select
  to authenticated
  using (
    deleted_at is null
    and public.has_org_access(organization_id)
    and client_visible
    and status in ('CLIENT_REVIEW', 'REVISION_REQUESTED', 'APPROVED', 'PUBLISHED')
  );

drop policy if exists deliverables_insert_staff on public.deliverables;
create policy deliverables_insert_staff
  on public.deliverables for insert
  to authenticated
  with check (public.is_platform_admin() and public.is_active_account());

drop policy if exists deliverables_update_staff on public.deliverables;
create policy deliverables_update_staff
  on public.deliverables for update
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  )
  with check (public.is_platform_admin() and public.is_active_account());

drop policy if exists deliverables_update_client on public.deliverables;
create policy deliverables_update_client
  on public.deliverables for update
  to authenticated
  using (
    public.is_active_account()
    and public.is_client_admin_of(organization_id)
    and deleted_at is null
    and client_visible
    and status = 'CLIENT_REVIEW'
  )
  with check (
    public.is_active_account()
    and public.is_client_admin_of(organization_id)
  );

-- ---------------------------------------------------------------------------
-- deliverable_versions — Class 3, inherited visibility
-- ---------------------------------------------------------------------------
-- "History of a visible deliverable" (§E). There is deliberately NO update or
-- delete policy anywhere: a version row is immutable (the reject_mutation
-- trigger enforces it for every role including definer callers — migration 29
-- touches nothing here), so the only write policy that could exist is INSERT.

drop policy if exists deliverable_versions_select_staff on public.deliverable_versions;
create policy deliverable_versions_select_staff
  on public.deliverable_versions for select
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
  );

drop policy if exists deliverable_versions_select_client on public.deliverable_versions;
create policy deliverable_versions_select_client
  on public.deliverable_versions for select
  to authenticated
  using (public.deliverable_is_client_visible(deliverable_id));

drop policy if exists deliverable_versions_insert_staff on public.deliverable_versions;
create policy deliverable_versions_insert_staff
  on public.deliverable_versions for insert
  to authenticated
  with check (
    public.is_platform_admin()
    and public.is_active_account()
    and public.has_org_access(organization_id)
  );
