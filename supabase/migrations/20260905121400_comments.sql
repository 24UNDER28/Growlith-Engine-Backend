-- Migration 14 — comments
--
-- Threaded discussion attached to exactly ONE of project, deliverable or task.
--
-- Modelled as three nullable typed FK columns plus an XOR check, NOT as a
-- generic (subject_type, subject_id) pair. The generic form is tempting and
-- wrong: it throws away referential integrity and cascade behaviour, so
-- deleting a deliverable leaves comments pointing at nothing and no constraint
-- notices. Three sparse columns cost a few bytes per row and buy real foreign
-- keys, real cascades and real composite-FK tenancy. That is the justification
-- required for the extra columns; it is not over-normalization, it is the
-- cheaper of the two designs.

create table if not exists public.comments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,

  -- Exactly one is non-null.
  project_id     uuid,
  deliverable_id uuid,
  task_id        uuid,

  parent_comment_id uuid,

  -- RESTRICT: attribution of a statement is the point of the statement.
  author_user_id uuid not null references public.profiles (id) on delete restrict,
  body           text not null,

  -- Internal-only discussion. Filtered by RLS for client roles in Phase 4 —
  -- never by the UI.
  is_internal boolean not null default false,

  edited_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete restrict,
  updated_by uuid references public.profiles (id) on delete restrict,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles (id) on delete restrict,

  constraint comments_id_org_key unique (id, organization_id),

  -- Exactly one subject.
  constraint comments_single_subject
    check (num_nonnulls(project_id, deliverable_id, task_id) = 1),

  constraint comments_project_fkey
    foreign key (project_id, organization_id)
    references public.projects (id, organization_id)
    on update cascade on delete cascade,
  constraint comments_deliverable_fkey
    foreign key (deliverable_id, organization_id)
    references public.deliverables (id, organization_id)
    on update cascade on delete cascade,
  constraint comments_task_fkey
    foreign key (task_id, organization_id)
    references public.tasks (id, organization_id)
    on update cascade on delete cascade,
  constraint comments_parent_fkey
    foreign key (parent_comment_id, organization_id)
    references public.comments (id, organization_id)
    on update cascade on delete cascade,

  -- Bounded so a single comment cannot be used as blob storage; the floor
  -- rejects empty posts that clutter every thread.
  constraint comments_body_length
    check (char_length(btrim(body)) between 1 and 10000),
  constraint comments_not_self_parent
    check (parent_comment_id is null or parent_comment_id <> id),
  constraint comments_deleted_by_requires_deleted_at
    check (deleted_by is null or deleted_at is not null)
);

comment on table public.comments is
  'Discussion on exactly one of project, deliverable or task. Typed nullable '
  'FKs with an XOR check, not a polymorphic (type, id) pair, so referential '
  'integrity and cascades survive.';

-- One index per subject, each partial so it holds only rows of that kind.
-- Threads are always read newest-first for one subject.
create index if not exists comments_deliverable_idx
  on public.comments (deliverable_id, created_at desc)
  where deliverable_id is not null and deleted_at is null;

create index if not exists comments_task_idx
  on public.comments (task_id, created_at desc)
  where task_id is not null and deleted_at is null;

create index if not exists comments_project_idx
  on public.comments (project_id, created_at desc)
  where project_id is not null and deleted_at is null;

create index if not exists comments_org_created_idx
  on public.comments (organization_id, created_at desc)
  where deleted_at is null;

create index if not exists comments_parent_idx
  on public.comments (parent_comment_id)
  where parent_comment_id is not null and deleted_at is null;

create index if not exists comments_author_idx
  on public.comments (author_user_id, created_at desc)
  where deleted_at is null;

create index if not exists comments_created_by_idx on public.comments (created_by);
create index if not exists comments_updated_by_idx on public.comments (updated_by);
create index if not exists comments_deleted_by_idx on public.comments (deleted_by);

drop trigger if exists comments_set_updated_at on public.comments;
create trigger comments_set_updated_at
  before update on public.comments
  for each row execute function growlith.set_updated_at();

drop trigger if exists comments_freeze_org on public.comments;
create trigger comments_freeze_org
  before update on public.comments
  for each row execute function growlith.freeze_organization_id();

drop trigger if exists comments_soft_delete_fields on public.comments;
create trigger comments_soft_delete_fields
  before insert or update on public.comments
  for each row execute function growlith.enforce_soft_delete_fields();

-- ---------------------------------------------------------------------------
-- Tenant derivation for a polymorphic parent
-- ---------------------------------------------------------------------------
-- The generic derive_organization_id() takes one fixed parent column, so
-- comments need their own: whichever subject is set is the source of truth.
create or replace function growlith.derive_comment_organization_id()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_org uuid;
begin
  -- Checked here as well as by comments_single_subject, because this BEFORE
  -- trigger runs first and would otherwise report "subject row not found",
  -- which is a confusing way to say "you named zero subjects".
  if num_nonnulls(new.project_id, new.deliverable_id, new.task_id) <> 1 then
    raise exception
      'comments: exactly one of project_id, deliverable_id or task_id is required'
      using errcode = 'check_violation';
  end if;

  if new.project_id is not null then
    select organization_id into v_org from public.projects where id = new.project_id;
  elsif new.deliverable_id is not null then
    select organization_id into v_org from public.deliverables where id = new.deliverable_id;
  elsif new.task_id is not null then
    select organization_id into v_org from public.tasks where id = new.task_id;
  end if;

  if v_org is null then
    raise exception 'comments: subject row not found — cannot derive organization_id'
      using errcode = 'foreign_key_violation';
  end if;

  if new.organization_id is not null and new.organization_id <> v_org then
    raise exception
      'comments: subject belongs to organization %, not %', v_org, new.organization_id
      using errcode = 'check_violation';
  end if;

  new.organization_id := v_org;
  return new;
end;
$$;

drop trigger if exists comments_derive_org on public.comments;
create trigger comments_derive_org
  before insert on public.comments
  for each row execute function growlith.derive_comment_organization_id();

-- ---------------------------------------------------------------------------
-- A reply stays on its parent's subject
-- ---------------------------------------------------------------------------
-- Otherwise a thread could span two deliverables and the "reply" would appear
-- under a subject its author never saw.
create or replace function growlith.enforce_comment_thread_subject()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_parent public.comments%rowtype;
begin
  if new.parent_comment_id is null then
    return new;
  end if;

  select * into v_parent from public.comments where id = new.parent_comment_id;

  if not found then
    raise exception 'comments: parent % does not exist', new.parent_comment_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_parent.project_id     is distinct from new.project_id
     or v_parent.deliverable_id is distinct from new.deliverable_id
     or v_parent.task_id        is distinct from new.task_id
  then
    raise exception 'comments: a reply must share its parent''s subject'
      using errcode = 'check_violation';
  end if;

  -- One level of nesting. Arbitrary depth turns every thread read into a
  -- recursive CTE and every UI into a rendering problem, for no product gain.
  if v_parent.parent_comment_id is not null then
    raise exception 'comments: threads are limited to one level of replies'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists comments_thread_subject on public.comments;
create trigger comments_thread_subject
  before insert or update of parent_comment_id on public.comments
  for each row execute function growlith.enforce_comment_thread_subject();

-- ---------------------------------------------------------------------------
-- Client users cannot author internal discussion, or comment on tasks
-- ---------------------------------------------------------------------------
-- Schema integrity rather than authorization: `is_internal` is the flag RLS
-- will filter on, so a client-authored internal comment would be a row the
-- author can create but never see.
create or replace function growlith.enforce_comment_author_scope()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_type public.user_type;
begin
  select user_type into v_user_type
  from public.profiles
  where id = new.author_user_id;

  if v_user_type = 'CLIENT' then
    if new.is_internal then
      raise exception 'comments: a client user cannot author an internal comment'
        using errcode = 'check_violation';
    end if;
    if new.task_id is not null then
      raise exception 'comments: tasks are internal; a client user cannot comment on one'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists comments_author_scope on public.comments;
create trigger comments_author_scope
  before insert or update of author_user_id, is_internal, task_id on public.comments
  for each row execute function growlith.enforce_comment_author_scope();

alter table public.comments enable row level security;
alter table public.comments force row level security;
