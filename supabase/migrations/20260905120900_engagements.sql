-- Migration 09 — engagements
--
-- The commercial relationship: the contracting unit. An organization may hold
-- several over time (renewals, upsells), so this is 1:N from the tenant root.
--
-- First tenant-scoped table, and it establishes the pattern every later one
-- follows:
--
--   1. `organization_id` NOT NULL, denormalized from the tenant root so RLS
--      answers tenancy from one indexed column instead of a five-level join
--      (ADR-0005);
--   2. `unique (id, organization_id)` — the target of the composite FKs that
--      children point at. This index is what makes the denormalization safe;
--   3. `on delete restrict` from `organizations` — the tenant root never
--      cascades;
--   4. `freeze_organization_id` so a row can never be moved between tenants.

create table if not exists public.engagements (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null
                    references public.organizations (id) on delete restrict,

  -- Human-readable identifier, unique per organization. Humans read codes;
  -- UUIDs are for machines.
  code            text not null,
  name            text not null,

  engagement_type public.engagement_type   not null,
  status          public.engagement_status not null default 'DRAFT',

  currency        public.currency_code not null,
  -- numeric, never float: money must round the way the contract says.
  contract_value   numeric(14,2),
  monthly_retainer numeric(14,2),

  start_date   date not null,
  end_date     date,
  renewal_date date,

  account_manager_user_id uuid
    references public.profiles (id) on delete set null,
  signed_at    timestamptz,
  -- Internal commercial context. Revoked from the client role by column GRANT
  -- in migration 23 — never merely hidden by the UI.
  notes_internal text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete restrict,
  updated_by uuid references public.profiles (id) on delete restrict,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles (id) on delete restrict,

  -- The composite-FK target. Not redundant with the PK: a FK must reference a
  -- unique constraint over exactly the referenced columns.
  constraint engagements_id_org_key unique (id, organization_id),

  constraint engagements_code_shape
    check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$'),
  constraint engagements_name_not_blank check (btrim(name) <> ''),
  constraint engagements_contract_value_non_negative
    check (contract_value is null or contract_value >= 0),
  constraint engagements_monthly_retainer_non_negative
    check (monthly_retainer is null or monthly_retainer >= 0),
  constraint engagements_date_order
    check (end_date is null or end_date >= start_date),
  -- A retainer without a retainer amount cannot be invoiced or forecast.
  constraint engagements_retainer_requires_amount
    check (engagement_type <> 'RETAINER' or monthly_retainer is not null),
  -- Work must not be ACTIVE against an unsigned contract.
  constraint engagements_active_requires_signature
    check (status not in ('ACTIVE', 'COMPLETED') or signed_at is not null),
  constraint engagements_deleted_by_requires_deleted_at
    check (deleted_by is null or deleted_at is not null)
);

comment on table public.engagements is
  'A commercial relationship with one organization: retainer, project or '
  'advisory. The contracting unit. Never crosses an organization boundary.';
comment on constraint engagements_id_org_key on public.engagements is
  'Composite-FK target. Children reference (engagement_id, organization_id) so '
  'a cross-tenant child is a foreign-key violation, not a logic bug.';

-- Codes are reusable once the engagement is soft-deleted.
create unique index if not exists engagements_org_code_key
  on public.engagements (organization_id, lower(code))
  where deleted_at is null;

-- Primary list query: engagements of one organization by status.
create index if not exists engagements_org_status_idx
  on public.engagements (organization_id, status)
  where deleted_at is null;

create index if not exists engagements_org_start_date_idx
  on public.engagements (organization_id, start_date desc)
  where deleted_at is null;

-- The renewals dashboard.
create index if not exists engagements_renewal_idx
  on public.engagements (renewal_date)
  where status = 'ACTIVE' and deleted_at is null and renewal_date is not null;

create index if not exists engagements_account_manager_idx
  on public.engagements (account_manager_user_id)
  where deleted_at is null and account_manager_user_id is not null;

create index if not exists engagements_created_by_idx on public.engagements (created_by);
create index if not exists engagements_updated_by_idx on public.engagements (updated_by);
create index if not exists engagements_deleted_by_idx on public.engagements (deleted_by);

drop trigger if exists engagements_set_updated_at on public.engagements;
create trigger engagements_set_updated_at
  before update on public.engagements
  for each row execute function growlith.set_updated_at();

drop trigger if exists engagements_freeze_org on public.engagements;
create trigger engagements_freeze_org
  before update on public.engagements
  for each row execute function growlith.freeze_organization_id();

drop trigger if exists engagements_soft_delete_fields on public.engagements;
create trigger engagements_soft_delete_fields
  before insert or update on public.engagements
  for each row execute function growlith.enforce_soft_delete_fields();

alter table public.engagements enable row level security;
alter table public.engagements force row level security;
