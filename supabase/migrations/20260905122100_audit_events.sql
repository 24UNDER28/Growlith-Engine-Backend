-- Migration 21 — audit_events
--
-- Append-only record of every consequential change. Not derivable from
-- `updated_at`, which records only the LAST writer and nothing about what
-- changed or why.
--
-- Three design points worth stating, because each looks wrong at a glance:
--
-- 1. NO foreign keys on organization_id, actor_user_id or entity_id. An audit
--    event must outlive the row it describes — the most important event in the
--    table is often the deletion itself. A FK would make the evidence
--    cascade away with the crime.
--
-- 2. `before`/`after` are jsonb. This is the ONE justified JSON column in the
--    schema. The alternative is a typed shadow table per entity — fifteen of
--    them, migrated in lockstep forever. Audit payloads are write-once,
--    read-rarely, never joined and never filtered by individual key. Every
--    dimension anyone actually queries — organization, actor, entity, action,
--    severity, changed_fields — is a real typed column. The jsonb holds only
--    the diff body.
--
-- 3. Partitioned monthly from day one. Retrofitting partitioning onto a live
--    audit table means a maintenance window and a full rewrite; doing it now
--    costs one extra clause.

create table if not exists public.audit_events (
  -- bigint identity, not uuid: this will be the largest table by row count and
  -- monotonic ordering matters more than opacity. Nothing links TO an audit
  -- event, so there is no id to leak.
  id bigint generated always as identity,

  occurred_at timestamptz not null default now(),

  -- No FK, by design (point 1 above).
  organization_id uuid,
  actor_user_id   uuid,
  actor_role      text,
  actor_ip        inet,
  -- Joins to the Phase 1 structured log, so a database event and an HTTP
  -- request can be correlated without guessing.
  request_id      text,

  entity_kind public.entity_kind   not null,
  entity_id   uuid                 not null,
  action      public.audit_action  not null,
  severity    public.audit_severity not null default 'INFO',

  changed_fields text[],
  before         jsonb,
  after          jsonb,
  reason         text,

  -- Partition key must be part of every unique constraint, including the PK.
  constraint audit_events_pkey primary key (id, occurred_at)
) partition by range (occurred_at);

comment on table public.audit_events is
  'Append-only audit trail, partitioned monthly. No foreign keys: an event '
  'must survive the deletion of what it describes. UPDATE and DELETE are '
  'rejected for every role including service_role.';
comment on column public.audit_events.before is
  'Justified jsonb: write-once, read-rarely, never joined, never filtered by '
  'key. Every queryable dimension is a real typed column.';

-- The per-organization audit view.
create index if not exists audit_events_org_time_idx
  on public.audit_events (organization_id, occurred_at desc);

-- The per-record history panel — the most common audit read by far.
create index if not exists audit_events_entity_idx
  on public.audit_events (entity_kind, entity_id, occurred_at desc);

-- "What did this person do?" — the access-review query.
create index if not exists audit_events_actor_idx
  on public.audit_events (actor_user_id, occurred_at desc);

-- The security feed. Partial, so it stays tiny relative to the table.
create index if not exists audit_events_severe_idx
  on public.audit_events (action, occurred_at desc)
  where severity in ('WARNING', 'CRITICAL');

-- Correlate a database change with the HTTP request that caused it.
create index if not exists audit_events_request_idx
  on public.audit_events (request_id)
  where request_id is not null;

-- BRIN on the partition key: append-ordered, huge, only ever range-scanned.
create index if not exists audit_events_time_brin
  on public.audit_events using brin (occurred_at);

alter table public.audit_events enable row level security;
alter table public.audit_events force row level security;

drop trigger if exists audit_events_append_only on public.audit_events;
create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function growlith.reject_mutation();

-- ---------------------------------------------------------------------------
-- Partition management
-- ---------------------------------------------------------------------------
-- A DEFAULT partition guarantees no insert can ever fail for want of a
-- partition. Rows landing there are a monitoring signal, not an outage.
--
-- IMPORTANT: a partition does NOT inherit its parent's row security when it is
-- queried directly, and PostgREST will happily expose `audit_events_202609` as
-- its own resource. Every partition therefore enables and forces RLS in its
-- own right. The coverage assertion in migration 23 is what caught this.
do $$
begin
  if to_regclass('public.audit_events_default') is null then
    execute 'create table public.audit_events_default
             partition of public.audit_events default';
  end if;

  execute 'alter table public.audit_events_default enable row level security';
  execute 'alter table public.audit_events_default force row level security';
end
$$;

create or replace function growlith.ensure_audit_partition(p_month date)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := format('audit_events_%s', to_char(v_start, 'YYYYMM'));
begin
  if to_regclass(format('public.%I', v_name)) is null then
    execute format(
      'create table public.%I partition of public.audit_events
         for values from (%L) to (%L)',
      v_name, v_start, v_end
    );
  end if;

  -- Not inherited from the parent, and required for every partition — see the
  -- note above. Unconditional so an older partition created before this rule
  -- existed is corrected on the next call.
  execute format('alter table public.%I enable row level security', v_name);
  execute format('alter table public.%I force row level security', v_name);

  return v_name;
end;
$$;

comment on function growlith.ensure_audit_partition(date) is
  'Idempotently creates the monthly partition for the given month. Called by '
  'this migration for the current window and by a scheduled job thereafter.';

-- Create the current month plus twelve ahead, so no scheduled job is required
-- for the first year and a missed job is never an incident.
do $$
declare
  i int;
begin
  for i in 0..12 loop
    perform growlith.ensure_audit_partition(
      (date_trunc('month', now()) + make_interval(months => i))::date
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- The generic audit trigger
-- ---------------------------------------------------------------------------
-- TG_ARGV[0] = entity_kind for this table.
--
-- Redaction: token hashes and similar secrets are stripped from the payload
-- here, mirroring the Phase 1 logger's redaction list. An audit row is still a
-- row someone can read.
create or replace function growlith.record_audit_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity   constant public.entity_kind := tg_argv[0]::public.entity_kind;
  v_redacted constant text[] := array['token_hash', 'checksum_sha256'];
  v_before   jsonb;
  v_after    jsonb;
  v_action   public.audit_action;
  v_severity public.audit_severity := 'INFO';
  v_changed  text[];
  v_org      uuid;
  v_entity_id uuid;
  v_actor    uuid;
  v_key      text;
begin
  v_actor := auth.uid();

  if tg_op = 'INSERT' then
    v_after  := to_jsonb(new);
    v_action := 'CREATE';
  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old);
    v_after  := to_jsonb(new);

    select coalesce(array_agg(key order by key), '{}')
      into v_changed
    from jsonb_each(v_after) e(key, value)
    where v_before -> e.key is distinct from e.value
      -- updated_at changes on every write and would make changed_fields noise.
      and e.key <> 'updated_at';

    if v_changed = '{}'::text[] then
      return null;  -- AFTER trigger: nothing of substance changed.
    end if;

    if 'deleted_at' = any (v_changed)
       and (v_before ->> 'deleted_at') is null
       and (v_after  ->> 'deleted_at') is not null
    then
      v_action   := 'SOFT_DELETE';
      v_severity := 'NOTICE';
    elsif 'deleted_at' = any (v_changed)
       and (v_before ->> 'deleted_at') is not null
       and (v_after  ->> 'deleted_at') is null
    then
      v_action   := 'RESTORE';
      v_severity := 'NOTICE';
    elsif 'status' = any (v_changed) then
      v_action := 'STATUS_CHANGE';
    else
      v_action := 'UPDATE';
    end if;
  else
    v_before := to_jsonb(old);
    v_action := 'HARD_DELETE';
    v_severity := 'CRITICAL';
  end if;

  -- Membership and role changes are the escalation surface: always CRITICAL.
  if tg_table_name in ('organization_memberships', 'platform_role_grants') then
    v_severity := 'CRITICAL';
  end if;

  foreach v_key in array v_redacted loop
    if v_before ? v_key then v_before := jsonb_set(v_before, array[v_key], '"[REDACTED]"'); end if;
    if v_after  ? v_key then v_after  := jsonb_set(v_after,  array[v_key], '"[REDACTED]"'); end if;
  end loop;

  v_org := nullif(coalesce(v_after, v_before) ->> 'organization_id', '')::uuid;
  v_entity_id := nullif(coalesce(v_after, v_before) ->> 'id', '')::uuid;

  insert into public.audit_events (
    organization_id, actor_user_id, actor_role, request_id,
    entity_kind, entity_id, action, severity,
    changed_fields, before, after
  ) values (
    v_org,
    v_actor,
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('growlith.request_id', true), ''),
    v_entity,
    v_entity_id,
    v_action,
    v_severity,
    v_changed,
    v_before,
    v_after
  );

  return null;
end;
$$;

comment on function growlith.record_audit_event() is
  'Generic AFTER trigger. Derives action and severity from the diff, redacts '
  'secret-bearing columns, and records the request id so a database change can '
  'be correlated with the HTTP request that caused it.';

-- ---------------------------------------------------------------------------
-- Attach to every audited table
-- ---------------------------------------------------------------------------
-- Hierarchy entities plus the two authorization tables. Notifications are not
-- audited: they are ephemeral by design and auditing them would triple the
-- table's write volume to record facts already captured at their source.
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('organizations',            'organization'),
      ('engagements',              'engagement'),
      ('services',                 'service'),
      ('projects',                 'project'),
      ('deliverables',             'deliverable'),
      ('tasks',                    'task'),
      ('comments',                 'comment'),
      ('files',                    'attachment'),
      ('reports',                  'organization'),
      ('organization_memberships', 'organization'),
      ('platform_role_grants',     'organization'),
      ('project_memberships',      'project')
    ) as t(table_name, entity_kind)
  loop
    execute format('drop trigger if exists %I on public.%I',
                   r.table_name || '_audit', r.table_name);
    execute format(
      'create trigger %I after insert or update or delete on public.%I
         for each row execute function growlith.record_audit_event(%L)',
      r.table_name || '_audit', r.table_name, r.entity_kind
    );
  end loop;
end
$$;
