-- Migration 29 — Phase 4 (5/6): the triggers that finish what the policies
-- start. RLS answers "which rows"; these answer the cross-row and cross-column
-- invariants a policy body must not hold (§H.3 rule 1, §D: "Not in RLS, because
-- it is an object rule").

-- ---------------------------------------------------------------------------
-- §13: enforce_status_transition gains the ROLE half.
-- ---------------------------------------------------------------------------
-- Phase 2 seeded status_transitions.allowed_roles and marked it advisory;
-- Phase 4 makes it authoritative in both layers from ONE stored definition —
-- this trigger and the service layer's obligation read consult the same row,
-- which is exactly why this is the one rule allowed to live twice (§0's
-- prohibition targets the MATRIX being copied, not a shared catalogue).
--
-- Resolution order mirrors §2.1: platform role if held; else the caller's
-- ACTIVE organization role in the row's tenant. A NULL role fails closed.
-- When there is no caller at all — migrations, the definer RPCs of
-- migrations 30–31 running their own authority checks, jobs, and the audit
-- trigger — auth.uid() is NULL and the role half is SKIPPED while the
-- legality half keeps running for every writer. This is deliberate: the
-- definer functions are the privileged path by design, and they re-check
-- authority themselves; a trigger that denied them would turn every RPC into
-- two transactions or a second bypass, which is worse for review, not better.

create or replace function growlith.enforce_status_transition()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_entity   constant public.entity_kind := tg_argv[0]::public.entity_kind;
  v_from     text;
  v_to       text;
  v_org      uuid;
  v_role     text;
  v_allowed  text[];
begin
  execute 'select ($1).status::text' into v_from using old;
  execute 'select ($1).status::text' into v_to   using new;

  if v_from is not distinct from v_to then
    return new;
  end if;

  select t.allowed_roles
    into v_allowed
  from public.status_transitions t
  where t.entity_kind = v_entity
    and t.from_status = v_from
    and t.to_status   = v_to;

  if v_allowed is null then
    raise exception '% : % -> % is not a legal transition', v_entity, v_from, v_to
      using errcode = 'check_violation',
            hint = 'See public.status_transitions for the legal set.';
  end if;

  -- The Phase 4 half. Every table this trigger is attached to carries
  -- organization_id (engagements, services, projects, deliverables, tasks,
  -- reports — the ones with a status AND a tenant; profiles' account_status
  -- is transitioned by RPC, not by this machinery).
  if (select auth.uid()) is not null then
    execute 'select ($1).organization_id' into v_org using new;

    v_role := coalesce(
      public.auth_platform_role()::text,
      public.org_role_in(v_org)::text
    );

    if v_role is null or not (v_allowed && array[v_role]) then
      raise exception '% : % -> % is not permitted for role %',
        v_entity, v_from, v_to, coalesce(v_role, 'none')
        using errcode = 'insufficient_privilege',
              hint = 'status_transitions.allowed_roles is authoritative in both layers (authorization.md §13).';
    end if;
  end if;

  return new;
end;
$$;

comment on function growlith.enforce_status_transition() is
  'BEFORE UPDATE OF status. Rejects any transition absent from '
  'status_transitions, for every caller including direct PostgREST writes; '
  'since Phase 4 also rejects transitions whose allowed_roles excludes the '
  'effective role of the caller (platform role, else live org role). Skipped '
  'only when no user context exists (migrations, definer RPCs, jobs) — those '
  'paths re-check authority in their own bodies.';

-- ---------------------------------------------------------------------------
-- §5 rule 1: a task's assignee must hold a LIVE, non-OBSERVER membership on
-- the task's project.
-- ---------------------------------------------------------------------------
-- OBSERVER "satisfies nothing" (§5.1) — assignment is a grant, so the row
-- below must be a real staffing row. Enforced on INSERT and on the assignment
-- columns of UPDATE; status churn on an already-valid assignee must not pay
-- the lookup twice per keystroke.

create or replace function growlith.enforce_task_assignee_membership()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  if new.assignee_user_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.project_memberships pm
    where pm.project_id = new.project_id
      and pm.user_id = new.assignee_user_id
      and pm.deleted_at is null
      and pm.project_role <> 'OBSERVER'
  ) then
    raise exception
      'task assignee % does not hold a live non-OBSERVER membership on project %',
      new.assignee_user_id, new.project_id
      using errcode = 'check_violation',
            hint = 'Staff them via the project membership flow first (authorization.md §5 rule 1).';
  end if;

  return new;
end;
$$;

drop trigger if exists tasks_assignee_project_member on public.tasks;
create trigger tasks_assignee_project_member
  before insert or update of assignee_user_id on public.tasks
  for each row execute function growlith.enforce_task_assignee_membership();

-- ---------------------------------------------------------------------------
-- §5 rule 2 lives in submit_deliverable_review() (migration 31): a version's
-- reviewed_by must be LEAD or REVIEWER on the project. A trigger could not
-- distinguish "which write is a review" — the RPC knows.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- §E.2: the deliverable client-write surface, locked at the column level.
-- ---------------------------------------------------------------------------
-- The UPDATE policy on deliverables (migration 27) already restricts the
-- ROWS a CLIENT_ADMIN may touch; a row policy cannot restrict COLUMNS, and
-- "even that is belt-and-braces, because the approval path is an RPC" is a
-- sentence that deserves a real lock behind it. Non-staff writers of this
-- table may change exactly the approval columns; everything else — title,
-- description, the visibility flag itself, due dates, ownership — is old=new
-- or the transaction ends.

create or replace function growlith.enforce_deliverable_client_columns()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_allowed constant text[] := array[
    'status', 'approved_at', 'approved_by', 'revision_count',
    'updated_at', 'updated_by'
  ];
  v_changed text[];
begin
  if (select auth.uid()) is null or public.is_platform_admin() then
    return new;  -- staff, definer paths and jobs keep the full surface
  end if;

  select array_agg(k)
    into v_changed
  from (
    select jsonb_each_key(to_jsonb(new)) as k
    except
    select jsonb_each_key(to_jsonb(old)) as k
    union all
    select n.key
    from jsonb_each(to_jsonb(new)) n
    join jsonb_each(to_jsonb(old)) o using (key)
    where n.value is distinct from o.value
  ) d
  where d.k <> all (v_allowed);

  if v_changed is not null then
    raise exception
      'a non-staff caller may not change deliverable columns: %',
      array_to_string(v_changed, ', ')
      using errcode = 'insufficient_privilege',
            hint = 'Clients approve through approve_deliverable(); the direct path is the frame, not the door (authorization.md §E.2).';
  end if;

  -- The stamp must be the caller's own: no client may record another
  -- person's approval even inside the columns they are allowed to write.
  if new.approved_by is distinct from old.approved_by
     and new.approved_by <> (select auth.uid()) then
    raise exception 'approved_by may only be set to the caller'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists deliverables_client_column_guard on public.deliverables;
create trigger deliverables_client_column_guard
  before update on public.deliverables
  for each row execute function growlith.enforce_deliverable_client_columns();

-- ---------------------------------------------------------------------------
-- §E.2 row 2: "update/soft-delete their own uploads" — rename/reclassify,
-- nothing else. Same shape as the deliverable guard: the files_update_self
-- policy scopes the ROWS; this scopes the COLUMNS (client_visible, the scan
-- fields, the parent links, size, MIME — flipping any of those from the client
-- side would drive the visibility policies with the policies' own inputs).
-- ---------------------------------------------------------------------------

create or replace function growlith.enforce_file_uploader_columns()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_allowed constant text[] := array[
    'file_name', 'file_kind', 'deleted_at', 'deleted_by',
    'updated_at', 'updated_by'
  ];
  v_changed text[];
begin
  if (select auth.uid()) is null or public.is_platform_admin() then
    return new;
  end if;

  select array_agg(k)
    into v_changed
  from (
    select jsonb_each_key(to_jsonb(new)) as k
    except
    select jsonb_each_key(to_jsonb(old)) as k
    union all
    select n.key
    from jsonb_each(to_jsonb(new)) n
    join jsonb_each(to_jsonb(old)) o using (key)
    where n.value is distinct from o.value
  ) d
  where d.k <> all (v_allowed);

  if v_changed is not null then
    raise exception
      'an uploader may not change file columns: %',
      array_to_string(v_changed, ', ')
      using errcode = 'insufficient_privilege',
            hint = 'client_visible and the scan fields are staff- and job-controlled (authorization.md §E, files).';
  end if;

  return new;
end;
$$;

drop trigger if exists files_uploader_column_guard on public.files;
create trigger files_uploader_column_guard
  before update on public.files
  for each row execute function growlith.enforce_file_uploader_columns();

-- ---------------------------------------------------------------------------
-- The one write-side rule of §6 that a policy cannot express: a client's
-- comment is never internal. enforce_comment_author_scope() (Phase 2) already
-- refuses client-authored comments on tasks and pins the author; the
-- is_internal floor completes the trio at the write boundary so the client
-- READ policy's `not is_internal` can never be fed a row whose flag was set
-- by the client themselves.
-- ---------------------------------------------------------------------------

create or replace function growlith.enforce_comment_client_internal_floor()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  if (select auth.uid()) is not null
     and not public.is_platform_admin()
     and new.is_internal
  then
    raise exception 'a client-authored comment cannot be internal'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists comments_client_internal_floor on public.comments;
create trigger comments_client_internal_floor
  before insert or update of is_internal on public.comments
  for each row execute function growlith.enforce_comment_client_internal_floor();
