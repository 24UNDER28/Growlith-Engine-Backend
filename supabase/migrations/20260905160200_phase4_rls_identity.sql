-- Migration 26 — Phase 4 (2/6): RLS policies for identity and access.
--
-- Every policy is one of §H.2's four shapes, named {table}_{command}_{audience}
-- (§H.3 rule 6), one per (table, command, audience) triple (rule 7). Rule 1:
-- no policy body touches a tenant table directly — predicates go through the
-- SECURITY DEFINER helpers. Rule 2: `is_active_account()` everywhere, directly
-- or transitively. Rule 3: SELECT on soft-deletable tables ANDs
-- `deleted_at is null`. Rule 4: write policies carry an explicit WITH CHECK.
-- Rule 5: `auth.uid()` appears only as `(select auth.uid())`.
--
-- These policies encode REACH CLASSES (§D, §H.5) — staff/client/self/tenant —
-- never capability-matrix rows. The matrix lives in
-- `src/lib/domain/permissions.ts`; nothing in this file may be derived from
-- it, and nothing in it may be copied into TypeScript.

-- ---------------------------------------------------------------------------
-- organizations — Class 2/3
-- ---------------------------------------------------------------------------
-- Staff read every organization (they operate the platform); a client reads
-- its own row and nothing else — Q1 in SQL. There is deliberately no
-- organization-update or delete policy for clients: legal name, region and
-- status are contractual facts (§B.1).

drop policy if exists organizations_select_staff on public.organizations;
create policy organizations_select_staff
  on public.organizations for select
  to authenticated
  using (
    public.is_active_account()
    and public.is_platform_admin()
    and deleted_at is null
  );

drop policy if exists organizations_select_client on public.organizations;
create policy organizations_select_client
  on public.organizations for select
  to authenticated
  using (
    deleted_at is null
    and public.has_org_access(id)
  );

drop policy if exists organizations_insert_staff on public.organizations;
create policy organizations_insert_staff
  on public.organizations for insert
  to authenticated
  with check (public.is_platform_admin() and public.is_active_account());

drop policy if exists organizations_update_staff on public.organizations;
create policy organizations_update_staff
  on public.organizations for update
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  )
  with check (public.is_platform_admin() and public.is_active_account());

-- no organizations_*_client write policy exists; no delete policy exists for
-- anybody (soft delete is an UPDATE; the purge is a SUPER_ADMIN definer RPC,
-- migration 30, which audits BEFORE deleting).

-- ---------------------------------------------------------------------------
-- organization_settings — Class 3
-- ---------------------------------------------------------------------------
-- E.2 row 4: organization_settings is one of exactly five client write
-- surfaces, CLIENT_ADMIN only. WITH CHECK repeats the predicate — an attacker
-- must not be able to move settings rows between tenants through a policy
-- asymmetry (rule 4).

drop policy if exists organization_settings_select_staff on public.organization_settings;
create policy organization_settings_select_staff
  on public.organization_settings for select
  to authenticated
  using (public.is_platform_admin() and public.is_active_account());

drop policy if exists organization_settings_select_client on public.organization_settings;
create policy organization_settings_select_client
  on public.organization_settings for select
  to authenticated
  using (public.has_org_access(organization_id));

drop policy if exists organization_settings_update_staff on public.organization_settings;
create policy organization_settings_update_staff
  on public.organization_settings for update
  to authenticated
  using (public.is_platform_admin() and public.is_active_account())
  with check (public.is_platform_admin() and public.is_active_account());

drop policy if exists organization_settings_update_client on public.organization_settings;
create policy organization_settings_update_client
  on public.organization_settings for update
  to authenticated
  using (
    public.is_active_account()
    and public.is_client_admin_of(organization_id)
  )
  with check (
    public.is_active_account()
    and public.is_client_admin_of(organization_id)
  );

-- ---------------------------------------------------------------------------
-- profiles — Class 3/4
-- ---------------------------------------------------------------------------
-- Self row always; co-members through shares_org_with(); staff through the
-- platform predicate. Column narrowing (phone, last_seen_at, mfa_enrolled_at
-- invisible to the role; self-edit columns in the UPDATE grant) is the GRANT
-- layer's job and was done in migration 25 — the policy answers only "which
-- rows".

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self
  on public.profiles for select
  to authenticated
  using (
    public.is_active_account()
    and id = (select auth.uid())
  );

drop policy if exists profiles_select_staff on public.profiles;
create policy profiles_select_staff
  on public.profiles for select
  to authenticated
  using (
    public.is_active_account()
    and public.is_platform_admin()
    and deleted_at is null
  );

drop policy if exists profiles_select_comembers on public.profiles;
create policy profiles_select_comembers
  on public.profiles for select
  to authenticated
  using (
    public.is_active_account()
    and deleted_at is null
    and public.shares_org_with(id)
  );

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
  on public.profiles for update
  to authenticated
  using (
    public.is_active_account()
    and id = (select auth.uid())
  )
  with check (
    public.is_active_account()
    and id = (select auth.uid())
  );

-- ---------------------------------------------------------------------------
-- platform_role_grants — Class 1, plus the universal self-row
-- ---------------------------------------------------------------------------
-- SUPER_ADMIN reads the roster of power (§B.1: `read` is `● ◦ ✗ ✗`); ADMIN and
-- anyone else read only their own grants. The table stays closed to writes at
-- the GRANT layer (migration 23 revoked it, and 25 did not re-add it) — grant
-- and revoke are definer RPCs (migration 30), so WITH-CHECK shapes are moot.

drop policy if exists platform_role_grants_select_super_admin on public.platform_role_grants;
create policy platform_role_grants_select_super_admin
  on public.platform_role_grants for select
  to authenticated
  using (public.is_super_admin() and public.is_active_account());

drop policy if exists platform_role_grants_select_self on public.platform_role_grants;
create policy platform_role_grants_select_self
  on public.platform_role_grants for select
  to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- organization_memberships — Class 2, symmetric
-- ---------------------------------------------------------------------------
-- One policy: has_org_access() already ORs the staff and own-tenant branches.
-- Writes are RPC-only (§A ceilings), so there are no membership write
-- policies AT ALL — the GRANT layer closed the table in migration 23 and
-- nothing here re-opens it.

drop policy if exists organization_memberships_select_tenant on public.organization_memberships;
create policy organization_memberships_select_tenant
  on public.organization_memberships for select
  to authenticated
  using (
    deleted_at is null
    and public.has_org_access(organization_id)
  );

-- ---------------------------------------------------------------------------
-- staff_team_memberships — Class 1
-- ---------------------------------------------------------------------------
-- "A client must not enumerate Growlith's staff by team" (§B.1). Reads and
-- writes: staff, full stop. The teams catalogue itself stays Phase 2's
-- read-everybody reference policy; this is the membership data.

drop policy if exists staff_team_memberships_select_staff on public.staff_team_memberships;
create policy staff_team_memberships_select_staff
  on public.staff_team_memberships for select
  to authenticated
  using (
    deleted_at is null
    and public.is_platform_admin()
    and public.is_active_account()
  );

drop policy if exists staff_team_memberships_insert_staff on public.staff_team_memberships;
create policy staff_team_memberships_insert_staff
  on public.staff_team_memberships for insert
  to authenticated
  with check (public.is_platform_admin() and public.is_active_account());

drop policy if exists staff_team_memberships_update_staff on public.staff_team_memberships;
create policy staff_team_memberships_update_staff
  on public.staff_team_memberships for update
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  )
  with check (public.is_platform_admin() and public.is_active_account());

-- ---------------------------------------------------------------------------
-- invitations — Class 3
-- ---------------------------------------------------------------------------
-- Staff see every invitation (they administer the flow); a CLIENT_ADMIN sees
-- their own organization's, never the token — `token_hash` and `resent_count`
-- are not granted to the role at all (migration 25), so no policy could
-- return them. Inserts and updates are the staff path; CLIENT_ADMIN issuing
-- goes through the membership-invitation definer RPC (migration 30) because
-- the four ceilings (§A) are cross-row logic no policy can hold.

drop policy if exists invitations_select_staff on public.invitations;
create policy invitations_select_staff
  on public.invitations for select
  to authenticated
  using (public.is_platform_admin() and public.is_active_account());

drop policy if exists invitations_select_client_admin on public.invitations;
create policy invitations_select_client_admin
  on public.invitations for select
  to authenticated
  using (
    public.is_active_account()
    and organization_id is not null
    and public.is_client_admin_of(organization_id)
  );

drop policy if exists invitations_insert_staff on public.invitations;
create policy invitations_insert_staff
  on public.invitations for insert
  to authenticated
  with check (public.is_platform_admin() and public.is_active_account());

drop policy if exists invitations_update_staff on public.invitations;
create policy invitations_update_staff
  on public.invitations for update
  to authenticated
  using (public.is_platform_admin() and public.is_active_account())
  with check (public.is_platform_admin() and public.is_active_account());

-- ---------------------------------------------------------------------------
-- notifications — Class 4 (both halves of §B.4)
-- ---------------------------------------------------------------------------
-- `recipient_user_id = auth.uid()` for everyone, including SUPER_ADMIN
-- ("Even SUPER_ADMIN reads only their own inbox", §B.4 note). No write policy
-- exists at all: notifications are created by definer paths, read_at and
-- archived_at are the only columns the UPDATE GRANT contains, and field
-- tampering beyond that is arithmetically impossible — a column privilege is
-- the strongest deny in the schema because no row condition can undo it.

drop policy if exists notifications_select_self on public.notifications;
create policy notifications_select_self
  on public.notifications for select
  to authenticated
  using (recipient_user_id = (select auth.uid()));

drop policy if exists notifications_update_self on public.notifications;
create policy notifications_update_self
  on public.notifications for update
  to authenticated
  using (recipient_user_id = (select auth.uid()))
  with check (recipient_user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- audit_events — Class 1, and every partition of it (H.4)
-- ---------------------------------------------------------------------------
-- Staff read the audit trail; no client policy exists on the table (§F.4: a
-- projected feed replaces it). Partitions do NOT inherit policies — this is
-- the hole Phase 2's coverage assertion caught, so the per-partition policy
-- travels with the partition factory AND gets backfilled now.

drop policy if exists audit_events_select_staff on public.audit_events;
create policy audit_events_select_staff
  on public.audit_events for select
  to authenticated
  using (public.is_platform_admin() and public.is_active_account());

create or replace function growlith.ensure_audit_partition(p_month date)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := format('audit_events_%s', to_char(v_start, 'YYYYMM'));
begin
  if to_regclass(format('public.%I', v_name)) is null then
    execute format(
      'create table public.%I partition of public.audit_events
         for values from (%L) to (%L)',
      v_name, v_start, v_end
    );
  end if;

  -- Not inherited from the parent, and required for every partition — see the
  -- note above. Unconditional so an older partition created before this rule
  -- existed is corrected on the next call.
  execute format('alter table public.%I enable row level security', v_name);
  execute format('alter table public.%I force row level security', v_name);

  -- Phase 4 addition: same reason — policies are not inherited either, and a
  -- partition without one is a tenant-visible read hole even though the
  -- parent is sealed. Dropped and recreated each call so the predicate can
  -- never drift between old and new partitions.
  execute format('drop policy if exists %I on public.%I',
    'audit_events_select_staff', v_name);
  execute format(
    'create policy %I on public.%I for select to authenticated using (
       public.is_platform_admin() and public.is_active_account()
     )',
    'audit_events_select_staff', v_name
  );

  return v_name;
end;
$$;

-- Backfill the partitions that already exist — the current window plus twelve
-- created by migration 21 AND the DEFAULT partition, which is a real read
-- surface for out-of-window rows and needs exactly the same seal (relkind
-- 'r' skips the parent, which carries its own policy above).
do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname like 'audit_events\_%'
    order by c.relname
  loop
    execute format('drop policy if exists %I on public.%I',
      'audit_events_select_staff', r.relname);
    execute format(
      'create policy %I on public.%I for select to authenticated using (
         public.is_platform_admin() and public.is_active_account()
       )',
      'audit_events_select_staff', r.relname
    );
  end loop;
end
$$;
