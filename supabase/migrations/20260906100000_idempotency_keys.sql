-- Migration 32 — Phase 5: idempotency_keys (ADR-0028).
--
-- Not tenant-scoped. The replay identity is (actor, route, key): two different
-- callers may reuse a key, and one caller may reuse a key on a different
-- route, without colliding. FORCE RLS with no SELECT policy means
-- `authenticated` cannot read another actor's stored responses even if a
-- future GRANT is added by mistake. Writes go through `service_role` only.

create table if not exists public.idempotency_keys (
  actor_user_id    uuid        not null,
  route            text        not null,
  key              text        not null,
  request_hash     text        not null,
  status_code      smallint    not null,
  response_body    jsonb       not null,
  response_headers jsonb       not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),

  primary key (actor_user_id, route, key),

  constraint idempotency_keys_route_not_blank
    check (btrim(route) <> ''),
  constraint idempotency_keys_key_shape
    check (char_length(key) between 1 and 128),
  constraint idempotency_keys_hash_sha256
    check (request_hash ~ '^[a-f0-9]{64}$'),
  constraint idempotency_keys_status_http
    check (status_code between 200 and 599)
);

comment on table public.idempotency_keys is
  'Replay store for Idempotency-Key. Not tenant-scoped; PK is actor+route+key. '
  'No authenticated policies: service_role is the only writer and reader.';

create index if not exists idempotency_keys_created_idx
  on public.idempotency_keys (created_at);

alter table public.idempotency_keys enable row level security;
alter table public.idempotency_keys force row level security;

-- No SELECT/INSERT/UPDATE/DELETE policy for `authenticated` or `anon`.
-- FORCE RLS + no policy = deny all for those roles. service_role BYPASSRLS.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.idempotency_keys from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.idempotency_keys from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.idempotency_keys to service_role';
  end if;
end
$$;
