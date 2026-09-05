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
