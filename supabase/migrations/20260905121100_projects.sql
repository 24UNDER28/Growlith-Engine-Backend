-- Migration 11 — projects and project_memberships
--
-- A project is the delivery container under a service: "Site rebuild Q4".
-- Where internal work is organized.
--
-- project_memberships is the second place a person meets a tenant, and it needs
-- more care than it looks: the composite FK protects the PROJECT side (the
-- project must be in this organization) but nothing in SQL protects the PERSON
-- side. Without the trigger below, a project membership would be a way to
-- smuggle a client user of org A into a project of org B.

create table if not exists public.projects (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  service_id      uuid not null,

  code        text not null,
  name        text not null,
  description text,

  status   public.project_status not null default 'PLANNED',
  priority public.priority       not null default 'MEDIUM',
  health   public.project_health not null default 'ON_TRACK',

  lead_user_id uuid references public.profiles (id) on delete set null,
  owning_team  public.team not null
                 references public.teams (code)
                 on update cascade on delete restrict,

  start_date   date,
  target_date  date,
  completed_at timestamptz,

  -- Projects are visible to the client by default: the client is entitled to
  -- see the shape of the work they are paying for. Deliverables invert this
  -- default, because a half-finished deliverable is not fit to be judged.
  client_visible boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete restrict,
  updated_by uuid references public.profiles (id) on delete restrict,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles (id) on delete restrict,

  constraint projects_id_org_key unique (id, organization_id),

  constraint projects_service_fkey
    foreign key (service_id, organization_id)
    references public.services (id, organization_id)
    on update cascade on delete cascade,

  constraint projects_code_shape
    check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$'),
  constraint projects_name_not_blank check (btrim(name) <> ''),
  constraint projects_date_order
    check (start_date is null or target_date is null or target_date >= start_date),
  constraint projects_completed_requires_timestamp
    check (status <> 'COMPLETED' or completed_at is not null),
  constraint projects_deleted_by_requires_deleted_at
    check (deleted_by is null or deleted_at is not null)
);

comment on table public.projects is
  'Delivery container under a service. Never crosses an organization boundary: '
  'reached only through (service_id, organization_id).';

create unique index if not exists projects_org_code_key
  on public.projects (organization_id, lower(code))
  where deleted_at is null;

create index if not exists projects_org_status_idx
  on public.projects (organization_id, status)
  where deleted_at is null;

create index if not exists projects_service_idx
  on public.projects (service_id)
  where deleted_at is null;

create index if not exists projects_lead_user_idx
  on public.projects (lead_user_id)
  where deleted_at is null and lead_user_id is not null;

-- Open projects approaching their target date — the delivery dashboard.
create index if not exists projects_org_target_open_idx
  on public.projects (organization_id, target_date)
  where deleted_at is null
    and status not in ('COMPLETED', 'CANCELLED')
    and target_date is not null;

create index if not exists projects_team_status_idx
  on public.projects (owning_team, status)
  where deleted_at is null;

create index if not exists projects_created_by_idx on public.projects (created_by);
create index if not exists projects_updated_by_idx on public.projects (updated_by);
create index if not exists projects_deleted_by_idx on public.projects (deleted_by);

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function growlith.set_updated_at();

drop trigger if exists projects_derive_org on public.projects;
create trigger projects_derive_org
  before insert on public.projects
  for each row execute function growlith.derive_organization_id('service_id', 'public.services');

drop trigger if exists projects_freeze_org on public.projects;
create trigger projects_freeze_org
  before update on public.projects
  for each row execute function growlith.freeze_organization_id();

drop trigger if exists projects_soft_delete_fields on public.projects;
create trigger projects_soft_delete_fields
  before insert or update on public.projects
  for each row execute function growlith.enforce_soft_delete_fields();

drop trigger if exists projects_active_team on public.projects;
create trigger projects_active_team
  before insert or update of owning_team on public.projects
  for each row execute function growlith.enforce_active_team('owning_team');

alter table public.projects enable row level security;
alter table public.projects force row level security;

-- ===========================================================================
-- project_memberships
-- ===========================================================================
create table if not exists public.project_memberships (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id      uuid not null,

  -- RESTRICT, not CASCADE: historical staffing is evidence of who did the work
  -- and must survive a person's departure. Profiles are soft-deleted anyway.
  user_id uuid not null references public.profiles (id) on delete restrict,

  project_role   public.project_member_role not null default 'CONTRIBUTOR',
  allocation_pct smallint,

  added_by uuid references public.profiles (id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete restrict,
  updated_by uuid references public.profiles (id) on delete restrict,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles (id) on delete restrict,

  constraint project_memberships_project_fkey
    foreign key (project_id, organization_id)
    references public.projects (id, organization_id)
    on update cascade on delete cascade,

  constraint project_memberships_allocation_range
    check (allocation_pct is null or allocation_pct between 0 and 100),
  constraint project_memberships_deleted_by_requires_deleted_at
    check (deleted_by is null or deleted_at is not null)
);

comment on table public.project_memberships is
  'Who is staffed on a project. The composite FK protects the project side; '
  'the same-tenant trigger protects the person side.';

create unique index if not exists project_memberships_unique_live
  on public.project_memberships (project_id, user_id)
  where deleted_at is null;

-- "My projects".
create index if not exists project_memberships_user_idx
  on public.project_memberships (user_id)
  where deleted_at is null;

create index if not exists project_memberships_project_idx
  on public.project_memberships (project_id)
  where deleted_at is null;

create index if not exists project_memberships_org_idx
  on public.project_memberships (organization_id)
  where deleted_at is null;

-- At most one accountable lead per project.
create unique index if not exists project_memberships_single_lead_key
  on public.project_memberships (project_id)
  where project_role = 'LEAD' and deleted_at is null;

create index if not exists project_memberships_added_by_idx
  on public.project_memberships (added_by);
create index if not exists project_memberships_created_by_idx
  on public.project_memberships (created_by);
create index if not exists project_memberships_updated_by_idx
  on public.project_memberships (updated_by);
create index if not exists project_memberships_deleted_by_idx
  on public.project_memberships (deleted_by);

drop trigger if exists project_memberships_set_updated_at on public.project_memberships;
create trigger project_memberships_set_updated_at
  before update on public.project_memberships
  for each row execute function growlith.set_updated_at();

drop trigger if exists project_memberships_derive_org on public.project_memberships;
create trigger project_memberships_derive_org
  before insert on public.project_memberships
  for each row execute function growlith.derive_organization_id('project_id', 'public.projects');

drop trigger if exists project_memberships_freeze_org on public.project_memberships;
create trigger project_memberships_freeze_org
  before update on public.project_memberships
  for each row execute function growlith.freeze_organization_id();

drop trigger if exists project_memberships_soft_delete_fields on public.project_memberships;
create trigger project_memberships_soft_delete_fields
  before insert or update on public.project_memberships
  for each row execute function growlith.enforce_soft_delete_fields();

-- ---------------------------------------------------------------------------
-- The person side of the tenancy wall
-- ---------------------------------------------------------------------------
-- A project member must be either internal staff (authorized cross-tenant by
-- platform role) or a client user with a live membership in THIS organization.
-- Anything else would let project_memberships act as a back door around
-- organization_memberships.
create or replace function growlith.enforce_project_member_tenancy()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_type public.user_type;
begin
  select user_type into v_user_type
  from public.profiles
  where id = new.user_id and deleted_at is null;

  if v_user_type is null then
    raise exception 'project_memberships: profile % does not exist or is deleted',
      new.user_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_user_type = 'INTERNAL' then
    return new;
  end if;

  if not exists (
    select 1
    from public.organization_memberships m
    where m.user_id = new.user_id
      and m.organization_id = new.organization_id
      and m.status = 'ACTIVE'
      and m.deleted_at is null
  ) then
    raise exception
      'project_memberships: client user % has no active membership in '
      'organization % — cross-tenant staffing refused',
      new.user_id, new.organization_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists project_memberships_tenancy on public.project_memberships;
create trigger project_memberships_tenancy
  before insert or update of user_id, organization_id on public.project_memberships
  for each row execute function growlith.enforce_project_member_tenancy();

alter table public.project_memberships enable row level security;
alter table public.project_memberships force row level security;
