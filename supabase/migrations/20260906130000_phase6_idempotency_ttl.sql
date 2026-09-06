-- Phase 6 (L-4): idempotency key TTL and expiry
-- Keys are advisory after 24h; automatic expiry prevents indefinite storage
-- and allows safe client retry after window.

alter table public.idempotency_keys
  add column if not exists expires_at timestamptz not null default (now() + interval '24 hours');

-- Backfill existing rows without explicit expiry (created_at + 24h)
update public.idempotency_keys
  set expires_at = created_at + interval '24 hours'
  where expires_at is null
     or expires_at = created_at;  -- no-op guard for idempotency

create index if not exists idempotency_keys_expires_idx
  on public.idempotency_keys (expires_at);

comment on column public.idempotency_keys.expires_at is
  'Idempotency replay window — default 24h from creation. Rows older than this should be treated as stale and may be purged.';

-- Scheduled purge helper (callable from cron/pg_cron if enabled; otherwise manual).
-- Kept as a function so a future pg_cron job can schedule it without schema change.
create or replace function public.purge_expired_idempotency_keys()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from public.idempotency_keys where expires_at < now();
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.purge_expired_idempotency_keys() from public;
revoke all on function public.purge_expired_idempotency_keys() from anon, authenticated;
grant execute on function public.purge_expired_idempotency_keys() to service_role;
