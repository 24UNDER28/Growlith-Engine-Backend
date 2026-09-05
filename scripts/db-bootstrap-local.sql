-- Local validation shim — NOT a migration, never applied to Supabase.
--
-- The migrations reference three things a bare PostgreSQL does not have but
-- every Supabase project does: `auth.users`, `auth.uid()`, and the `anon` /
-- `authenticated` / `service_role` roles. This file creates minimal
-- equivalents so the schema can be applied and inspected in a clean container
-- with nothing but PostgreSQL installed.
--
-- It deliberately does NOT implement authentication. `auth.uid()` reads a
-- session setting, which is exactly how Supabase's own local stack behaves and
-- is enough to exercise the schema. Real sessions arrive with Supabase Auth in
-- a later phase.

create schema if not exists auth;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  email_confirmed_at timestamptz,
  created_at         timestamptz not null default now()
);

-- Mirrors Supabase: reads the JWT claim, which PostgREST sets per request.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.role', true), '');
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;

-- Phase 4 addition: a storage-schema stub faithful enough for the migration
-- set's storage guard (`to_regclass('storage.objects')`) to find its subject,
-- so the SAME file creates the storage policies locally that Supabase gets,
-- and the pgTAP suite exercises them for real. Column list mirrors
-- Supabase's storage.objects where Phase 4's policies touch it
-- (bucket_id, name, owner, path_tokens); it is a test fixture, not a
-- re-implementation — no RLS bypass, no per-bucket machinery.
create schema if not exists storage;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz,
  deleted_at         timestamptz
);

create table if not exists storage.objects (
  id               uuid primary key default gen_random_uuid(),
  bucket_id        text not null references storage.buckets (id) on delete cascade,
  name             text not null,
  owner            uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_accessed_at timestamptz,
  metadata         jsonb,
  path_tokens      text[] generated always as (string_to_array(name, '/')) stored,

  constraint objects_bucket_id_name_key unique (bucket_id, name)
);

-- Same posture as every application table: RLS on, FORCED on. A storage stack
-- whose tables are bypassable by their owner is not a model of the real one.
alter table storage.buckets enable row level security;
alter table storage.buckets force row level security;
alter table storage.objects enable row level security;
alter table storage.objects force row level security;

grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
