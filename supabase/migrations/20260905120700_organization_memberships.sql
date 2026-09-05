-- Migration 07 — organization_memberships, and the RLS predicate helpers
--
-- This is the single legitimate cross-organization edge in the schema, and
-- therefore the entire attack surface for tenancy. `profiles` is global,
-- everything else is tenant-scoped, and this table is the only join between
-- them.
--
-- It also has to come before any tenant table's policies, because every one of
-- those policies is written in terms of the helper functions defined at the
-- bottom of this file.

create table if not exists public.organization_memberships (
  id              uuid primary key default gen_random_uuid(),

  organization_id uuid not null
                    references public.organizations (id) on delete cascade,
  user_id         uuid not null
                    references public.profiles (id) on delete cascade,

  role            public.organization_role  not null,
  status          public.membership_status  not null default 'INVITED',

  -- At most one per organization; the person the account manager calls.
  is_primary_contact boolean not null default false,
  job_title       text,

  invited_by      uuid references public.profiles (id) on delete restrict,
  joined_at       timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete restrict,
  updated_by uuid references public.profiles (id) on delete restrict,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles (id) on delete restrict,

  -- An ACTIVE membership must record when it became active; otherwise access
  -- reviews cannot answer "since when?".
  constraint organization_memberships_active_requires_joined_at
    check (status <> 'ACTIVE' or joined_at is not null),
  constraint organization_memberships_primary_contact_must_be_active
    check (not is_primary_contact or status = 'ACTIVE'),
  constraint organization_memberships_deleted_by_requires_deleted_at
    check (deleted_by is null or deleted_at is not null)
);

comment on table public.organization_memberships is
  'Joins a profile to an organization with a client role. The ONLY legitimate '
  'cross-organization edge: every write is audited at CRITICAL severity and '
  'CLIENT_ADMIN may only ever grant CLIENT_MEMBER.';

-- One role per person per organization. Two rows would make permission
-- resolution ambiguous, and ambiguity in an authorization table resolves in
-- the attacker's favour.
create unique index if not exists organization_memberships_unique_live
  on public.organization_memberships (organization_id, user_id)
  where deleted_at is null;

-- THE hottest index in the schema: read by current_org_ids() on effectively
-- every authenticated statement.
create index if not exists organization_memberships_user_idx
  on public.organization_memberships (user_id)
  where deleted_at is null;

create index if not exists organization_memberships_org_role_idx
  on public.organization_memberships (organization_id, role)
  where deleted_at is null;

create index if not exists organization_memberships_org_status_idx
  on public.organization_memberships (organization_id, status)
  where deleted_at is null;

create unique index if not exists organization_memberships_primary_contact_key
  on public.organization_memberships (organization_id)
  where is_primary_contact and deleted_at is null;

create index if not exists organization_memberships_invited_by_idx
  on public.organization_memberships (invited_by);
create index if not exists organization_memberships_created_by_idx
  on public.organization_memberships (created_by);
create index if not exists organization_memberships_updated_by_idx
  on public.organization_memberships (updated_by);
create index if not exists organization_memberships_deleted_by_idx
  on public.organization_memberships (deleted_by);

drop trigger if exists organization_memberships_set_updated_at
  on public.organization_memberships;
create trigger organization_memberships_set_updated_at
  before update on public.organization_memberships
  for each row execute function growlith.set_updated_at();

drop trigger if exists organization_memberships_freeze_org
  on public.organization_memberships;
create trigger organization_memberships_freeze_org
  before update on public.organization_memberships
  for each row execute function growlith.freeze_organization_id();

drop trigger if exists organization_memberships_soft_delete_fields
  on public.organization_memberships;
create trigger organization_memberships_soft_delete_fields
  before insert or update on public.organization_memberships
  for each row execute function growlith.enforce_soft_delete_fields();

-- A client membership is meaningless for internal staff, who are authorized by
-- platform role instead. Allowing both would create two competing sources of
-- truth for one person's rights in one organization.
create or replace function growlith.enforce_membership_user_type()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_type public.user_type;
begin
  select user_type into v_user_type
  from public.profiles
  where id = new.user_id;

  if v_user_type is distinct from 'CLIENT'::public.user_type then
    raise exception
      'organization_memberships: user % is not a CLIENT profile; internal staff '
      'are authorized by platform_role_grants, not by client memberships',
      new.user_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists organization_memberships_user_type
  on public.organization_memberships;
create trigger organization_memberships_user_type
  before insert or update of user_id on public.organization_memberships
  for each row execute function growlith.enforce_membership_user_type();

alter table public.organization_memberships enable row level security;
alter table public.organization_memberships force row level security;

-- ===========================================================================
-- RLS predicate helpers
-- ===========================================================================
-- Defined here, with the table they read, so no later migration can attach a
-- policy before its predicate exists.
--
-- All are SECURITY DEFINER, STABLE, with a pinned search_path:
--
--   * SECURITY DEFINER breaks RLS recursion. An inline
--     `exists (select 1 from organization_memberships ...)` inside a policy ON
--     organization_memberships recurses infinitely; a definer function reads
--     the table with RLS bypassed and returns a plain value.
--   * STABLE lets the planner evaluate once per statement rather than once per
--     row — the difference between an index scan and a catastrophe on a large
--     list query.
--   * A mutable search_path on a SECURITY DEFINER function is a real hijack
--     vector and is flagged by Supabase's own linter.
--
-- Phase 4 writes the policies that USE these. Nothing here grants access:
-- until policies exist, RLS is default-deny and only service_role reads.

-- The caller's live, unexpired platform role, or null for client users.
create or replace function public.auth_platform_role()
returns public.platform_role
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select g.role
  from public.platform_role_grants g
  join public.profiles p on p.id = g.user_id
  where g.user_id = auth.uid()
    and g.revoked_at is null
    and (g.expires_at is null or g.expires_at > now())
    and p.deleted_at is null
    and p.account_status = 'ACTIVE'
  -- SUPER_ADMIN outranks ADMIN when both are held.
  order by (g.role = 'SUPER_ADMIN') desc
  limit 1;
$$;

comment on function public.auth_platform_role() is
  'Live platform role of the current user, honouring revocation, expiry and '
  'account status. Null for client users.';

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.auth_platform_role() = 'SUPER_ADMIN';
$$;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.auth_platform_role() is not null;
$$;

comment on function public.is_platform_admin() is
  'True for any internal role (SUPER_ADMIN or ADMIN). Cross-tenant by design — '
  'risk R-1: there is currently no non-privileged internal role.';

-- Suspending an account must revoke access at the database, not at the login
-- screen. Every Phase 4 policy ANDs this.
create or replace function public.is_active_account()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.account_status = 'ACTIVE'
      and p.deleted_at is null
  );
$$;

-- The organizations the caller belongs to. Backed by
-- organization_memberships_user_idx.
create or replace function public.current_org_ids()
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(m.organization_id), '{}'::uuid[])
  from public.organization_memberships m
  where m.user_id = auth.uid()
    and m.status = 'ACTIVE'
    and m.deleted_at is null;
$$;

create or replace function public.org_role_in(p_organization_id uuid)
returns public.organization_role
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select m.role
  from public.organization_memberships m
  where m.user_id = auth.uid()
    and m.organization_id = p_organization_id
    and m.status = 'ACTIVE'
    and m.deleted_at is null
  limit 1;
$$;

-- The workhorse predicate for tenant tables: platform staff see everything,
-- clients see their own organizations.
create or replace function public.has_org_access(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.is_platform_admin()
      or (
        public.is_active_account()
        and p_organization_id = any (public.current_org_ids())
      );
$$;

create or replace function public.is_client_admin_of(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.org_role_in(p_organization_id) = 'CLIENT_ADMIN';
$$;

-- Reads staff_team_memberships, created in migration 08. Defined there to keep
-- each function next to the table it depends on.
