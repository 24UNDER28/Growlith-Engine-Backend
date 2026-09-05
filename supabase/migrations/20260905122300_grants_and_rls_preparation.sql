-- Migration 23 — GRANTs, column-level privileges, RLS preparation
--
-- This migration closes the schema in a deny-by-default state and prepares the
-- ground for Phase 4's policies. It creates NO policies of its own beyond the
-- two the schema cannot function without (reference-data reads), because
-- authorization is Phase 4 and shipping half a policy set is worse than
-- shipping none: a partial set looks finished.
--
-- Understand the two independent layers:
--
--   * GRANT decides whether a role may touch a TABLE or a COLUMN at all.
--   * RLS decides which ROWS it may touch.
--
-- RLS with a table-wide GRANT and no policies means "no rows". That is the
-- correct resting state for Phase 2: `authenticated` can reach the tables, and
-- sees nothing until Phase 4 says otherwise. Nothing is silently open in the
-- meantime.

-- ---------------------------------------------------------------------------
-- Baseline: revoke everything, then grant deliberately
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    -- Unauthenticated callers have no business in any application table.
    execute 'revoke all on all tables in schema public from anon';
    execute 'revoke all on all sequences in schema public from anon';
    execute 'alter default privileges in schema public revoke all on tables from anon';
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from authenticated';

    -- Read access to every application table. Which ROWS come back is decided
    -- entirely by RLS, which currently returns none.
    execute 'grant select on all tables in schema public to authenticated';

    -- Write access only where the application will legitimately write on a
    -- user's behalf. Everything else is mediated by SECURITY DEFINER RPCs in
    -- later phases.
    execute 'grant insert, update on
               public.comments,
               public.files,
               public.tasks,
               public.deliverables,
               public.projects,
               public.notifications,
               public.organization_settings
             to authenticated';

    -- No DELETE for anyone, anywhere. Deletion is a soft-delete UPDATE; hard
    -- deletion is the SUPER_ADMIN purge RPC, which runs as definer.
    execute 'revoke delete on all tables in schema public from authenticated';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Column-level privileges: internal-only commercial data
-- ---------------------------------------------------------------------------
-- Cost, fee and internal notes must be separated by COLUMN, not hidden by UI.
-- "The client cannot see that button" is not a control; a column the role
-- cannot select is.
--
-- Implemented by revoking the table-wide SELECT and re-granting the visible
-- columns individually. Any column added to these tables later is therefore
-- INVISIBLE to clients until someone deliberately grants it — the safe
-- direction to fail.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    return;
  end if;

  revoke select on public.engagements from authenticated;
  grant select (
    id, organization_id, code, name, engagement_type, status, currency,
    start_date, end_date, renewal_date, account_manager_user_id, signed_at,
    created_at, updated_at, deleted_at
  ) on public.engagements to authenticated;

  revoke select on public.services from authenticated;
  grant select (
    id, organization_id, engagement_id, service_line, delivering_team, name,
    scope_summary, status, currency, start_date, end_date, lead_user_id,
    created_at, updated_at, deleted_at
  ) on public.services to authenticated;
end
$$;

comment on column public.engagements.contract_value is
  'INTERNAL ONLY. Not granted to `authenticated`; readable through '
  'service_role or a definer RPC for platform staff.';
comment on column public.engagements.monthly_retainer is
  'INTERNAL ONLY — see contract_value.';
comment on column public.engagements.notes_internal is
  'INTERNAL ONLY — see contract_value.';
comment on column public.services.fee is
  'INTERNAL ONLY. Not granted to `authenticated`.';
comment on column public.services.fee_model is
  'INTERNAL ONLY. Not granted to `authenticated`.';

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------
-- The RLS predicates must be callable by the roles whose policies use them.
-- The `growlith` schema stays closed: those functions are trigger bodies and
-- are never invoked directly.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function
               public.auth_platform_role(),
               public.is_super_admin(),
               public.is_platform_admin(),
               public.is_active_account(),
               public.current_org_ids(),
               public.org_role_in(uuid),
               public.has_org_access(uuid),
               public.is_client_admin_of(uuid),
               public.current_team_codes(),
               public.is_on_team(public.team),
               public.storage_path_org_id(text),
               public.can_access_storage_path(text)
             to authenticated';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The only policies created in Phase 2
-- ---------------------------------------------------------------------------
-- Reference data. These are schema integrity, not authorization: no screen can
-- render a service or a team without its label, and the rows are identical for
-- every tenant, so there is nothing to isolate. Writes remain closed — the
-- catalogue changes by migration.
drop policy if exists teams_read_authenticated on public.teams;
create policy teams_read_authenticated
  on public.teams for select
  to authenticated
  using (true);

drop policy if exists service_lines_read_authenticated on public.service_lines;
create policy service_lines_read_authenticated
  on public.service_lines for select
  to authenticated
  using (true);

drop policy if exists status_transitions_read_authenticated on public.status_transitions;
create policy status_transitions_read_authenticated
  on public.status_transitions for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- RLS coverage assertion
-- ---------------------------------------------------------------------------
-- A table in `public` without RLS is a tenant-isolation hole, and the cost of
-- finding one in production is total. This fails the migration instead.
do $$
declare
  v_missing text[];
begin
  select coalesce(array_agg(c.relname order by c.relname), '{}')
    into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and not c.relrowsecurity;

  if array_length(v_missing, 1) > 0 then
    raise exception
      'RLS is not enabled on: %. Every table in `public` must enable and force '
      'row level security in the migration that creates it.',
      array_to_string(v_missing, ', ');
  end if;
end
$$;

-- Same for FORCE: without it, the table owner (which migrations and some
-- Supabase internals run as) silently bypasses every policy.
do $$
declare
  v_missing text[];
begin
  select coalesce(array_agg(c.relname order by c.relname), '{}')
    into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and c.relrowsecurity
    and not c.relforcerowsecurity;

  if array_length(v_missing, 1) > 0 then
    raise exception 'RLS is enabled but not FORCED on: %',
      array_to_string(v_missing, ', ');
  end if;
end
$$;
