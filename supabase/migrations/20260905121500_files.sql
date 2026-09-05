-- Migration 15 — files
--
-- One metadata row per Supabase Storage object. Same polymorphism pattern as
-- comments — typed nullable owner columns plus a check — but here at most one
-- owner is required rather than exactly one, because an organization-level
-- asset (a brand logo, a signed contract) legitimately hangs off nothing.
--
-- TWO independent isolation mechanisms guard object access and must agree:
--
--   1. this row's `organization_id`, reached through composite FKs;
--   2. `storage_path`, which MUST begin `{organization_id}/`, checked here and
--      independently enforced by the Storage RLS policy in migration 22.
--
-- If either is bypassed the other still holds. The pgTAP suite asserts they
-- never disagree.

create table if not exists public.files (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  storage_bucket text not null default 'growlith-private',
  storage_path   text not null,

  file_name  text   not null,
  mime_type  text   not null,
  size_bytes bigint not null,
  -- Nullable: computed asynchronously after upload. Enables dedupe and
  -- tamper detection without blocking the upload path.
  checksum_sha256 text,

  file_kind public.file_kind not null default 'ATTACHMENT',
  -- Same inverted default as deliverables: exposure is an act.
  client_visible boolean not null default false,

  uploaded_by uuid not null references public.profiles (id) on delete restrict,

  -- An object is not served until it has been scanned and verified to exist.
  virus_scan_status public.scan_status not null default 'PENDING',
  scanned_at        timestamptz,

  -- Owner columns. At most one.
  project_id             uuid,
  deliverable_id         uuid,
  deliverable_version_id uuid,
  task_id                uuid,
  report_id              uuid,  -- FK added in migration 17
  comment_id             uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete restrict,
  updated_by uuid references public.profiles (id) on delete restrict,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles (id) on delete restrict,

  constraint files_id_org_key unique (id, organization_id),

  constraint files_single_owner
    check (
      num_nonnulls(
        project_id, deliverable_id, deliverable_version_id,
        task_id, report_id, comment_id
      ) <= 1
    ),

  constraint files_project_fkey
    foreign key (project_id, organization_id)
    references public.projects (id, organization_id)
    on update cascade on delete cascade,
  constraint files_deliverable_fkey
    foreign key (deliverable_id, organization_id)
    references public.deliverables (id, organization_id)
    on update cascade on delete cascade,
  constraint files_deliverable_version_fkey
    foreign key (deliverable_version_id, organization_id)
    references public.deliverable_versions (id, organization_id)
    on update cascade on delete cascade,
  constraint files_task_fkey
    foreign key (task_id, organization_id)
    references public.tasks (id, organization_id)
    on update cascade on delete cascade,
  constraint files_comment_fkey
    foreign key (comment_id, organization_id)
    references public.comments (id, organization_id)
    on update cascade on delete cascade,

  constraint files_name_not_blank check (btrim(file_name) <> ''),
  constraint files_mime_not_blank check (btrim(mime_type) <> ''),
  constraint files_size_positive  check (size_bytes > 0),
  constraint files_checksum_shape
    check (checksum_sha256 is null or checksum_sha256 ~ '^[a-f0-9]{64}$'),
  constraint files_scanned_coherent
    check (virus_scan_status = 'PENDING' or scanned_at is not null),
  -- Tenant isolation by path prefix, independent of the row's own FKs.
  constraint files_path_is_org_prefixed
    check (storage_path like (organization_id::text || '/%')),
  constraint files_deleted_by_requires_deleted_at
    check (deleted_by is null or deleted_at is not null)
);

comment on table public.files is
  'Metadata for every Storage object. Isolation is doubly enforced: by '
  'organization_id through composite FKs, and by an org-prefixed storage_path '
  'that the Storage policy independently checks.';
comment on column public.files.storage_path is
  'MUST begin with {organization_id}/. Checked here and mirrored by the '
  'storage.objects policy in migration 22.';

-- One row per object, always.
create unique index if not exists files_storage_object_key
  on public.files (storage_bucket, storage_path);

create index if not exists files_org_created_idx
  on public.files (organization_id, created_at desc)
  where deleted_at is null;

-- Portal file list.
create index if not exists files_org_visible_idx
  on public.files (organization_id, client_visible, created_at desc)
  where deleted_at is null;

create index if not exists files_project_idx
  on public.files (project_id) where project_id is not null and deleted_at is null;
create index if not exists files_deliverable_idx
  on public.files (deliverable_id) where deliverable_id is not null and deleted_at is null;
create index if not exists files_deliverable_version_idx
  on public.files (deliverable_version_id)
  where deliverable_version_id is not null and deleted_at is null;
create index if not exists files_task_idx
  on public.files (task_id) where task_id is not null and deleted_at is null;
create index if not exists files_report_idx
  on public.files (report_id) where report_id is not null and deleted_at is null;
create index if not exists files_comment_idx
  on public.files (comment_id) where comment_id is not null and deleted_at is null;

create index if not exists files_uploaded_by_idx on public.files (uploaded_by);

-- The scan/verification worker queue.
create index if not exists files_pending_scan_idx
  on public.files (created_at)
  where virus_scan_status = 'PENDING' and deleted_at is null;

-- Dedupe and integrity checks.
create index if not exists files_checksum_idx
  on public.files (organization_id, checksum_sha256)
  where checksum_sha256 is not null and deleted_at is null;

create index if not exists files_created_by_idx on public.files (created_by);
create index if not exists files_updated_by_idx on public.files (updated_by);
create index if not exists files_deleted_by_idx on public.files (deleted_by);

drop trigger if exists files_set_updated_at on public.files;
create trigger files_set_updated_at
  before update on public.files
  for each row execute function growlith.set_updated_at();

drop trigger if exists files_freeze_org on public.files;
create trigger files_freeze_org
  before update on public.files
  for each row execute function growlith.freeze_organization_id();

drop trigger if exists files_soft_delete_fields on public.files;
create trigger files_soft_delete_fields
  before insert or update on public.files
  for each row execute function growlith.enforce_soft_delete_fields();

-- ---------------------------------------------------------------------------
-- Deferred FK from migration 06
-- ---------------------------------------------------------------------------
-- `organization_settings.logo_file_id` could not be constrained before `files`
-- existed. SET NULL: deleting the logo must not delete the settings row.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'organization_settings_logo_file_fkey'
  ) then
    alter table public.organization_settings
      add constraint organization_settings_logo_file_fkey
      foreign key (logo_file_id) references public.files (id)
      on delete set null;
  end if;
end
$$;

create index if not exists organization_settings_logo_file_idx
  on public.organization_settings (logo_file_id)
  where logo_file_id is not null;

alter table public.files enable row level security;
alter table public.files force row level security;
