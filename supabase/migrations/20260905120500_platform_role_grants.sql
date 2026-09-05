-- Migration 05 — platform_role_grants
--
-- Which internal staff hold SUPER_ADMIN / ADMIN.
--
-- Why a table and not a column on `profiles`: a grant is an EVENT, not an
-- attribute. It has a granter, a reason, an optional expiry and a revocation.
-- These are the most security-sensitive facts in the system and the first
-- thing an auditor asks about; a mutable enum column would answer "who can do
-- everything?" but never "who gave them that, when, and why?".
--
-- Rows are never deleted and never soft-deleted: `revoked_at` is the domain
-- concept, and the history is the point.

create table if not exists public.platform_role_grants (
  id          uuid primary key default gen_random_uuid(),

  user_id     uuid                 not null
                references public.profiles (id) on delete cascade,
  role        public.platform_role not null,

  -- RESTRICT: the record of who granted power must not be erasable by
  -- removing the granter.
  granted_by  uuid        not null
                references public.profiles (id) on delete restrict,
  granted_at  timestamptz not null default now(),
  reason      text        not null,

  -- Optional time-boxing, e.g. a contractor with elevated access for a sprint.
  expires_at  timestamptz,

  revoked_at  timestamptz,
  revoked_by  uuid references public.profiles (id) on delete restrict,
  revoke_reason text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint platform_role_grants_reason_not_blank
    check (btrim(reason) <> ''),
  constraint platform_role_grants_revocation_coherent
    check ((revoked_at is null) = (revoked_by is null)),
  constraint platform_role_grants_revoked_after_granted
    check (revoked_at is null or revoked_at >= granted_at),
  constraint platform_role_grants_expiry_after_granted
    check (expires_at is null or expires_at > granted_at)
);

comment on table public.platform_role_grants is
  'Grants of the global internal roles. Append-and-revoke, never deleted. '
  'Writes are SUPER_ADMIN-only through a Phase 4 SECURITY DEFINER RPC; direct '
  'INSERT is additionally revoked at the GRANT level.';
comment on column public.platform_role_grants.role is
  'RISK R-1 remains open: with only SUPER_ADMIN and ADMIN, every specialist '
  'needs cross-tenant ADMIN. Adding TEAM_MEMBER is one enum value plus policy '
  'predicates — this table needs no structural change.';

-- One live grant per (person, role). A second would make permission
-- resolution ambiguous; re-granting after revocation is a new row.
create unique index if not exists platform_role_grants_active_key
  on public.platform_role_grants (user_id, role)
  where revoked_at is null;

-- The predicate every RLS helper will run: "does this user hold a live,
-- unexpired platform role?"
create index if not exists platform_role_grants_active_user_idx
  on public.platform_role_grants (user_id)
  where revoked_at is null;

create index if not exists platform_role_grants_active_role_idx
  on public.platform_role_grants (role)
  where revoked_at is null;

-- Drives the expiry sweep.
create index if not exists platform_role_grants_expiring_idx
  on public.platform_role_grants (expires_at)
  where revoked_at is null and expires_at is not null;

create index if not exists platform_role_grants_granted_by_idx
  on public.platform_role_grants (granted_by);
create index if not exists platform_role_grants_revoked_by_idx
  on public.platform_role_grants (revoked_by);

drop trigger if exists platform_role_grants_set_updated_at on public.platform_role_grants;
create trigger platform_role_grants_set_updated_at
  before update on public.platform_role_grants
  for each row execute function growlith.set_updated_at();

-- A grant's subject, role and granter are historical fact. Only the revocation
-- fields may change after insert. Enforced by trigger because no CHECK
-- constraint can compare against the OLD row.
create or replace function growlith.freeze_platform_role_grant()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.user_id    is distinct from old.user_id
     or new.role       is distinct from old.role
     or new.granted_by is distinct from old.granted_by
     or new.granted_at is distinct from old.granted_at
     or new.reason     is distinct from old.reason
  then
    raise exception
      'platform_role_grants: only revocation fields are mutable after insert'
      using errcode = 'check_violation';
  end if;

  if old.revoked_at is not null
     and new.revoked_at is distinct from old.revoked_at
  then
    raise exception 'platform_role_grants: a revoked grant cannot be un-revoked'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists platform_role_grants_freeze on public.platform_role_grants;
create trigger platform_role_grants_freeze
  before update on public.platform_role_grants
  for each row execute function growlith.freeze_platform_role_grant();

alter table public.platform_role_grants enable row level security;
alter table public.platform_role_grants force row level security;
