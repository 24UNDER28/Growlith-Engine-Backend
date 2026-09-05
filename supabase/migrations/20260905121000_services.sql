-- Migration 10 — services
--
-- A purchased INSTANCE of a service line under one engagement — scope, fee,
-- dates, status, delivering team. Distinct from `service_lines`, which is the
-- catalogue (ADR-0006).
--
-- First table to use a composite foreign key. Note what it buys: the FK is
-- `(engagement_id, organization_id) -> engagements (id, organization_id)`, so
-- a service can only ever belong to an engagement in the SAME tenant. There is
-- no application code path — correct, buggy or malicious — that can produce a
-- cross-tenant service.

create table if not exists public.services (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  engagement_id   uuid not null,

  service_line    public.service_line not null
                    references public.service_lines (code)
                    on update cascade on delete restrict,
  -- Defaults from service_lines.default_team via trigger, and is overridable:
  -- a Web Core engagement may later be delivered jointly by WEB_DEVELOPMENT
  -- and SEO.
  delivering_team public.team not null
                    references public.teams (code)
                    on update cascade on delete restrict,

  name          text not null,
  scope_summary text,
  status        public.service_status not null default 'PLANNED',

  currency  public.currency_code not null,
  fee       numeric(14,2),
  fee_model public.fee_model not null default 'RETAINER',

  start_date date not null,
  end_date   date,

  lead_user_id uuid references public.profiles (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete restrict,
  updated_by uuid references public.profiles (id) on delete restrict,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles (id) on delete restrict,

  constraint services_id_org_key unique (id, organization_id),

  -- THE tenancy wall. CASCADE is safe here and everywhere below it because the
  -- cascade can only ever run within one tenant.
  constraint services_engagement_fkey
    foreign key (engagement_id, organization_id)
    references public.engagements (id, organization_id)
    on update cascade on delete cascade,

  constraint services_name_not_blank check (btrim(name) <> ''),
  constraint services_fee_non_negative check (fee is null or fee >= 0),
  constraint services_date_order check (end_date is null or end_date >= start_date),
  constraint services_deleted_by_requires_deleted_at
    check (deleted_by is null or deleted_at is not null)
);

comment on table public.services is
  'A purchased instance of a service line under one engagement. The catalogue '
  'lives in service_lines; this is what one client actually bought.';
comment on column public.services.delivering_team is
  'Defaults from service_lines.default_team but is overridable — the 1:1 '
  'mapping is a default, not an identity (ADR-0006).';

create index if not exists services_org_status_idx
  on public.services (organization_id, status)
  where deleted_at is null;

create index if not exists services_engagement_idx
  on public.services (engagement_id)
  where deleted_at is null;

-- Team workload view, and the future TEAM_MEMBER RLS predicate.
create index if not exists services_team_status_idx
  on public.services (delivering_team, status)
  where deleted_at is null;

create index if not exists services_service_line_idx
  on public.services (service_line)
  where deleted_at is null;

create index if not exists services_lead_user_idx
  on public.services (lead_user_id)
  where deleted_at is null and lead_user_id is not null;

create index if not exists services_created_by_idx on public.services (created_by);
create index if not exists services_updated_by_idx on public.services (updated_by);
create index if not exists services_deleted_by_idx on public.services (deleted_by);

drop trigger if exists services_set_updated_at on public.services;
create trigger services_set_updated_at
  before update on public.services
  for each row execute function growlith.set_updated_at();

-- organization_id is derived from the parent engagement, never accepted from
-- the client, then frozen.
drop trigger if exists services_derive_org on public.services;
create trigger services_derive_org
  before insert on public.services
  for each row execute function growlith.derive_organization_id('engagement_id', 'public.engagements');

drop trigger if exists services_freeze_org on public.services;
create trigger services_freeze_org
  before update on public.services
  for each row execute function growlith.freeze_organization_id();

drop trigger if exists services_soft_delete_fields on public.services;
create trigger services_soft_delete_fields
  before insert or update on public.services
  for each row execute function growlith.enforce_soft_delete_fields();

-- ---------------------------------------------------------------------------
-- Default the delivering team from the catalogue
-- ---------------------------------------------------------------------------
-- A trigger rather than a column DEFAULT, because the value depends on another
-- column of the same row, which SQL defaults cannot express.
create or replace function growlith.default_service_delivering_team()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.delivering_team is null then
    select default_team into new.delivering_team
    from public.service_lines
    where code = new.service_line;
  end if;
  return new;
end;
$$;

drop trigger if exists services_00_default_team on public.services;
create trigger services_00_default_team
  before insert on public.services
  for each row execute function growlith.default_service_delivering_team();

-- ---------------------------------------------------------------------------
-- Currency coherence with the parent engagement
-- ---------------------------------------------------------------------------
-- Risk D-3. Mixed currencies inside one engagement silently corrupt every
-- rollup, and there is no FX table to reconcile them (R-13: conversion is out
-- of scope). A FK cannot express "equal to a column of the parent row", so
-- this is a trigger.
create or replace function growlith.enforce_service_currency()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_engagement_currency public.currency_code;
begin
  select currency into v_engagement_currency
  from public.engagements
  where id = new.engagement_id;

  if new.currency is distinct from v_engagement_currency then
    raise exception
      'services.currency (%) must match engagement currency (%)',
      new.currency, v_engagement_currency
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists services_currency_matches_engagement on public.services;
create trigger services_currency_matches_engagement
  before insert or update of currency, engagement_id on public.services
  for each row execute function growlith.enforce_service_currency();

-- The delivering team must be an active team. RESTRICT on the FK stops
-- deletion; this stops assignment to a deactivated team.
create or replace function growlith.enforce_active_team()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_active boolean;
  v_team   public.team;
begin
  execute format('select ($1).%I', tg_argv[0]) into v_team using new;

  if v_team is null then
    return new;
  end if;

  select is_active into v_active from public.teams where code = v_team;

  if not coalesce(v_active, false) then
    raise exception 'team % is not active and cannot be assigned work', v_team
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists services_active_team on public.services;
create trigger services_active_team
  before insert or update of delivering_team on public.services
  for each row execute function growlith.enforce_active_team('delivering_team');

alter table public.services enable row level security;
alter table public.services force row level security;
