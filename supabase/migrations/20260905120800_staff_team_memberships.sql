-- Migration 08 — staff_team_memberships
--
-- Which internal staff belong to which delivery team. Global, NOT tenant
-- scoped: a paid-media buyer serves many clients, and scoping their team
-- membership per organization would duplicate a fact that is not per-client.
--
-- This table is also the precondition for closing risk R-1. When TEAM_MEMBER
-- is approved, the policy predicate becomes "the actor is on the delivering
-- team of this service", and the data it needs already exists here.

create table if not exists public.staff_team_memberships (
  id      uuid primary key default gen_random_uuid(),

  user_id uuid        not null references public.profiles (id) on delete cascade,
  team    public.team not null references public.teams (code)
            on update cascade on delete restrict,

  is_lead boolean  not null default false,
  -- Percentage of capacity nominally allocated to this team. Nullable: not
  -- every firm tracks it, and 0 is a meaningful value distinct from unknown.
  allocation_pct smallint,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete restrict,
  updated_by uuid references public.profiles (id) on delete restrict,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles (id) on delete restrict,

  constraint staff_team_memberships_allocation_range
    check (allocation_pct is null or allocation_pct between 0 and 100),
  constraint staff_team_memberships_deleted_by_requires_deleted_at
    check (deleted_by is null or deleted_at is not null)
);

comment on table public.staff_team_memberships is
  'Internal staff to delivery team. Global. Also the data behind the future '
  'TEAM_MEMBER role (risk R-1): "is this actor on the delivering team?".';

create unique index if not exists staff_team_memberships_unique_live
  on public.staff_team_memberships (user_id, team)
  where deleted_at is null;

create index if not exists staff_team_memberships_team_idx
  on public.staff_team_memberships (team)
  where deleted_at is null;

create index if not exists staff_team_memberships_user_idx
  on public.staff_team_memberships (user_id)
  where deleted_at is null;

create index if not exists staff_team_memberships_created_by_idx
  on public.staff_team_memberships (created_by);
create index if not exists staff_team_memberships_updated_by_idx
  on public.staff_team_memberships (updated_by);
create index if not exists staff_team_memberships_deleted_by_idx
  on public.staff_team_memberships (deleted_by);

drop trigger if exists staff_team_memberships_set_updated_at
  on public.staff_team_memberships;
create trigger staff_team_memberships_set_updated_at
  before update on public.staff_team_memberships
  for each row execute function growlith.set_updated_at();

drop trigger if exists staff_team_memberships_soft_delete_fields
  on public.staff_team_memberships;
create trigger staff_team_memberships_soft_delete_fields
  before insert or update on public.staff_team_memberships
  for each row execute function growlith.enforce_soft_delete_fields();

-- Only INTERNAL profiles staff internal teams. Without this, a client user
-- could be placed on the SEO team and — once TEAM_MEMBER exists — inherit
-- cross-tenant delivery access. Closing it now costs one trigger; closing it
-- after the role ships is an incident.
create or replace function growlith.enforce_staff_user_type()
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

  if v_user_type is distinct from 'INTERNAL'::public.user_type then
    raise exception
      'staff_team_memberships: user % is not an INTERNAL profile', new.user_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists staff_team_memberships_user_type
  on public.staff_team_memberships;
create trigger staff_team_memberships_user_type
  before insert or update of user_id on public.staff_team_memberships
  for each row execute function growlith.enforce_staff_user_type();

alter table public.staff_team_memberships enable row level security;
alter table public.staff_team_memberships force row level security;

-- ---------------------------------------------------------------------------
-- Team predicate helper
-- ---------------------------------------------------------------------------
-- Not used by any policy yet — Phase 4 wires it in, and it becomes load-bearing
-- the moment TEAM_MEMBER exists. Defined here beside its table.
create or replace function public.current_team_codes()
returns public.team[]
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(s.team), '{}'::public.team[])
  from public.staff_team_memberships s
  where s.user_id = auth.uid()
    and s.deleted_at is null;
$$;

create or replace function public.is_on_team(p_team public.team)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select p_team = any (public.current_team_codes());
$$;
