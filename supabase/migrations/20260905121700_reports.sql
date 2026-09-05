-- Migration 17 — reports and report_metrics
--
-- A report is what the client receives; `report_metrics` is the FROZEN
-- snapshot of the figures as published.
--
-- The snapshot is not redundant with `metrics`. A published report is a
-- statement made to a client on a date. If the underlying metric is later
-- corrected — a connector backfills, an attribution window changes — a
-- previously issued report must NOT silently change its numbers. So the
-- figures are copied at publication and are append-only thereafter (risk
-- D-10).

create table if not exists public.reports (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  -- Both optional: a report may cover the whole account, one engagement, or
  -- one service. SET NULL rather than CASCADE — deleting a service must not
  -- destroy a report already issued to the client.
  engagement_id uuid,
  service_id    uuid,

  title       text               not null,
  report_type public.report_type not null,

  period_start date not null,
  period_end   date not null,

  status   public.report_status not null default 'DRAFT',
  currency public.currency_code,

  -- Narrative only. Every number lives in report_metrics.
  summary_md text,

  published_at timestamptz,
  published_by uuid references public.profiles (id) on delete restrict,
  client_visible boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete restrict,
  updated_by uuid references public.profiles (id) on delete restrict,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles (id) on delete restrict,

  constraint reports_id_org_key unique (id, organization_id),

  constraint reports_engagement_fkey
    foreign key (engagement_id, organization_id)
    references public.engagements (id, organization_id)
    on update cascade on delete set null,
  constraint reports_service_fkey
    foreign key (service_id, organization_id)
    references public.services (id, organization_id)
    on update cascade on delete set null,

  constraint reports_title_not_blank check (btrim(title) <> ''),
  constraint reports_period_order check (period_end >= period_start),
  -- Published means published: visible, timestamped, attributed.
  constraint reports_published_coherent
    check (
      status <> 'PUBLISHED'
      or (published_at is not null and published_by is not null and client_visible)
    ),
  constraint reports_deleted_by_requires_deleted_at
    check (deleted_by is null or deleted_at is not null)
);

comment on table public.reports is
  'A performance report for one organization. summary_md is narrative only; '
  'figures live in report_metrics so they can be charted and compared.';

-- The portal report list: newest period first.
create index if not exists reports_org_period_idx
  on public.reports (organization_id, period_end desc)
  where deleted_at is null;

create index if not exists reports_org_visible_idx
  on public.reports (organization_id, status, client_visible)
  where deleted_at is null;

create index if not exists reports_engagement_idx
  on public.reports (engagement_id)
  where engagement_id is not null and deleted_at is null;

create index if not exists reports_service_idx
  on public.reports (service_id)
  where service_id is not null and deleted_at is null;

create index if not exists reports_published_by_idx on public.reports (published_by);
create index if not exists reports_created_by_idx   on public.reports (created_by);
create index if not exists reports_updated_by_idx   on public.reports (updated_by);
create index if not exists reports_deleted_by_idx   on public.reports (deleted_by);

drop trigger if exists reports_set_updated_at on public.reports;
create trigger reports_set_updated_at
  before update on public.reports
  for each row execute function growlith.set_updated_at();

drop trigger if exists reports_freeze_org on public.reports;
create trigger reports_freeze_org
  before update on public.reports
  for each row execute function growlith.freeze_organization_id();

drop trigger if exists reports_soft_delete_fields on public.reports;
create trigger reports_soft_delete_fields
  before insert or update on public.reports
  for each row execute function growlith.enforce_soft_delete_fields();

-- Both parents are optional, so tenancy is derived from whichever is present
-- and otherwise supplied by the caller against the direct FK.
create or replace function growlith.derive_report_organization_id()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_org uuid;
begin
  if new.service_id is not null then
    select organization_id into v_org from public.services where id = new.service_id;
  elsif new.engagement_id is not null then
    select organization_id into v_org from public.engagements where id = new.engagement_id;
  end if;

  if v_org is not null then
    if new.organization_id is not null and new.organization_id <> v_org then
      raise exception
        'reports: parent belongs to organization %, not %', v_org, new.organization_id
        using errcode = 'check_violation';
    end if;
    new.organization_id := v_org;
  end if;

  return new;
end;
$$;

drop trigger if exists reports_derive_org on public.reports;
create trigger reports_derive_org
  before insert on public.reports
  for each row execute function growlith.derive_report_organization_id();

alter table public.reports enable row level security;
alter table public.reports force row level security;

-- ===========================================================================
-- report_metrics — the frozen snapshot, append-only
-- ===========================================================================
create table if not exists public.report_metrics (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  report_id       uuid not null,

  metric_key public.metric_key  not null,
  value      numeric(18,4)      not null,
  unit       public.metric_unit not null,
  currency   public.currency_code,

  -- Prior-period figure, copied at the same moment so the delta shown to the
  -- client is reproducible.
  comparison_value numeric(18,4),
  comparison_label text,

  sort_order smallint not null default 0,

  created_at timestamptz not null default now(),

  constraint report_metrics_report_fkey
    foreign key (report_id, organization_id)
    references public.reports (id, organization_id)
    on update cascade on delete cascade,

  constraint report_metrics_currency_iff_currency_unit
    check ((unit = 'CURRENCY') = (currency is not null))
);

comment on table public.report_metrics is
  'Figures as published, frozen. Append-only: a correction to metrics must '
  'never retroactively alter a report already issued to a client.';

create unique index if not exists report_metrics_unique_key
  on public.report_metrics (report_id, metric_key);

create index if not exists report_metrics_report_order_idx
  on public.report_metrics (report_id, sort_order);

create index if not exists report_metrics_org_idx
  on public.report_metrics (organization_id);

drop trigger if exists report_metrics_derive_org on public.report_metrics;
create trigger report_metrics_derive_org
  before insert on public.report_metrics
  for each row execute function growlith.derive_organization_id('report_id', 'public.reports');

drop trigger if exists report_metrics_append_only on public.report_metrics;
create trigger report_metrics_append_only
  before update or delete on public.report_metrics
  for each row execute function growlith.reject_mutation();

alter table public.report_metrics enable row level security;
alter table public.report_metrics force row level security;

-- ---------------------------------------------------------------------------
-- Deferred FK from migration 15
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'files_report_fkey'
  ) then
    alter table public.files
      add constraint files_report_fkey
      foreign key (report_id, organization_id)
      references public.reports (id, organization_id)
      on update cascade on delete cascade;
  end if;
end
$$;
