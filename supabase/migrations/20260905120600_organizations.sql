-- Migration 06 — organizations and organization_settings
--
-- The tenant root. Every tenant-scoped row in the schema carries this table's
-- `id` in an `organization_id` column, and reaches its parent through a
-- COMPOSITE foreign key that includes it — so a cross-tenant child is a
-- constraint violation, not a bug to be caught in review.
--
-- Deliberately NO `on delete cascade` points at this table from the hierarchy.
-- Deleting an organization is a SUPER_ADMIN soft delete plus a separately
-- invoked purge; a physical cascade from the tenant root is a loaded gun
-- pointed at every client's contractual retention obligation.

create table if not exists public.organizations (
  id                       uuid primary key default gen_random_uuid(),

  -- Used in /portal/[orgSlug]. citext so uniqueness and lookup are
  -- case-insensitive without an expression index on every query.
  slug                     extensions.citext not null,
  legal_name               text              not null,
  display_name             text              not null,

  region                   public.region_code   not null,
  industry                 text,
  website_url              text,
  status                   public.org_status    not null default 'PROSPECT',
  -- The default reporting currency. Engagements may differ; services may not
  -- differ from their engagement (enforced in migration 10).
  primary_currency         public.currency_code not null,

  -- SET NULL: an organization must survive its account manager leaving.
  account_manager_user_id  uuid references public.profiles (id) on delete set null,
  onboarded_at             timestamptz,
  churned_at               timestamptz,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete restrict,
  updated_by  uuid references public.profiles (id) on delete restrict,
  deleted_at  timestamptz,
  deleted_by  uuid references public.profiles (id) on delete restrict,

  constraint organizations_slug_shape
    check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  constraint organizations_legal_name_not_blank
    check (btrim(legal_name) <> ''),
  constraint organizations_display_name_not_blank
    check (btrim(display_name) <> ''),
  constraint organizations_website_url_shape
    check (website_url is null or website_url ~* '^https?://.+'),
  constraint organizations_churned_requires_timestamp
    check (status <> 'CHURNED' or churned_at is not null),
  constraint organizations_deleted_by_requires_deleted_at
    check (deleted_by is null or deleted_at is not null)
);

comment on table public.organizations is
  'The tenant. One row per client company. Everything tenant-scoped carries '
  'this id in organization_id and reaches its parent by composite FK.';
comment on column public.organizations.slug is
  'Public identifier used in portal URLs. Unique among live rows only, so a '
  'slug is reusable after a soft delete.';

-- Partial unique: reusable after soft delete.
create unique index if not exists organizations_slug_key
  on public.organizations (slug)
  where deleted_at is null;

create index if not exists organizations_status_idx
  on public.organizations (status)
  where deleted_at is null;

create index if not exists organizations_region_idx
  on public.organizations (region)
  where deleted_at is null;

-- "My accounts" for an account manager.
create index if not exists organizations_account_manager_idx
  on public.organizations (account_manager_user_id)
  where deleted_at is null and account_manager_user_id is not null;

create index if not exists organizations_created_by_idx on public.organizations (created_by);
create index if not exists organizations_updated_by_idx on public.organizations (updated_by);
create index if not exists organizations_deleted_by_idx on public.organizations (deleted_by);

drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function growlith.set_updated_at();

drop trigger if exists organizations_soft_delete_fields on public.organizations;
create trigger organizations_soft_delete_fields
  before insert or update on public.organizations
  for each row execute function growlith.enforce_soft_delete_fields();

-- ---------------------------------------------------------------------------
-- organization_settings — 1:1 with organizations
-- ---------------------------------------------------------------------------
-- Split from `organizations` rather than adding fifteen columns to it, for one
-- concrete reason: a CLIENT_ADMIN may edit their own settings but must never
-- edit the organization's commercial record. Two tables make that a table-level
-- policy; one table would make it a column-grant matrix that has to be re-audited
-- every time a column is added.
create table if not exists public.organization_settings (
  -- Shared primary key: the 1:1 is structural, not conventional.
  organization_id uuid primary key
                    references public.organizations (id) on delete cascade,

  brand_primary_color         text,
  -- FK added in migration 15, once `files` exists.
  logo_file_id                uuid,

  default_report_cadence      public.report_cadence not null default 'MONTHLY',
  notify_on_deliverable_ready boolean not null default true,
  notify_on_report_published  boolean not null default true,
  require_approval_for_publish boolean not null default true,
  timezone                    text    not null default 'UTC',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete restrict,

  constraint organization_settings_color_shape
    check (brand_primary_color is null or brand_primary_color ~* '^#[0-9a-f]{6}$'),
  constraint organization_settings_timezone_not_blank
    check (btrim(timezone) <> '')
);

comment on table public.organization_settings is
  'Per-tenant configuration. Separate from organizations so CLIENT_ADMIN write '
  'access is a table-level policy rather than a column-grant matrix.';

create index if not exists organization_settings_updated_by_idx
  on public.organization_settings (updated_by);

drop trigger if exists organization_settings_set_updated_at on public.organization_settings;
create trigger organization_settings_set_updated_at
  before update on public.organization_settings
  for each row execute function growlith.set_updated_at();

-- Every organization has exactly one settings row from the moment it exists,
-- so no read path needs a left join or a null check.
create or replace function growlith.create_organization_settings()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  insert into public.organization_settings (organization_id)
  values (new.id)
  on conflict (organization_id) do nothing;
  return new;
end;
$$;

drop trigger if exists organizations_create_settings on public.organizations;
create trigger organizations_create_settings
  after insert on public.organizations
  for each row execute function growlith.create_organization_settings();

alter table public.organizations         enable row level security;
alter table public.organizations         force row level security;
alter table public.organization_settings enable row level security;
alter table public.organization_settings force row level security;
