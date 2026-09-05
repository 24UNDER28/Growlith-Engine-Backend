-- Migration 24 — index every remaining foreign key
--
-- Found by `scripts/db-verify.mjs`, which walks pg_constraint and asserts that
-- each foreign key's columns are the leading columns of some index.
--
-- The gap was systematic and easy to miss: the earlier migrations indexed the
-- single FK column (`tasks.project_id`), but the FK itself is COMPOSITE —
-- `(project_id, organization_id)`. PostgreSQL uses an index for a referential
-- action only when the FK's columns are the index's leading columns as a set,
-- and `(project_id)` alone does not satisfy `(project_id, organization_id)`.
--
-- Why it matters: every `on delete cascade` and `on update cascade` down the
-- hierarchy has to find the child rows. Without a matching index that is a
-- sequential scan of the child table per parent row deleted. Deleting one
-- engagement would scan services, projects, deliverables, tasks, comments and
-- files end to end.
--
-- These are NOT partial. A referential-integrity check must see soft-deleted
-- rows too — a child with `deleted_at set` still references its parent, and a
-- partial index would silently exclude exactly the rows the cascade needs.

-- Hierarchy composite FKs
create index if not exists services_engagement_org_idx
  on public.services (engagement_id, organization_id);

create index if not exists projects_service_org_idx
  on public.projects (service_id, organization_id);

create index if not exists project_memberships_project_org_idx
  on public.project_memberships (project_id, organization_id);

create index if not exists deliverables_project_org_idx
  on public.deliverables (project_id, organization_id);

create index if not exists deliverable_versions_deliverable_org_idx
  on public.deliverable_versions (deliverable_id, organization_id);

create index if not exists tasks_project_org_idx
  on public.tasks (project_id, organization_id);

create index if not exists tasks_deliverable_org_idx
  on public.tasks (deliverable_id, organization_id);

-- Comments: one per polymorphic subject, plus the thread parent.
create index if not exists comments_project_org_idx
  on public.comments (project_id, organization_id);
create index if not exists comments_deliverable_org_idx
  on public.comments (deliverable_id, organization_id);
create index if not exists comments_task_org_idx
  on public.comments (task_id, organization_id);
create index if not exists comments_parent_org_idx
  on public.comments (parent_comment_id, organization_id);

-- Files: one per owner column.
create index if not exists files_project_org_idx
  on public.files (project_id, organization_id);
create index if not exists files_deliverable_org_idx
  on public.files (deliverable_id, organization_id);
create index if not exists files_deliverable_version_org_idx
  on public.files (deliverable_version_id, organization_id);
create index if not exists files_task_org_idx
  on public.files (task_id, organization_id);
create index if not exists files_report_org_idx
  on public.files (report_id, organization_id);
create index if not exists files_comment_org_idx
  on public.files (comment_id, organization_id);

-- Reporting
create index if not exists reports_engagement_org_idx
  on public.reports (engagement_id, organization_id);
create index if not exists reports_service_org_idx
  on public.reports (service_id, organization_id);
create index if not exists report_metrics_report_org_idx
  on public.report_metrics (report_id, organization_id);
create index if not exists metrics_service_org_idx
  on public.metrics (service_id, organization_id);

-- Single-column FK missed earlier: service_lines is RESTRICT-referenced, so
-- deactivating a line has to check this column.
create index if not exists metrics_service_line_idx
  on public.metrics (service_line)
  where service_line is not null;

-- ---------------------------------------------------------------------------
-- Assertion: no unindexed foreign key survives this migration
-- ---------------------------------------------------------------------------
-- The same rule the verification script applies, enforced here so a future
-- migration that adds a FK without an index fails immediately rather than
-- degrading a cascade months later.
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
        -- pg_index.indkey is an int2vector; cast to int2[] it is ZERO-based,
        -- so the leading N columns are the slice [0 : N-1].
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
