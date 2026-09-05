-- Migration 04 — profiles
--
-- Application-side identity, 1:1 with `auth.users`. Global: a profile is a
-- person, not a tenant member. The link to an organization is
-- `organization_memberships` (migration 07) and nothing else.
--
-- Why a separate table at all: Supabase's `auth` schema is vendor-owned.
-- Adding columns to `auth.users` is unsupported and breaks on platform
-- upgrade, and `auth.users` is not exposed through PostgREST.
--
-- Why the PK equals `auth.users.id` rather than a fresh UUID: RLS predicates
-- reduce to `id = auth.uid()` with no join, and there is no second identity
-- column that could disagree with the first.
--
-- NOTE ON AUTHENTICATION: this migration models identity only. No sign-in,
-- session or invitation-acceptance logic is implemented here — that is a later
-- phase. The trigger on `auth.users` below is schema integrity, not
-- authentication: it guarantees the 1:1 invariant can never be violated by a
-- user created through any path (dashboard, API, invite).

create table if not exists public.profiles (
  -- Same value as auth.users.id. CASCADE: when the auth identity is destroyed
  -- the profile goes with it — the only hard delete permitted on a core table,
  -- and migration 21 snapshots it to the audit log first.
  id                uuid primary key
                      references auth.users (id) on delete cascade,

  email             extensions.citext not null,
  full_name         text              not null,
  display_name      text,
  avatar_path       text,
  phone             text,
  -- Four bureaus, 24/7: an ambiguous local time makes every cross-region
  -- report unreadable, so the display timezone is explicit per person.
  timezone          text              not null default 'UTC',
  locale            text              not null default 'en',

  user_type         public.user_type       not null,
  account_status    public.account_status  not null default 'INVITED',

  last_seen_at      timestamptz,
  mfa_enrolled_at   timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid,
  updated_by        uuid,
  deleted_at        timestamptz,
  deleted_by        uuid,

  -- NOT NULL rather than nullable: an invited user with no name is unusable in
  -- every list, table and mention. It is captured at invite time.
  constraint profiles_full_name_not_blank check (btrim(full_name) <> ''),
  constraint profiles_email_shape check (email like '%_@_%.__%'),
  constraint profiles_timezone_not_blank check (btrim(timezone) <> ''),
  constraint profiles_deleted_by_requires_deleted_at
    check (deleted_by is null or deleted_at is not null),

  -- Authorship never orphans: RESTRICT, and the referenced profile can only be
  -- soft-deleted anyway.
  constraint profiles_created_by_fkey foreign key (created_by)
    references public.profiles (id) on delete restrict,
  constraint profiles_updated_by_fkey foreign key (updated_by)
    references public.profiles (id) on delete restrict,
  constraint profiles_deleted_by_fkey foreign key (deleted_by)
    references public.profiles (id) on delete restrict
);

comment on table public.profiles is
  'Application identity, 1:1 with auth.users. Global, never tenant-scoped: the '
  'only entity that legitimately spans organizations, and it does so solely '
  'through organization_memberships.';
comment on column public.profiles.id is
  'Equal to auth.users.id so RLS reduces to `id = auth.uid()` with no join.';
comment on column public.profiles.account_status is
  'Platform-wide. SUSPENDED or DEACTIVATED revokes access at the database via '
  'the is_active_account() predicate every policy will AND — not at the login '
  'screen, which is bypassable.';

-- Partial unique: an address frees up once a profile is soft-deleted, so a
-- returning employee can be re-created without a migration.
create unique index if not exists profiles_email_key
  on public.profiles (email)
  where deleted_at is null;

create index if not exists profiles_account_status_idx
  on public.profiles (account_status)
  where deleted_at is null;

create index if not exists profiles_user_type_idx
  on public.profiles (user_type)
  where deleted_at is null;

create index if not exists profiles_last_seen_at_idx
  on public.profiles (last_seen_at desc nulls last)
  where deleted_at is null;

-- FK targets need indexes or every parent delete degrades into a scan.
create index if not exists profiles_created_by_idx on public.profiles (created_by);
create index if not exists profiles_updated_by_idx on public.profiles (updated_by);
create index if not exists profiles_deleted_by_idx on public.profiles (deleted_by);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function growlith.set_updated_at();

drop trigger if exists profiles_soft_delete_fields on public.profiles;
create trigger profiles_soft_delete_fields
  before insert or update on public.profiles
  for each row execute function growlith.enforce_soft_delete_fields();

-- ---------------------------------------------------------------------------
-- Deferred FKs from migration 03
-- ---------------------------------------------------------------------------
-- `teams.lead_user_id` could not be constrained before `profiles` existed.
-- SET NULL: losing a person must never delete a team.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'teams_lead_user_id_fkey'
  ) then
    alter table public.teams
      add constraint teams_lead_user_id_fkey
      foreign key (lead_user_id) references public.profiles (id)
      on delete set null;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The 1:1 invariant with auth.users
-- ---------------------------------------------------------------------------
-- A profile row is created for every auth user, whatever path created them.
-- Without this, a user could authenticate successfully and then have no
-- profile, no memberships and no role — an authenticated principal invisible
-- to every policy, which is the worst possible state.
--
-- SECURITY DEFINER because the trigger runs as the auth service role, which
-- has no rights on `public`. search_path is pinned: a mutable search_path on a
-- definer function is a genuine privilege-escalation vector.
create or replace function growlith.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  insert into public.profiles (id, email, full_name, user_type, account_status)
  values (
    new.id,
    new.email,
    -- Fall back to the local part of the address so the NOT NULL invariant
    -- holds even for a user created directly in the Supabase dashboard.
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      split_part(new.email, '@', 1)
    ),
    -- Internal staff are distinguished by an explicit claim set at invite
    -- time. Defaulting to CLIENT is the safe direction: a mis-typed internal
    -- user gets too little access, never too much.
    case
      when coalesce(new.raw_user_meta_data ->> 'user_type', '') = 'INTERNAL'
        then 'INTERNAL'::public.user_type
      else 'CLIENT'::public.user_type
    end,
    case
      when new.email_confirmed_at is not null then 'ACTIVE'::public.account_status
      else 'INVITED'::public.account_status
    end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function growlith.handle_new_auth_user() is
  'Guarantees the profiles <-> auth.users 1:1 invariant. Schema integrity, not '
  'authentication: no session, sign-in or invite-acceptance logic here.';

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function growlith.handle_new_auth_user();

alter table public.profiles enable row level security;
alter table public.profiles force row level security;
