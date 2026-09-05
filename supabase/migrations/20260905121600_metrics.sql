-- Migration 16 — metrics
--
-- First-class time-series KPI storage. The public site's proof points —
-- pipeline engineered, blended ROAS, P75 LCP, LTV:CAC, pages indexed, CAPI
-- match rate, lead response time — mean the client dashboard's core value is
-- measurement truth. Numbers therefore live in typed rows, never as prose
-- inside a report body: text cannot be charted, compared or trusted.
--
-- No soft delete here, unlike every other tenant table. A corrected figure is
-- a new row with a later `ingested_at`, or a hard delete by the ingestion job.
-- Soft-deleting time series poisons every aggregate with a
-- `where deleted_at is null` that someone will eventually forget, and the
-- resulting chart is wrong in a way nobody notices.

create table if not exists public.metrics (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  -- Optional: some metrics are organization-wide (blended ROAS across all
  -- paid activity) rather than attributable to one purchased service.
  service_id   uuid,
  service_line public.service_line
                 references public.service_lines (code)
                 on update cascade on delete restrict,

  metric_key  public.metric_key not null,
  metric_date date              not null,

  -- Wider scale than money: ratios and rates need precision that (14,2) loses.
  value numeric(18,4)      not null,
  unit  public.metric_unit not null,
  -- Required exactly when the unit is CURRENCY. FX conversion is out of scope
  -- (risk R-13): aggregates are per currency.
  currency public.currency_code,

  source      public.metric_source not null default 'MANUAL',
  ingested_at timestamptz          not null default now(),
  -- Free-text provenance for MANUAL entries and connector run identifiers.
  source_ref  text,

  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete restrict,

  constraint metrics_service_fkey
    foreign key (service_id, organization_id)
    references public.services (id, organization_id)
    on update cascade on delete cascade,

  constraint metrics_currency_iff_currency_unit
    check ((unit = 'CURRENCY') = (currency is not null)),
  -- Percent and ratio are stored as their natural value (12.5 = 12.5%), not
  -- as a fraction; negative rates are meaningless.
  constraint metrics_non_negative_where_meaningful
    check (unit not in ('COUNT', 'PERCENT', 'MILLISECONDS', 'MINUTES') or value >= 0)
);

comment on table public.metrics is
  'Time-series KPI store. Append-oriented: corrections are new rows, not '
  'mutations, and there is deliberately no soft delete.';

-- One value per (tenant, service, key, date). Two coalesce expressions make
-- the NULL service_id case deterministic, so ingestion can upsert safely
-- instead of racing itself into duplicates.
create unique index if not exists metrics_unique_point
  on public.metrics (
    organization_id,
    coalesce(service_id, '00000000-0000-0000-0000-000000000000'::uuid),
    metric_key,
    metric_date
  );

-- THE chart query: one tenant, one key, a date range, newest first.
create index if not exists metrics_org_key_date_idx
  on public.metrics (organization_id, metric_key, metric_date desc);

create index if not exists metrics_service_date_idx
  on public.metrics (service_id, metric_date desc)
  where service_id is not null;

create index if not exists metrics_org_line_date_idx
  on public.metrics (organization_id, service_line, metric_date desc)
  where service_line is not null;

-- BRIN rather than B-tree for the bare date dimension: the table is
-- append-ordered by date and will be the largest by row count after
-- audit_events, and range scans are the only access pattern on this column
-- alone. A B-tree here would be many times the size for no gain.
create index if not exists metrics_date_brin
  on public.metrics using brin (metric_date);

create index if not exists metrics_created_by_idx on public.metrics (created_by);

-- Tenant key is derived from the service when one is given; when none is
-- given the caller supplies it and the direct FK validates it.
drop trigger if exists metrics_derive_org on public.metrics;
create trigger metrics_derive_org
  before insert on public.metrics
  for each row execute function growlith.derive_organization_id('service_id', 'public.services');

drop trigger if exists metrics_freeze_org on public.metrics;
create trigger metrics_freeze_org
  before update on public.metrics
  for each row execute function growlith.freeze_organization_id();

-- FUTURE: partition by range (metric_date) once volume justifies it. The
-- index order above already leads with the partition-friendly columns, so that
-- migration is a table rewrite and nothing else.

alter table public.metrics enable row level security;
alter table public.metrics force row level security;
