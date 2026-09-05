-- Migration 32 — Phase 4 (7/6): authorization hardening.
--
-- Two defects, each found by EXECUTION (scripts/db-authz-attack.mjs), not by
-- reading the source. Both are the kind of hole that looks correct on paper
-- and only shows its teeth when a malicious CLIENT actually runs the attack.
--
-- 1. NULL-UNSAFE AUTHORITY PREDICATES (critical)
--
-- `is_super_admin()` and `is_client_admin_of()` answered a three-valued
-- question with a two-valued idiom. Their bodies are
--
--     select public.auth_platform_role() = 'SUPER_ADMIN';      -- NULL for a client
--     select public.org_role_in(p_organization_id) = 'CLIENT_ADMIN';  -- NULL for a non-member
--
-- A caller with NO matching grant therefore evaluated the predicate to NULL,
-- not FALSE — and the definer RPCs guard with
--
--     if not public.is_super_admin() then raise ... end if;
--     if not public.is_client_admin_of(v_row.organization_id) then raise ... end if;
--
-- In PL/pgSQL, `IF NOT NULL` is NULL, and a NULL condition is treated as
-- "not true" — so the guard was SKIPPED for exactly the caller it exists to
-- stop. Confirmed by execution before this migration:
--
--   * a CLIENT called grant_platform_role() and granted SUPER_ADMIN;
--   * a CLIENT called revoke_platform_role() and revoked an ADMIN;
--   * a CLIENT called erase_user() and erased another user's identity;
--   * a CLIENT called add_organization_member() into another organization;
--   * purge_organization()/approve_deliverable() guards were skipped the same way.
--
-- The fix keeps the predicate vocabulary identical but makes the answer
-- two-valued, so every existing guard (and every future one) is NULL-proof
-- at the source:
--
--     select coalesce(public.auth_platform_role() = 'SUPER_ADMIN', false);
--     select coalesce(public.org_role_in(p_organization_id) = 'CLIENT_ADMIN', false);
--
-- Nothing else in the predicate set needs this: is_platform_admin() and
-- is_active_account() return booleans by construction, has_org_access() ORs a
-- boolean with `= any(...)` (false on an empty array), and the visibility
-- helpers all end in EXISTS.

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(public.auth_platform_role() = 'SUPER_ADMIN', false);
$$;

create or replace function public.is_client_admin_of(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(public.org_role_in(p_organization_id) = 'CLIENT_ADMIN', false);
$$;

-- ---------------------------------------------------------------------------
-- 2. CLIENT FILE-INSERT COLUMN GUARD
-- ---------------------------------------------------------------------------
-- `files_update_self` + growlith.enforce_file_uploader_columns() lock the
-- COLUMNS a client may change on their own upload (rename/reclassify only —
-- client_visible and the scan fields are staff- and job-controlled). The
-- INSERT path had no twin: a client could post a metadata row with
-- `client_visible = true` and `virus_scan_status = 'CLEAN'` directly, so the
-- visibility policies (which AND `client_visible` and `virus_scan_status =
-- 'CLEAN'`) would be driven by the very party they are supposed to gate.
-- Confirmed by execution: a CLIENT insert with forged CLEAN+visible flags
-- landed and became tenant-visible.
--
-- A client upload therefore now lands PENDING and invisible no matter what
-- the caller posted — the same "the column is not client input" stance as
-- growlith.derive_organization_id(). The scan job and staff promotion paths
-- (definer) are unaffected: this trigger returns early for the migration
-- owner, jobs and platform staff.

create or replace function growlith.enforce_file_uploader_insert_columns()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  if (select auth.uid()) is null or public.is_platform_admin() then
    return new;
  end if;

  new.client_visible    := false;
  new.virus_scan_status := 'PENDING';
  new.scanned_at        := null;
  new.checksum_sha256   := null;

  return new;
end;
$$;

drop trigger if exists files_uploader_insert_guard on public.files;
create trigger files_uploader_insert_guard
  before insert on public.files
  for each row execute function growlith.enforce_file_uploader_insert_columns();

-- ---------------------------------------------------------------------------
-- 3. NONEXISTENT FUNCTION: jsonb_each_key()
-- ---------------------------------------------------------------------------
-- The two column-lock triggers from migration 29 call jsonb_each_key(jsonb).
-- PostgreSQL has NO such function — jsonb_each() yields (key, value) pairs and
-- jsonb_object_keys() yields the keys. The PL/pgSQL bodies compiled (function
-- bodies are not name-resolved at CREATE time) but raised
--   function jsonb_each_key(jsonb) does not exist
-- the moment a trigger fired. Confirmed by execution: every client UPDATE on
-- deliverables and files errored out, so the column lock was enforcing
-- "nothing may change" rather than "only the approval/rename columns may
-- change" — and the legitimate CLIENT_ADMIN approval path was bricked along
-- with it. Rewritten with jsonb_object_keys(), which returns the same set of
-- keys as text.

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
    select jsonb_object_keys(to_jsonb(new)) as k
    except
    select jsonb_object_keys(to_jsonb(old)) as k
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
    select jsonb_object_keys(to_jsonb(new)) as k
    except
    select jsonb_object_keys(to_jsonb(old)) as k
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

-- ---------------------------------------------------------------------------
-- 4. purge_organization() format() TYPO
-- ---------------------------------------------------------------------------
-- The audit reason used format('organization % (%s) purged', ...): a `%`
-- followed by a space is an unrecognized format() type specifier, so the
-- ONLY SUPER_ADMIN purge path died at the audit line (fail-closed, but dead).
-- `% ` -> `%s `. Recreated so the path exists again.
-- ---------------------------------------------------------------------------

create or replace function public.purge_organization(p_organization_id uuid, p_confirm_slug text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_row public.organizations;
begin
  if not public.is_super_admin() then
    raise exception 'purge_organization: SUPER_ADMIN only'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.organizations o where o.id = p_organization_id;
  if not found then
    raise exception 'purge_organization: no organization %', p_organization_id
      using errcode = 'no_data_found';
  end if;

  if lower(btrim(p_confirm_slug)) <> lower(v_row.slug::text) then
    raise exception 'purge_organization: confirmation slug % does not match %',
      p_confirm_slug, v_row.slug
      using errcode = 'check_violation';
  end if;

  perform growlith.phase4_audit(
    v_row.id, 'organization', v_row.id, 'HARD_DELETE', 'CRITICAL',
    format('organization %s (%s) purged', v_row.slug, v_row.id),
    to_jsonb(v_row),
    null
  );

  perform set_config('growlith.allow_purge', 'on', true);

  delete from public.notifications        where organization_id = p_organization_id;
  delete from public.comments             where organization_id = p_organization_id;
  delete from public.files                where organization_id = p_organization_id;
  delete from public.deliverable_versions v
    using public.deliverables d where v.deliverable_id = d.id and d.organization_id = p_organization_id;
  delete from public.tasks t              using public.projects p where t.project_id = p.id and p.organization_id = p_organization_id;
  delete from public.tasks                where organization_id = p_organization_id;
  delete from public.deliverables         where organization_id = p_organization_id;
  delete from public.project_memberships  where organization_id = p_organization_id;
  delete from public.projects             where organization_id = p_organization_id;
  delete from public.report_metrics       where organization_id = p_organization_id;
  delete from public.reports              where organization_id = p_organization_id;
  delete from public.metrics              where organization_id = p_organization_id;
  delete from public.services             where organization_id = p_organization_id;
  delete from public.engagements          where organization_id = p_organization_id;
  delete from public.invitations          where organization_id = p_organization_id;
  delete from public.organization_settings where organization_id = p_organization_id;
  delete from public.organization_memberships where organization_id = p_organization_id;
  delete from public.organizations        where id = p_organization_id;

  perform set_config('growlith.allow_purge', 'off', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. approve_deliverable() enum coercion
-- ---------------------------------------------------------------------------
-- The notification insert built notification_type with a CASE expression:
--   case p_outcome when 'APPROVED' then 'DELIVERABLE_APPROVED'
--                  else 'REVISION_REQUESTED' end
-- A CASE whose branches are all untyped literals resolves to TEXT, and
-- assigning text to the notification_type enum raises
--   column "notification_type" is of type notification_type but expression is
--   of type text
-- — so the sanctioned CLIENT_ADMIN approval path (the only client-driven
-- transition in the system) threw and rolled back AFTER the authority checks,
-- bricking the legitimate flow. Confirmed by execution, not by inspection.
-- The cast makes the branch resolution explicit. Recreated wholesale (the
-- migration set is forward-only).

create or replace function public.approve_deliverable(
  p_deliverable_id uuid,
  p_outcome        public.review_outcome,
  p_notes          text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_caller   uuid := (select auth.uid());
  v_is_staff boolean := public.is_platform_admin();
  v_row      public.deliverables;
  v_new_status public.deliverable_status;
begin
  if v_caller is null then
    raise exception 'approve_deliverable: authentication required'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.deliverables d
   where d.id = p_deliverable_id and d.deleted_at is null
   for update;
  if not found then
    raise exception 'approve_deliverable: no live deliverable %', p_deliverable_id
      using errcode = 'no_data_found';
  end if;

  if not v_is_staff and not public.is_client_admin_of(v_row.organization_id) then
    raise exception 'approve_deliverable: reserved for the client administrator of the owning organization and internal staff'
      using errcode = 'insufficient_privilege';
  end if;
  if not v_is_staff and not public.is_active_account() then
    raise exception 'approve_deliverable: account is not active'
      using errcode = 'insufficient_privilege';
  end if;

  if v_row.status <> 'CLIENT_REVIEW' then
    raise exception 'approve_deliverable: % is %, not CLIENT_REVIEW', v_row.id, v_row.status
      using errcode = 'check_violation',
            hint = 'Only a deliverable awaiting client review can be decided.';
  end if;

  if p_outcome = 'REJECTED' and not v_is_staff then
    raise exception 'approve_deliverable: a client decision is APPROVED or REVISION_REQUESTED; REJECTED is an internal review outcome'
      using errcode = 'check_violation';
  end if;

  if p_outcome in ('REVISION_REQUESTED', 'REJECTED')
     and btrim(coalesce(p_notes, '')) = '' then
    raise exception 'approve_deliverable: % requires notes', p_outcome
      using errcode = 'check_violation',
            hint = 'status_transitions.requires_reason is true for this edge; the reason is the review.';
  end if;

  v_new_status := case p_outcome
    when 'APPROVED'           then 'APPROVED'
    when 'REVISION_REQUESTED' then 'REVISION_REQUESTED'
    when 'REJECTED'           then 'REVISION_REQUESTED'
  end;

  update public.deliverables d
     set status           = v_new_status,
         approved_at      = case when p_outcome = 'APPROVED' then now() else d.approved_at end,
         approved_by      = case when p_outcome = 'APPROVED' then v_caller else d.approved_by end,
         revision_count   = case when p_outcome = 'APPROVED' then d.revision_count else d.revision_count + 1 end,
         updated_at       = now(),
         updated_by       = v_caller
   where d.id = v_row.id;

  if v_new_status = 'REVISION_REQUESTED' then
    insert into public.deliverable_versions (
      organization_id, deliverable_id, version_number, status,
      submitted_by, reviewed_by, reviewed_at, review_outcome, review_notes
    ) values (
      v_row.organization_id, v_row.id,
      (select coalesce(max(v.version_number), 0) + 1
         from public.deliverable_versions v where v.deliverable_id = v_row.id),
      'REVISION_REQUESTED',
      null, v_caller, now(), p_outcome, left(btrim(p_notes), 4096)
    );
  end if;

  if v_row.owner_user_id is not null and v_row.owner_user_id <> v_caller then
    insert into public.notifications (
      recipient_user_id, organization_id, notification_type, severity,
      title, body, subject_entity, subject_id
    ) values (
      v_row.owner_user_id, v_row.organization_id,
      (case p_outcome when 'APPROVED' then 'DELIVERABLE_APPROVED'
                      else 'REVISION_REQUESTED' end)::public.notification_type,
      'INFO',
      format('Client %s: %s',
             case p_outcome when 'APPROVED' then 'approved' else 'requested revisions on' end,
             v_row.title),
      nullif(left(btrim(coalesce(p_notes, '')), 2048), ''),
      'deliverable', v_row.id
    );
  end if;

  perform growlith.phase4_audit(
    v_row.organization_id, 'deliverable', v_row.id, 'STATUS_CHANGE', 'NOTICE',
    format('deliverable %s: client review outcome %s%s',
           v_row.id, p_outcome,
           case when p_notes is not null and btrim(p_notes) <> ''
                then ' — ' || left(btrim(p_notes), 300) else '' end),
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('status', v_new_status, 'outcome', p_outcome::text)
  );
end;
$$;
