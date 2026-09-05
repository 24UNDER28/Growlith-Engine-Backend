-- Migration 20 — status_transitions
--
-- The legal state machine, as reference data plus one trigger.
--
-- Why in the database and not only in the API: PostgREST exposes tables
-- directly. A status column enforced only in a route handler is enforced only
-- for callers who use that route handler. Putting the machine here means the
-- API and the database cannot disagree, because there is one machine.
--
-- Statuses are stored as `text` rather than a union type — the table spans six
-- different enums and PostgreSQL has no union of enums. A trigger validates
-- each seeded row against the correct enum on insert, so the text column
-- cannot hold a value the enum does not have.
--
-- `allowed_roles` is text[] and is NOT enforced here: role checking is Phase 4
-- authorization. This migration enforces only which transitions are STRUCTURALLY
-- legal, which is schema integrity — it prevents a deliverable jumping from
-- DRAFT straight to PUBLISHED, whoever asks.

create table if not exists public.status_transitions (
  entity_kind public.entity_kind not null,
  from_status text               not null,
  to_status   text               not null,

  -- Advisory in Phase 2; the Phase 4 permission layer reads it.
  allowed_roles   text[]  not null default '{}',
  requires_reason boolean not null default false,
  is_terminal     boolean not null default false,
  description     text,

  created_at timestamptz not null default now(),

  constraint status_transitions_pkey
    primary key (entity_kind, from_status, to_status),
  constraint status_transitions_no_self_loop check (from_status <> to_status)
);

comment on table public.status_transitions is
  'Legal state transitions per entity. Enforced by trigger so the API and the '
  'database cannot disagree about what a valid status change is.';
comment on column public.status_transitions.allowed_roles is
  'Advisory in Phase 2. Phase 4 authorization reads it; the trigger here '
  'checks structure only.';

create index if not exists status_transitions_entity_from_idx
  on public.status_transitions (entity_kind, from_status);

alter table public.status_transitions enable row level security;
alter table public.status_transitions force row level security;

-- ---------------------------------------------------------------------------
-- Seed rows are validated against the real enum
-- ---------------------------------------------------------------------------
create or replace function growlith.validate_status_transition_row()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_type text;
begin
  v_type := case new.entity_kind
    when 'engagement'  then 'public.engagement_status'
    when 'service'     then 'public.service_status'
    when 'project'     then 'public.project_status'
    when 'deliverable' then 'public.deliverable_status'
    when 'task'        then 'public.task_status'
    else null
  end;

  if v_type is null then
    raise exception 'status_transitions: % has no status machine', new.entity_kind
      using errcode = 'check_violation';
  end if;

  -- Casting is the validation: an unknown label raises invalid_text_representation.
  execute format('select %L::%s', new.from_status, v_type);
  execute format('select %L::%s', new.to_status, v_type);

  return new;
end;
$$;

drop trigger if exists status_transitions_validate on public.status_transitions;
create trigger status_transitions_validate
  before insert or update on public.status_transitions
  for each row execute function growlith.validate_status_transition_row();

-- ---------------------------------------------------------------------------
-- The generic enforcement trigger
-- ---------------------------------------------------------------------------
-- TG_ARGV[0] = the entity_kind this table represents.
create or replace function growlith.enforce_status_transition()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity   constant public.entity_kind := tg_argv[0]::public.entity_kind;
  v_from     text;
  v_to       text;
begin
  execute 'select ($1).status::text' into v_from using old;
  execute 'select ($1).status::text' into v_to   using new;

  if v_from is not distinct from v_to then
    return new;
  end if;

  if not exists (
    select 1
    from public.status_transitions t
    where t.entity_kind = v_entity
      and t.from_status = v_from
      and t.to_status   = v_to
  ) then
    raise exception '% : % -> % is not a legal transition', v_entity, v_from, v_to
      using errcode = 'check_violation',
            hint = 'See public.status_transitions for the legal set.';
  end if;

  return new;
end;
$$;

comment on function growlith.enforce_status_transition() is
  'BEFORE UPDATE OF status. Rejects any transition absent from '
  'status_transitions, for every caller including direct PostgREST writes.';

-- ---------------------------------------------------------------------------
-- Seed: engagement
-- ---------------------------------------------------------------------------
insert into public.status_transitions
  (entity_kind, from_status, to_status, allowed_roles, requires_reason, is_terminal) values
  ('engagement', 'DRAFT',             'PENDING_SIGNATURE', '{SUPER_ADMIN,ADMIN}', false, false),
  ('engagement', 'DRAFT',             'CANCELLED',         '{SUPER_ADMIN,ADMIN}', true,  true),
  ('engagement', 'PENDING_SIGNATURE', 'ACTIVE',            '{SUPER_ADMIN,ADMIN}', false, false),
  ('engagement', 'PENDING_SIGNATURE', 'DRAFT',             '{SUPER_ADMIN,ADMIN}', false, false),
  ('engagement', 'PENDING_SIGNATURE', 'CANCELLED',         '{SUPER_ADMIN,ADMIN}', true,  true),
  ('engagement', 'ACTIVE',            'PAUSED',            '{SUPER_ADMIN,ADMIN}', true,  false),
  ('engagement', 'ACTIVE',            'COMPLETED',         '{SUPER_ADMIN,ADMIN}', false, true),
  ('engagement', 'ACTIVE',            'CANCELLED',         '{SUPER_ADMIN}',       true,  true),
  ('engagement', 'PAUSED',            'ACTIVE',            '{SUPER_ADMIN,ADMIN}', false, false),
  ('engagement', 'PAUSED',            'COMPLETED',         '{SUPER_ADMIN,ADMIN}', false, true),
  ('engagement', 'PAUSED',            'CANCELLED',         '{SUPER_ADMIN}',       true,  true)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Seed: service
-- ---------------------------------------------------------------------------
insert into public.status_transitions
  (entity_kind, from_status, to_status, allowed_roles, requires_reason, is_terminal) values
  ('service', 'PLANNED',   'ACTIVE',    '{SUPER_ADMIN,ADMIN}', false, false),
  ('service', 'PLANNED',   'CANCELLED', '{SUPER_ADMIN,ADMIN}', true,  true),
  ('service', 'ACTIVE',    'PAUSED',    '{SUPER_ADMIN,ADMIN}', true,  false),
  ('service', 'ACTIVE',    'COMPLETED', '{SUPER_ADMIN,ADMIN}', false, true),
  ('service', 'ACTIVE',    'CANCELLED', '{SUPER_ADMIN,ADMIN}', true,  true),
  ('service', 'PAUSED',    'ACTIVE',    '{SUPER_ADMIN,ADMIN}', false, false),
  ('service', 'PAUSED',    'CANCELLED', '{SUPER_ADMIN,ADMIN}', true,  true),
  ('service', 'COMPLETED', 'ACTIVE',    '{SUPER_ADMIN}',       true,  false)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Seed: project
-- ---------------------------------------------------------------------------
insert into public.status_transitions
  (entity_kind, from_status, to_status, allowed_roles, requires_reason, is_terminal) values
  ('project', 'PLANNED',     'IN_PROGRESS', '{SUPER_ADMIN,ADMIN}', false, false),
  ('project', 'PLANNED',     'CANCELLED',   '{SUPER_ADMIN,ADMIN}', true,  true),
  ('project', 'IN_PROGRESS', 'BLOCKED',     '{SUPER_ADMIN,ADMIN}', true,  false),
  ('project', 'IN_PROGRESS', 'IN_REVIEW',   '{SUPER_ADMIN,ADMIN}', false, false),
  ('project', 'IN_PROGRESS', 'COMPLETED',   '{SUPER_ADMIN,ADMIN}', false, true),
  ('project', 'IN_PROGRESS', 'CANCELLED',   '{SUPER_ADMIN,ADMIN}', true,  true),
  ('project', 'BLOCKED',     'IN_PROGRESS', '{SUPER_ADMIN,ADMIN}', false, false),
  ('project', 'BLOCKED',     'CANCELLED',   '{SUPER_ADMIN,ADMIN}', true,  true),
  ('project', 'IN_REVIEW',   'IN_PROGRESS', '{SUPER_ADMIN,ADMIN}', false, false),
  ('project', 'IN_REVIEW',   'COMPLETED',   '{SUPER_ADMIN,ADMIN}', false, true),
  ('project', 'COMPLETED',   'IN_PROGRESS', '{SUPER_ADMIN}',       true,  false)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Seed: deliverable — the review/approval workflow from the domain model
-- ---------------------------------------------------------------------------
insert into public.status_transitions
  (entity_kind, from_status, to_status, allowed_roles, requires_reason, is_terminal) values
  ('deliverable', 'DRAFT',              'IN_PROGRESS',        '{SUPER_ADMIN,ADMIN}', false, false),
  ('deliverable', 'DRAFT',              'CANCELLED',          '{SUPER_ADMIN,ADMIN}', true,  true),
  ('deliverable', 'IN_PROGRESS',        'INTERNAL_REVIEW',    '{SUPER_ADMIN,ADMIN}', false, false),
  ('deliverable', 'IN_PROGRESS',        'DRAFT',              '{SUPER_ADMIN,ADMIN}', false, false),
  ('deliverable', 'IN_PROGRESS',        'CANCELLED',          '{SUPER_ADMIN,ADMIN}', true,  true),
  ('deliverable', 'INTERNAL_REVIEW',    'IN_PROGRESS',        '{SUPER_ADMIN,ADMIN}', false, false),
  ('deliverable', 'INTERNAL_REVIEW',    'SUBMITTED',          '{SUPER_ADMIN,ADMIN}', false, false),
  ('deliverable', 'SUBMITTED',          'CLIENT_REVIEW',      '{SUPER_ADMIN,ADMIN}', false, false),
  ('deliverable', 'SUBMITTED',          'IN_PROGRESS',        '{SUPER_ADMIN,ADMIN}', false, false),
  -- The two client-driven transitions.
  ('deliverable', 'CLIENT_REVIEW',      'APPROVED',           '{SUPER_ADMIN,ADMIN,CLIENT_ADMIN}', false, false),
  ('deliverable', 'CLIENT_REVIEW',      'REVISION_REQUESTED', '{SUPER_ADMIN,ADMIN,CLIENT_ADMIN}', true,  false),
  ('deliverable', 'REVISION_REQUESTED', 'IN_PROGRESS',        '{SUPER_ADMIN,ADMIN}', false, false),
  ('deliverable', 'REVISION_REQUESTED', 'CANCELLED',          '{SUPER_ADMIN,ADMIN}', true,  true),
  ('deliverable', 'APPROVED',           'PUBLISHED',          '{SUPER_ADMIN,ADMIN}', false, true),
  ('deliverable', 'APPROVED',           'IN_PROGRESS',        '{SUPER_ADMIN}',       true,  false),
  ('deliverable', 'PUBLISHED',          'IN_PROGRESS',        '{SUPER_ADMIN}',       true,  false)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Seed: task
-- ---------------------------------------------------------------------------
insert into public.status_transitions
  (entity_kind, from_status, to_status, allowed_roles, requires_reason, is_terminal) values
  ('task', 'TODO',        'IN_PROGRESS', '{SUPER_ADMIN,ADMIN}', false, false),
  ('task', 'TODO',        'BLOCKED',     '{SUPER_ADMIN,ADMIN}', true,  false),
  ('task', 'TODO',        'CANCELLED',   '{SUPER_ADMIN,ADMIN}', false, true),
  ('task', 'IN_PROGRESS', 'BLOCKED',     '{SUPER_ADMIN,ADMIN}', true,  false),
  ('task', 'IN_PROGRESS', 'IN_REVIEW',   '{SUPER_ADMIN,ADMIN}', false, false),
  ('task', 'IN_PROGRESS', 'DONE',        '{SUPER_ADMIN,ADMIN}', false, true),
  ('task', 'IN_PROGRESS', 'TODO',        '{SUPER_ADMIN,ADMIN}', false, false),
  ('task', 'IN_PROGRESS', 'CANCELLED',   '{SUPER_ADMIN,ADMIN}', false, true),
  ('task', 'BLOCKED',     'IN_PROGRESS', '{SUPER_ADMIN,ADMIN}', false, false),
  ('task', 'BLOCKED',     'TODO',        '{SUPER_ADMIN,ADMIN}', false, false),
  ('task', 'BLOCKED',     'CANCELLED',   '{SUPER_ADMIN,ADMIN}', false, true),
  ('task', 'IN_REVIEW',   'IN_PROGRESS', '{SUPER_ADMIN,ADMIN}', false, false),
  ('task', 'IN_REVIEW',   'DONE',        '{SUPER_ADMIN,ADMIN}', false, true),
  ('task', 'DONE',        'IN_PROGRESS', '{SUPER_ADMIN,ADMIN}', true,  false),
  ('task', 'CANCELLED',   'TODO',        '{SUPER_ADMIN,ADMIN}', true,  false)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Attach the trigger
-- ---------------------------------------------------------------------------
drop trigger if exists engagements_status_transition on public.engagements;
create trigger engagements_status_transition
  before update of status on public.engagements
  for each row execute function growlith.enforce_status_transition('engagement');

drop trigger if exists services_status_transition on public.services;
create trigger services_status_transition
  before update of status on public.services
  for each row execute function growlith.enforce_status_transition('service');

drop trigger if exists projects_status_transition on public.projects;
create trigger projects_status_transition
  before update of status on public.projects
  for each row execute function growlith.enforce_status_transition('project');

drop trigger if exists deliverables_status_transition on public.deliverables;
create trigger deliverables_status_transition
  before update of status on public.deliverables
  for each row execute function growlith.enforce_status_transition('deliverable');

drop trigger if exists tasks_status_transition on public.tasks;
create trigger tasks_status_transition
  before update of status on public.tasks
  for each row execute function growlith.enforce_status_transition('task');

-- `reports` is deliberately excluded: its lifecycle is linear
-- (DRAFT -> INTERNAL_REVIEW -> PUBLISHED -> ARCHIVED) and already fully
-- constrained by reports_published_coherent. A machine with no branches does
-- not need a table.
