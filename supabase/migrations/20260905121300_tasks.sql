-- Migration 13 — tasks
--
-- The atomic unit of internal work, and the one place the persistence model is
-- deliberately looser than the stated hierarchy (ADR-0005).
--
-- The hierarchy says Task lives under Deliverable, and `HIERARCHY_PARENT` in
-- `src/lib/domain/entities.ts` still says so. But real work is not always
-- attached to a deliverable: investigation, internal meetings, maintenance.
-- So:
--
--   * `project_id`     NOT NULL — every task belongs to a project;
--   * `deliverable_id` NULLABLE — attaching to a deliverable is optional;
--   * a trigger asserts that when a deliverable IS present, it belongs to the
--     SAME PROJECT as the task.
--
-- That last point is the one the composite FK cannot cover. The composite FK
-- proves same-TENANT only; without the trigger a task could hang off a
-- deliverable in a sibling project and every project rollup would be quietly
-- wrong (risk D-2).
--
-- Note the absence of `client_visible`. Clients see deliverables, not the
-- machinery that produces them. No client policy will be written against this
-- table at all — simpler and safer than a flag someone can flip.

create table if not exists public.tasks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id      uuid not null,
  deliverable_id  uuid,

  title       text not null,
  description text,

  status   public.task_status not null default 'TODO',
  priority public.priority    not null default 'MEDIUM',

  assignee_user_id uuid references public.profiles (id) on delete set null,
  -- Team-level assignment for work not yet allocated to a person.
  assigned_team    public.team
                     references public.teams (code)
                     on update cascade on delete restrict,

  due_date     date,
  started_at   timestamptz,
  completed_at timestamptz,

  estimated_hours numeric(6,2),
  actual_hours    numeric(6,2),

  blocked_reason text,
  -- Board ordering within a column. An integer with gaps, reordered by the
  -- application; not a linked list, which is unqueryable, and not a float,
  -- which eventually loses precision under repeated midpoint insertion.
  position integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete restrict,
  updated_by uuid references public.profiles (id) on delete restrict,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles (id) on delete restrict,

  constraint tasks_id_org_key unique (id, organization_id),

  constraint tasks_project_fkey
    foreign key (project_id, organization_id)
    references public.projects (id, organization_id)
    on update cascade on delete cascade,

  -- SET NULL, not CASCADE: deleting a deliverable must not silently destroy
  -- the record of work done towards it. The task survives, detached.
  constraint tasks_deliverable_fkey
    foreign key (deliverable_id, organization_id)
    references public.deliverables (id, organization_id)
    on update cascade on delete set null,

  constraint tasks_title_not_blank check (btrim(title) <> ''),
  constraint tasks_estimated_hours_non_negative
    check (estimated_hours is null or estimated_hours >= 0),
  constraint tasks_actual_hours_non_negative
    check (actual_hours is null or actual_hours >= 0),
  constraint tasks_done_requires_timestamp
    check (status <> 'DONE' or completed_at is not null),
  -- A blocked task with no stated reason is an untriageable task.
  constraint tasks_blocked_requires_reason
    check (status <> 'BLOCKED' or btrim(coalesce(blocked_reason, '')) <> ''),
  constraint tasks_completed_after_started
    check (started_at is null or completed_at is null or completed_at >= started_at),
  constraint tasks_deleted_by_requires_deleted_at
    check (deleted_by is null or deleted_at is not null)
);

comment on table public.tasks is
  'Atomic unit of internal work. project_id NOT NULL, deliverable_id NULLABLE '
  '(ADR-0005) with a trigger enforcing same-project when present. Internal '
  'only: clients have no read path to this table.';
comment on column public.tasks.deliverable_id is
  'Optional. The hierarchy says Task lives under Deliverable; the persistence '
  'model is one step looser at exactly this edge, by decision.';

-- "My tasks" — the most-run authenticated query in the product.
create index if not exists tasks_assignee_status_idx
  on public.tasks (assignee_user_id, status)
  where deleted_at is null and assignee_user_id is not null;

-- The project board, in board order.
create index if not exists tasks_project_board_idx
  on public.tasks (project_id, status, position)
  where deleted_at is null;

create index if not exists tasks_deliverable_idx
  on public.tasks (deliverable_id)
  where deleted_at is null and deliverable_id is not null;

create index if not exists tasks_org_status_idx
  on public.tasks (organization_id, status)
  where deleted_at is null;

-- Unassigned team queue.
create index if not exists tasks_team_status_idx
  on public.tasks (assigned_team, status)
  where deleted_at is null and assigned_team is not null;

-- Overdue sweep and the TASK_DUE_SOON notification job.
create index if not exists tasks_due_open_idx
  on public.tasks (due_date)
  where deleted_at is null
    and status not in ('DONE', 'CANCELLED')
    and due_date is not null;

create index if not exists tasks_created_by_idx on public.tasks (created_by);
create index if not exists tasks_updated_by_idx on public.tasks (updated_by);
create index if not exists tasks_deleted_by_idx on public.tasks (deleted_by);

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function growlith.set_updated_at();

drop trigger if exists tasks_derive_org on public.tasks;
create trigger tasks_derive_org
  before insert on public.tasks
  for each row execute function growlith.derive_organization_id('project_id', 'public.projects');

drop trigger if exists tasks_freeze_org on public.tasks;
create trigger tasks_freeze_org
  before update on public.tasks
  for each row execute function growlith.freeze_organization_id();

drop trigger if exists tasks_soft_delete_fields on public.tasks;
create trigger tasks_soft_delete_fields
  before insert or update on public.tasks
  for each row execute function growlith.enforce_soft_delete_fields();

drop trigger if exists tasks_active_team on public.tasks;
create trigger tasks_active_team
  before insert or update of assigned_team on public.tasks
  for each row execute function growlith.enforce_active_team('assigned_team');

-- ---------------------------------------------------------------------------
-- The ADR-0005 edge, enforced (risk D-2)
-- ---------------------------------------------------------------------------
create or replace function growlith.enforce_task_deliverable_project()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_deliverable_project uuid;
begin
  if new.deliverable_id is null then
    return new;
  end if;

  select project_id into v_deliverable_project
  from public.deliverables
  where id = new.deliverable_id;

  if v_deliverable_project is null then
    raise exception 'tasks: deliverable % does not exist', new.deliverable_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_deliverable_project is distinct from new.project_id then
    raise exception
      'tasks: deliverable % belongs to project %, not to project % — the '
      'composite FK proves same-tenant, this proves same-project',
      new.deliverable_id, v_deliverable_project, new.project_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists tasks_deliverable_same_project on public.tasks;
create trigger tasks_deliverable_same_project
  before insert or update of deliverable_id, project_id on public.tasks
  for each row execute function growlith.enforce_task_deliverable_project();

alter table public.tasks enable row level security;
alter table public.tasks force row level security;
