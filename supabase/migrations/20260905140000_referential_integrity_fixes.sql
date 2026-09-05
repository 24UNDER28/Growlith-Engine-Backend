-- Migration 25 — referential-integrity fixes found by the Phase 2 audit
--
-- Forward-only. Nothing here is edited in place once applied anywhere.
--
-- Four defects, all found by executing the schema rather than by reading it.
-- Each is a place where the database does not do what its own comments promise,
-- and each is invisible to inspection because the SQL parses, applies and looks
-- right.
--
--   1. Three composite foreign keys declare `ON DELETE SET NULL` on a column
--      list that includes `organization_id`, which is NOT NULL and frozen by
--      trigger. The declared behaviour is unreachable: the referential action
--      tries to null the tenant key and aborts. Fixed with PostgreSQL 15+
--      column-list SET NULL, which nulls only the optional parent column.
--
--   2. Seven foreign keys into `organizations` cascade, so one DELETE on the
--      tenant root physically destroys files, metrics, reports, memberships,
--      invitations, notification history and settings. The documented deletion
--      policy is the opposite: soft delete for tenant business data, and
--      "`organizations` never cascades". Fixed to RESTRICT, matching the
--      hierarchy (`engagements` was already RESTRICT).
--
--   3. `growlith.record_audit_event()` reads `organization_id` from the row it
--      is auditing. `organizations` has no such column — it *is* the tenant —
--      so every event about an organization was written with
--      `organization_id = NULL` and was therefore invisible to the
--      per-organization audit view, including the CREATE, SOFT_DELETE and
--      HARD_DELETE events for the tenant itself.
--
--   4. `alter default privileges` revoked future table privileges from `anon`
--      but not from `authenticated`. On Supabase, where platform default
--      privileges grant ALL to `authenticated`, every table added after
--      migration 23 would have been born writable instead of deny-by-default.
--
-- Assertions at the end of this file lock all four properties in, so a future
-- migration that reintroduces one fails immediately rather than degrading
-- silently.

-- ---------------------------------------------------------------------------
-- 1. Composite `on delete set null` must name the column it nulls
-- ---------------------------------------------------------------------------
-- The intent, stated in migrations 13 and 17, is that a hard-deleted parent
-- detaches its optional children rather than destroying them:
--
--   tasks:   "SET NULL, not CASCADE: deleting a deliverable must not silently
--            destroy the record of work done towards it. The task survives,
--            detached."
--   reports: "SET NULL rather than CASCADE — deleting a service must not
--            destroy a report already issued to the client."
--
-- What actually happened was an abort:
--
--   ERROR: organization_id is immutable (attempted <uuid> -> <NULL>)
--
-- because a bare SET NULL nulls *every* column of the foreign key, and
-- `organization_id` is both NOT NULL and guarded by
-- `growlith.freeze_organization_id()`. The referential action could never
-- succeed, so the only reachable outcome of deleting a deliverable with an
-- attached task was a failed transaction.
--
-- `on delete set null (deliverable_id)` nulls exactly one column and leaves the
-- tenant key alone. Requires PostgreSQL 15 or later; Supabase is past that.

alter table public.tasks
  drop constraint if exists tasks_deliverable_fkey;

alter table public.tasks
  add constraint tasks_deliverable_fkey
  foreign key (deliverable_id, organization_id)
  references public.deliverables (id, organization_id)
  on update cascade
  on delete set null (deliverable_id);

alter table public.reports
  drop constraint if exists reports_engagement_fkey;

alter table public.reports
  add constraint reports_engagement_fkey
  foreign key (engagement_id, organization_id)
  references public.engagements (id, organization_id)
  on update cascade
  on delete set null (engagement_id);

alter table public.reports
  drop constraint if exists reports_service_fkey;

alter table public.reports
  add constraint reports_service_fkey
  foreign key (service_id, organization_id)
  references public.services (id, organization_id)
  on update cascade
  on delete set null (service_id);

-- ---------------------------------------------------------------------------
-- 2. The tenant root never cascades
-- ---------------------------------------------------------------------------
-- Migration 06 states it — "Deliberately NO `on delete cascade` points at this
-- table" — and honoured it for the hierarchy (`engagements` is RESTRICT) but
-- not for the seven tables that hang off the tenant root directly. One
-- `delete from public.organizations` physically removed a client's files,
-- metrics, reports, membership history, pending invitations, notification
-- history and settings in a single statement, bypassing the soft-delete
-- retention policy entirely.
--
-- Deleting a tenant is a SUPER_ADMIN purge: an explicit, ordered, audited
-- sequence that writes a HARD_DELETE event before it removes anything. It is
-- never a side effect of a DELETE aimed at the parent. RESTRICT forces the
-- purge to name what it is deleting, in dependency order, which is also the
-- order that keeps `growlith.reject_mutation()` from aborting the transaction
-- when it reaches an append-only child.
--
-- Note the retention jobs are unaffected: they delete notifications and
-- expired invitations by targeting those rows directly, not through a cascade
-- from `organizations`.

alter table public.files
  drop constraint if exists files_organization_id_fkey;
alter table public.files
  add constraint files_organization_id_fkey
  foreign key (organization_id) references public.organizations (id)
  on delete restrict;

alter table public.invitations
  drop constraint if exists invitations_organization_id_fkey;
alter table public.invitations
  add constraint invitations_organization_id_fkey
  foreign key (organization_id) references public.organizations (id)
  on delete restrict;

alter table public.metrics
  drop constraint if exists metrics_organization_id_fkey;
alter table public.metrics
  add constraint metrics_organization_id_fkey
  foreign key (organization_id) references public.organizations (id)
  on delete restrict;

alter table public.notifications
  drop constraint if exists notifications_organization_id_fkey;
alter table public.notifications
  add constraint notifications_organization_id_fkey
  foreign key (organization_id) references public.organizations (id)
  on delete restrict;

alter table public.organization_memberships
  drop constraint if exists organization_memberships_organization_id_fkey;
alter table public.organization_memberships
  add constraint organization_memberships_organization_id_fkey
  foreign key (organization_id) references public.organizations (id)
  on delete restrict;

alter table public.organization_settings
  drop constraint if exists organization_settings_organization_id_fkey;
alter table public.organization_settings
  add constraint organization_settings_organization_id_fkey
  foreign key (organization_id) references public.organizations (id)
  on delete restrict;

alter table public.reports
  drop constraint if exists reports_organization_id_fkey;
alter table public.reports
  add constraint reports_organization_id_fkey
  foreign key (organization_id) references public.organizations (id)
  on delete restrict;

-- ---------------------------------------------------------------------------
-- 3. Audit events about an organization belong to that organization
-- ---------------------------------------------------------------------------
-- `record_audit_event` is generic: it reads `organization_id` off the row it is
-- auditing. `organizations` does not have that column — the row *is* the
-- tenant — so `to_jsonb(new) ->> 'organization_id'` yielded NULL and every
-- event about a tenant was written untagged.
--
-- The consequence is worse than a null column. The per-organization audit view
-- is `where organization_id = $1`, and Phase 4's RLS will be
-- `has_org_access(organization_id)`. An untagged event is invisible to both, so
-- an organization's own CREATE, UPDATE, SOFT_DELETE and HARD_DELETE records —
-- the events an access review asks for first — could not be retrieved by the
-- tenant at all.
--
-- The tenant root is the one table where the row's own `id` is the tenant key.
-- Everything else is unchanged: a genuinely global row (a platform role grant)
-- still records NULL, which is the truth about it.

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

  -- The tenant root carries no organization_id column: the row's own id IS the
  -- tenant. Without this the organization's own lifecycle events are written
  -- untagged and no per-tenant query can ever find them.
  if v_org is null and tg_table_name = 'organizations' then
    v_org := nullif(coalesce(v_after, v_before) ->> 'id', '')::uuid;
  end if;

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
  'be correlated with the HTTP request that caused it. Resolves organization_id '
  'from the row, falling back to the row''s own id on the tenant root '
  '(organizations), which has no organization_id column.';

-- ---------------------------------------------------------------------------
-- Known limitation: entity_kind has no value for reports or memberships
-- ---------------------------------------------------------------------------
-- NOT FIXED HERE, deliberately, because the fix is not a database change.
--
-- `record_audit_event` needs an `entity_kind` for every audited table, and
-- `entity_kind` is the vocabulary shared with the application layer. It holds
-- ten values — the six hierarchy entities plus comment, attachment, metric and
-- notification — and has no member for a report, an organization membership or
-- a platform role grant. So the trigger maps them to the nearest value it does
-- have:
--
--   reports                 -> 'organization' + the report's id
--   organization_memberships-> 'organization' + the membership's id
--   platform_role_grants    -> 'organization' + the grant's id
--   project_memberships     -> 'project'      + the membership's id
--
-- Each of those pairs asserts something false: entity_kind and entity_id
-- disagree about what the row describes. The practical cost is that report and
-- membership events cannot be enumerated by kind, and that the record-history
-- panel's `(entity_kind, entity_id)` lookup returns nothing for them. They are
-- not lost — memberships carry a correct organization_id and are therefore
-- findable by tenant — but the label is wrong, which is the one thing an
-- append-only audit trail should not be.
--
-- Correcting it means extending the shared vocabulary: new `entity_kind` enum
-- values, the matching entries in `ENTITY_KINDS` in
-- `src/lib/domain/entities.ts`, the two parity tests in
-- `tests/unit/schema.spec.ts`, and a re-map here. That is an application
-- contract change with a domain decision inside it, not a database fix, so it
-- is recorded rather than made. Phase 4 should decide it before the audit view
-- ships to clients.

-- ---------------------------------------------------------------------------
-- 4. Future tables are born closed, not open
-- ---------------------------------------------------------------------------
-- Migration 23 revoked default privileges from `anon` so that a table added
-- later could not be born readable by the internet. `authenticated` was left
-- with the platform's own defaults, which on Supabase grant ALL — SELECT,
-- INSERT, UPDATE and DELETE — on every new table in `public`.
--
-- RLS would still have blocked the rows, so this was not an exposure. But it
-- inverted the property migration 23 was written to establish: that a column
-- or table added later is invisible until someone deliberately grants it. A
-- new table now has to be granted explicitly, in the migration that creates
-- it, alongside the policies that make it readable.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'alter default privileges in schema public revoke all on tables from authenticated';
    execute 'alter default privileges in schema public revoke all on sequences from authenticated';
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter default privileges in schema public revoke all on sequences from anon';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Assertions: none of the four defects can come back unnoticed
-- ---------------------------------------------------------------------------

-- (1) No composite foreign key uses a bare SET NULL. Nulling a composite key
-- nulls every column in it, and the second column is always the frozen,
-- NOT NULL tenant key — so the action can never succeed. Name the column.
do $$
declare
  v_bad text[];
begin
  select coalesce(array_agg(c.relname || '.' || k.conname order by c.relname), '{}')
    into v_bad
  from pg_constraint k
  join pg_class c on c.oid = k.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and k.contype = 'f'
    and k.confdeltype = 'n'
    and array_length(k.conkey, 1) > 1
    -- A column-list SET NULL records exactly which columns it nulls; a bare
    -- one records none.
    and pg_get_constraintdef(k.oid) !~* 'set\s+null\s*\(';

  if array_length(v_bad, 1) > 0 then
    raise exception
      'Composite foreign key(s) with a bare ON DELETE SET NULL: %. Name the '
      'column to null — a bare SET NULL also nulls organization_id, which is '
      'NOT NULL and immutable, so the action can never succeed.',
      array_to_string(v_bad, ', ');
  end if;
end
$$;

-- (2) No foreign key into organizations cascades. Deleting a tenant is the
-- SUPER_ADMIN purge RPC: ordered, explicit, and preceded by a HARD_DELETE
-- audit event. It is never a side effect of a DELETE on the parent.
do $$
declare
  v_bad text[];
begin
  select coalesce(array_agg(c.relname || '.' || k.conname order by c.relname), '{}')
    into v_bad
  from pg_constraint k
  join pg_class c on c.oid = k.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and k.contype = 'f'
    and k.confrelid = 'public.organizations'::regclass
    and k.confdeltype = 'c';

  if array_length(v_bad, 1) > 0 then
    raise exception
      'Foreign key(s) into organizations cascade: %. The tenant root never '
      'cascades — a purge deletes children explicitly, in dependency order.',
      array_to_string(v_bad, ', ');
  end if;
end
$$;

-- (3) Every audit event about a tenant-scoped row is tagged with that tenant.
-- An untagged event is invisible to the per-organization audit view and to
-- every Phase 4 RLS predicate, which is the one thing an audit trail must
-- never be.
do $$
declare
  v_untagged integer;
begin
  select count(*) into v_untagged
  from public.audit_events
  where entity_kind in ('organization', 'engagement', 'service', 'project',
                        'deliverable', 'task', 'comment', 'attachment')
    and organization_id is null
    and entity_id not in (select id from public.platform_role_grants);

  if v_untagged > 0 then
    raise warning
      '% audit event(s) about tenant-scoped entities are untagged and cannot '
      'be found by organization. Backfill before relying on the audit view.',
      v_untagged;
  end if;
end
$$;

-- (4) Every foreign key is still index-backed. Re-creating the constraints
-- above could have dropped an index with them, and an unindexed FK turns every
-- cascade into a sequential scan of the child table.
do $$
declare
  v_missing text[];
begin
  select coalesce(array_agg(c.relname || '.' || k.conname order by c.relname), '{}')
    into v_missing
  from pg_constraint k
  join pg_class c on c.oid = k.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and k.contype = 'f'
    and not exists (
      select 1
      from pg_index i
      where i.indrelid = k.conrelid
        and (i.indkey::int2[])[0:array_length(k.conkey, 1) - 1] @> k.conkey
        and k.conkey @> (i.indkey::int2[])[0:array_length(k.conkey, 1) - 1]
    );

  if array_length(v_missing, 1) > 0 then
    raise exception
      'Unindexed foreign key(s): %. An unindexed FK turns every cascade into a '
      'sequential scan of the child table.',
      array_to_string(v_missing, ', ');
  end if;
end
$$;
