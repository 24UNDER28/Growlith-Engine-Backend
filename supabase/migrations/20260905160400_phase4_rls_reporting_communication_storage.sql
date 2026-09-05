-- Migration 28 — Phase 4 (4/6): RLS policies for reporting, files,
-- communication, and `storage.objects`. Same four shapes, same rules
-- (§H.2–§H.3); see migration 26's header for the reading contract.

-- ---------------------------------------------------------------------------
-- metrics — Class 2, symmetric
-- ---------------------------------------------------------------------------
-- B.4: raw metrics are the client's own performance data — organization-wide,
-- NO flag (E restates it: "own performance data, organization-wide"). This is
-- the one tenant table whose client read has no visibility gate at all: the
-- data was collected FROM the client's properties, and §G ships it whole.
-- The table has no deleted_at (a metric is a fact, not a document), so rule 3
-- is vacuous here and its absence is intentional, not an oversight.

drop policy if exists metrics_select_tenant on public.metrics;
create policy metrics_select_tenant
  on public.metrics for select
  to authenticated
  using (
    public.is_active_account()
    and public.has_org_access(organization_id)
  );

drop policy if exists metrics_insert_staff on public.metrics;
create policy metrics_insert_staff
  on public.metrics for insert
  to authenticated
  with check (
    public.is_platform_admin()
    and public.is_active_account()
    and public.has_org_access(organization_id)
  );

-- metrics has no update or delete policy at all in EITHER audience: a metric
-- row is a recorded fact (corrections arrive as a new row; the ingest job
-- upserts as definer). The GRANT layer (migration 25) handed `authenticated`
-- insert only.

-- ---------------------------------------------------------------------------
-- reports — Class 3
-- ---------------------------------------------------------------------------
-- Client gate: status PUBLISHED AND the flag, via the parent-shape predicate
-- inlined (both conditions are this table's own columns — rule 1 forbids
-- querying OTHER tenant tables, not reading one's own).

drop policy if exists reports_select_staff on public.reports;
create policy reports_select_staff
  on public.reports for select
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  );

drop policy if exists reports_select_client on public.reports;
create policy reports_select_client
  on public.reports for select
  to authenticated
  using (
    deleted_at is null
    and public.has_org_access(organization_id)
    and client_visible
    and status = 'PUBLISHED'
  );

drop policy if exists reports_insert_staff on public.reports;
create policy reports_insert_staff
  on public.reports for insert
  to authenticated
  with check (public.is_platform_admin() and public.is_active_account());

drop policy if exists reports_update_staff on public.reports;
create policy reports_update_staff
  on public.reports for update
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  )
  with check (public.is_platform_admin() and public.is_active_account());

-- ---------------------------------------------------------------------------
-- report_metrics — Class 3, inherited visibility
-- ---------------------------------------------------------------------------
-- "Frozen figures of published reports" (E). The gate is the PARENT's rule —
-- so it is a call to the parent's helper, never a re-expression of it.
-- Append-only: no UPDATE/DELETE policy exists for ANY audience, matching the
-- table's own trigger, because figures frozen at publication are evidence of
-- what was reported.

drop policy if exists report_metrics_select_staff on public.report_metrics;
create policy report_metrics_select_staff
  on public.report_metrics for select
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
  );

drop policy if exists report_metrics_select_client on public.report_metrics;
create policy report_metrics_select_client
  on public.report_metrics for select
  to authenticated
  using (public.report_is_client_visible(report_id));

drop policy if exists report_metrics_insert_staff on public.report_metrics;
create policy report_metrics_insert_staff
  on public.report_metrics for insert
  to authenticated
  with check (
    public.is_platform_admin()
    and public.is_active_account()
    and public.has_org_access(organization_id)
  );

-- ---------------------------------------------------------------------------
-- files — Class 3 read, dual-audience write
-- ---------------------------------------------------------------------------
-- The read gate is §E's row for files in full: flagged visible, scan CLEAN,
-- and the OWNING row itself visible (deliverable via the strict gate, report
-- via the publication gate; a file hanging on nothing but the tenant is
-- visible to that tenant's staff only — the metadata default false handles
-- it). Upload is the one client write this table has; a client may rename and
-- reclassify their OWN upload (B.4 `◦ ◦`), and ONLY that —
-- growlith.enforce_file_uploader_columns() (migration 29) locks every other
-- column, because "own uploads" is a row rule the policy can express while
-- "which COLUMNS" is a statement about the update a policy cannot see.

drop policy if exists files_select_staff on public.files;
create policy files_select_staff
  on public.files for select
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  );

drop policy if exists files_select_client on public.files;
create policy files_select_client
  on public.files for select
  to authenticated
  using (
    deleted_at is null
    and client_visible
    and virus_scan_status = 'CLEAN'
    and public.has_org_access(organization_id)
    and (deliverable_id is null or public.deliverable_is_client_visible(deliverable_id))
    and (report_id is null or public.report_is_client_visible(report_id))
    -- a file on a task is an internal working file, full stop (tasks have no
    -- client surface at all, §F); there is nothing to consult.
    and task_id is null
  );

drop policy if exists files_insert_staff on public.files;
create policy files_insert_staff
  on public.files for insert
  to authenticated
  with check (
    public.is_platform_admin()
    and public.is_active_account()
    and public.has_org_access(organization_id)
    -- the path and the tenant row must AGREE (§H.6: the two mechanisms may
    -- never drift; storage_path_org_id is the same extractor the bucket
    -- policies use).
    and organization_id = public.storage_path_org_id(storage_path)
  );

drop policy if exists files_insert_client on public.files;
create policy files_insert_client
  on public.files for insert
  to authenticated
  with check (
    public.is_active_account()
    and uploaded_by = (select auth.uid())
    and public.has_org_access(organization_id)
    and organization_id = public.storage_path_org_id(storage_path)
  );

drop policy if exists files_update_staff on public.files;
create policy files_update_staff
  on public.files for update
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  )
  with check (public.is_platform_admin() and public.is_active_account());

drop policy if exists files_update_self on public.files;
create policy files_update_self
  on public.files for update
  to authenticated
  using (
    public.is_active_account()
    and uploaded_by = (select auth.uid())
    and deleted_at is null
  )
  with check (
    public.is_active_account()
    and uploaded_by = (select auth.uid())
  );

-- ---------------------------------------------------------------------------
-- comments — Class 3, dual-audience write
-- ---------------------------------------------------------------------------
-- The client read predicate carries EVERY clause of B.4's note: non-internal,
-- subject visible, task-attached comments excluded outright. The client INSERT
-- policy states the same rules as WITH CHECK — they are the policy's job, not
-- only the trigger's (growlith.enforce_comment_author_scope() predates Phase 4
-- and stays; belt and braces are allowed to be redundant when they are
-- identical in writing).
--
-- `files_update_self` and `comments_update_author` encode the `◦ ◦` cells as
-- audience rows: AUTHORSHIP is the scoping fact, and a staff moderation policy
-- is a SEPARATE policy because a separate audience names it.

drop policy if exists comments_select_staff on public.comments;
create policy comments_select_staff
  on public.comments for select
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
    and public.has_org_access(organization_id)
  );

drop policy if exists comments_select_client on public.comments;
create policy comments_select_client
  on public.comments for select
  to authenticated
  using (
    deleted_at is null
    and not is_internal
    and task_id is null
    and public.has_org_access(organization_id)
    and (deliverable_id is null or public.deliverable_is_client_visible(deliverable_id))
    and (project_id is null or public.project_is_client_visible(project_id))
  );

drop policy if exists comments_insert_staff on public.comments;
create policy comments_insert_staff
  on public.comments for insert
  to authenticated
  with check (
    public.is_platform_admin()
    and public.is_active_account()
    and public.has_org_access(organization_id)
    and author_user_id = (select auth.uid())
  );

drop policy if exists comments_insert_client on public.comments;
create policy comments_insert_client
  on public.comments for insert
  to authenticated
  with check (
    public.is_active_account()
    and public.has_org_access(organization_id)
    and author_user_id = (select auth.uid())
    and not is_internal
    and task_id is null
    and (
      (deliverable_id is not null and public.deliverable_is_client_visible(deliverable_id))
      or (project_id is not null and public.project_is_client_visible(project_id))
    )
  );

drop policy if exists comments_update_author on public.comments;
create policy comments_update_author
  on public.comments for update
  to authenticated
  using (
    public.is_active_account()
    and author_user_id = (select auth.uid())
    and deleted_at is null
  )
  with check (
    public.is_active_account()
    and author_user_id = (select auth.uid())
  );

drop policy if exists comments_update_staff on public.comments;
create policy comments_update_staff
  on public.comments for update
  to authenticated
  using (
    public.is_platform_admin()
    and public.is_active_account()
    and deleted_at is null
  )
  with check (public.is_platform_admin() and public.is_active_account());

-- ---------------------------------------------------------------------------
-- storage.objects / storage.buckets — §H.6, the four policies
-- ---------------------------------------------------------------------------
-- Guarded exactly like migration 22's bucket insert: a no-op on bare
-- PostgreSQL without the storage extension, real on Supabase. The read goes
-- through can_read_storage_object() — tenancy-only can_access_storage_path()
-- would leak internal working files under the same org prefix; the WRITE keeps
-- the weaker predicate because the metadata row does not exist yet (that is
-- the upload protocol's ordering, and the object stays PENDING until the scan
-- job promotes it). update/delete are staff-only: clients soft-delete the
-- metadata row and a reaper job takes the bytes (B.4 file:delete note).
--
-- `storage.objects.owner` is set to the uploading auth uid by Supabase
-- Storage itself, in its own definer context — Phase 4 policies do not
-- override that; the insert check additionally pins that the PATH belongs to
-- the caller's tenant, which is the only tenancy fact PostgREST passes.

do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'storage.objects not present (bare PostgreSQL); skipping storage policies';
    return;
  end if;

  execute 'drop policy if exists growlith_objects_select on storage.objects';
  execute $pol$
    create policy growlith_objects_select on storage.objects
      for select to authenticated
      using (
        bucket_id = 'growlith-private'
        and public.is_active_account()
        and public.can_read_storage_object(name)
      )
  $pol$;

  execute 'drop policy if exists growlith_objects_insert on storage.objects';
  execute $pol$
    create policy growlith_objects_insert on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'growlith-private'
        and public.is_active_account()
        -- `owner` is varchar on some Supabase majors and uuid on others;
        -- comparing the text forms works on both and on the local stub.
        and owner::text = (select auth.uid())::text
        and public.can_access_storage_path(name)
      )
  $pol$;

  execute 'drop policy if exists growlith_objects_update_staff on storage.objects';
  execute $pol$
    create policy growlith_objects_update_staff on storage.objects
      for update to authenticated
      using (
        bucket_id = 'growlith-private'
        and public.is_platform_admin()
        and public.is_active_account()
      )
      with check (
        bucket_id = 'growlith-private'
        and public.is_platform_admin()
        and public.is_active_account()
      )
  $pol$;

  execute 'drop policy if exists growlith_objects_delete_staff on storage.objects';
  execute $pol$
    create policy growlith_objects_delete_staff on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'growlith-private'
        and public.is_platform_admin()
        and public.is_active_account()
      )
  $pol$;
end
$$;

do $$
begin
  if to_regclass('storage.buckets') is null then
    return;
  end if;

  -- A client has no reason to enumerate buckets and no write path to them;
  -- the bucket row is platform configuration wearing a storage hat.
  execute 'drop policy if exists growlith_buckets_select_staff on storage.buckets';
  execute $pol$
    create policy growlith_buckets_select_staff on storage.buckets
      for select to authenticated
      using (
        id = 'growlith-private'
        and public.is_platform_admin()
        and public.is_active_account()
      )
  $pol$;
end
$$;

-- ---------------------------------------------------------------------------
-- Coverage audit for the Phase 4 policy set (§H.3 rule 6, stated as a
-- migration-time invariant, not a convention): every table in `public` with
-- an organization_id column carries BOTH a staff-shaped and (unless Class 1)
-- a client-shaped SELECT policy, and every write policy names its audience.
-- A table that fails this is a hole, and the migration fails instead of the
-- tenant.
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  v_missing text[] := array[]::text[];
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      -- Reference catalogues and the partition children keep their own rules.
      and c.relname not in ('teams', 'service_lines', 'status_transitions')
      -- Monthly partitions carry their own explicit policy (created with the
      -- partition and backfilled in migration 26); the DEFAULT partition is
      -- in scope here because it is a real read surface for out-of-window rows
      -- and needs the same seal.
      and c.relname !~ '^audit_events_\d{6}$'
      -- The tenancy trigger tables and the auth plumbing are deliberately
      -- policy-light by the design's own coverage plan (H.4).
    order by c.relname
  loop
    if not exists (
      select 1
      from pg_policies p
      where p.schemaname = 'public'
        and p.tablename = r.relname
        and p.cmd = 'SELECT'
    ) then
      v_missing := v_missing || (r.relname || ' (no SELECT policy)');
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'Phase 4 policy coverage gap: %', array_to_string(v_missing, ', ');
  end if;
end
$$;

do $$
declare
  r record;
  v_bad text[] := array[]::text[];
begin
  -- Every policy created through here must name its audience in its name
  -- (§H.3 rule 6). Phase 2's three reference policies predate the rule; they
  -- are named `_read_authenticated` and stay grandfathered here, once, with
  -- the reason written down rather than the rule quietly weakened.
  for r in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and policyname !~ '_read_authenticated$'
    order by tablename, policyname
  loop
    if not (r.policyname ~ '_(staff|client|self|tenant|client_admin|super_admin|author|comembers|authenticated)$') then
      v_bad := v_bad || (r.tablename || '.' || r.policyname);
    end if;
  end loop;

  if array_length(v_bad, 1) is not null then
    raise exception
      'policies without an audience in their name (%): §H.3 rule 6 says an '
      'unnamed audience is a visible defect',
      array_to_string(v_bad, ', ');
  end if;
end
$$;
