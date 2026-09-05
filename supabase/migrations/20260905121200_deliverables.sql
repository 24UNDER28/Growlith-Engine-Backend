-- Migration 12 — deliverables and deliverable_versions
--
-- The deliverable is the unit the client actually judges, and it carries the
-- review/approval workflow. `deliverable_versions` is the immutable history of
-- that workflow: storing only `current_version` would keep the number and lose
-- the evidence, which is precisely what a contract dispute asks for.

create table if not exists public.deliverables (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id      uuid not null,

  title            text not null,
  description      text,
  deliverable_type public.deliverable_type   not null,
  status           public.deliverable_status not null default 'DRAFT',

  -- Default FALSE, deliberately inverted from projects: exposing work to a
  -- client must be an act, never an oversight.
  client_visible boolean not null default false,

  current_version integer not null default 1,
  revision_count  integer not null default 0,

  due_date     date,
  submitted_at timestamptz,
  approved_at  timestamptz,
  -- RESTRICT: the identity of the approver is the value of the approval.
  approved_by  uuid references public.profiles (id) on delete restrict,

  owner_user_id uuid references public.profiles (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete restrict,
  updated_by uuid references public.profiles (id) on delete restrict,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles (id) on delete restrict,

  constraint deliverables_id_org_key unique (id, organization_id),

  constraint deliverables_project_fkey
    foreign key (project_id, organization_id)
    references public.projects (id, organization_id)
    on update cascade on delete cascade,

  constraint deliverables_title_not_blank check (btrim(title) <> ''),
  constraint deliverables_current_version_positive check (current_version >= 1),
  constraint deliverables_revision_count_non_negative check (revision_count >= 0),

  -- An approval without an approver and a timestamp is not an approval.
  constraint deliverables_approved_requires_approver
    check (
      status <> 'APPROVED'
      or (approved_at is not null and approved_by is not null)
    ),
  -- Anything past DRAFT has been submitted at least once.
  constraint deliverables_submitted_requires_timestamp
    check (
      status in ('DRAFT', 'IN_PROGRESS', 'CANCELLED')
      or submitted_at is not null
    ),
  -- A deliverable cannot be under client review, approved or published while
  -- invisible to the client. This closes the "the client approved something
  -- they could not see" contradiction at the schema level.
  constraint deliverables_client_states_require_visibility
    check (
      status not in ('CLIENT_REVIEW', 'REVISION_REQUESTED', 'APPROVED', 'PUBLISHED')
      or client_visible
    ),
  constraint deliverables_deleted_by_requires_deleted_at
    check (deleted_by is null or deleted_at is not null)
);

comment on table public.deliverables is
  'A concrete output presented to the client. Versioned, and carries the '
  'review/approval workflow. client_visible defaults FALSE by design.';

create index if not exists deliverables_org_status_idx
  on public.deliverables (organization_id, status)
  where deleted_at is null;

create index if not exists deliverables_project_idx
  on public.deliverables (project_id)
  where deleted_at is null;

-- THE client portal query: what can this organization see, and in what state.
create index if not exists deliverables_portal_idx
  on public.deliverables (organization_id, client_visible, status)
  where deleted_at is null;

-- Outstanding deliverables by due date.
create index if not exists deliverables_org_due_open_idx
  on public.deliverables (organization_id, due_date)
  where deleted_at is null
    and status not in ('APPROVED', 'PUBLISHED', 'CANCELLED')
    and due_date is not null;

create index if not exists deliverables_owner_idx
  on public.deliverables (owner_user_id)
  where deleted_at is null and owner_user_id is not null;

create index if not exists deliverables_approved_by_idx on public.deliverables (approved_by);
create index if not exists deliverables_created_by_idx  on public.deliverables (created_by);
create index if not exists deliverables_updated_by_idx  on public.deliverables (updated_by);
create index if not exists deliverables_deleted_by_idx  on public.deliverables (deleted_by);

drop trigger if exists deliverables_set_updated_at on public.deliverables;
create trigger deliverables_set_updated_at
  before update on public.deliverables
  for each row execute function growlith.set_updated_at();

drop trigger if exists deliverables_derive_org on public.deliverables;
create trigger deliverables_derive_org
  before insert on public.deliverables
  for each row execute function growlith.derive_organization_id('project_id', 'public.projects');

drop trigger if exists deliverables_freeze_org on public.deliverables;
create trigger deliverables_freeze_org
  before update on public.deliverables
  for each row execute function growlith.freeze_organization_id();

drop trigger if exists deliverables_soft_delete_fields on public.deliverables;
create trigger deliverables_soft_delete_fields
  before insert or update on public.deliverables
  for each row execute function growlith.enforce_soft_delete_fields();

alter table public.deliverables enable row level security;
alter table public.deliverables force row level security;

-- ===========================================================================
-- deliverable_versions — append-only
-- ===========================================================================
create table if not exists public.deliverable_versions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  deliverable_id  uuid not null,

  version_number integer not null,
  summary        text,
  status         public.deliverable_status not null,

  submitted_by uuid references public.profiles (id) on delete restrict,
  submitted_at timestamptz not null default now(),

  reviewed_by    uuid references public.profiles (id) on delete restrict,
  reviewed_at    timestamptz,
  review_outcome public.review_outcome,
  review_notes   text,

  -- No updated_at and no deleted_at: the row is immutable once written, so
  -- both columns would be lies.
  created_at timestamptz not null default now(),

  constraint deliverable_versions_id_org_key unique (id, organization_id),

  constraint deliverable_versions_deliverable_fkey
    foreign key (deliverable_id, organization_id)
    references public.deliverables (id, organization_id)
    on update cascade on delete cascade,

  constraint deliverable_versions_number_positive check (version_number >= 1),
  constraint deliverable_versions_review_coherent
    check (
      (reviewed_at is null and reviewed_by is null and review_outcome is null)
      or (reviewed_at is not null and review_outcome is not null)
    ),
  constraint deliverable_versions_reviewed_after_submitted
    check (reviewed_at is null or reviewed_at >= submitted_at)
);

comment on table public.deliverable_versions is
  'Immutable version and review history. Append-only: UPDATE and DELETE are '
  'rejected by trigger for every role, including service_role.';

-- Version numbers are dense and unique per deliverable. This is also the
-- backstop against concurrent increment collisions (risk D-11).
create unique index if not exists deliverable_versions_unique_number
  on public.deliverable_versions (deliverable_id, version_number);

create index if not exists deliverable_versions_deliverable_idx
  on public.deliverable_versions (deliverable_id, version_number desc);

create index if not exists deliverable_versions_org_submitted_idx
  on public.deliverable_versions (organization_id, submitted_at desc);

create index if not exists deliverable_versions_submitted_by_idx
  on public.deliverable_versions (submitted_by);
create index if not exists deliverable_versions_reviewed_by_idx
  on public.deliverable_versions (reviewed_by);

drop trigger if exists deliverable_versions_derive_org on public.deliverable_versions;
create trigger deliverable_versions_derive_org
  before insert on public.deliverable_versions
  for each row execute function growlith.derive_organization_id('deliverable_id', 'public.deliverables');

drop trigger if exists deliverable_versions_append_only on public.deliverable_versions;
create trigger deliverable_versions_append_only
  before update or delete on public.deliverable_versions
  for each row execute function growlith.reject_mutation();

alter table public.deliverable_versions enable row level security;
alter table public.deliverable_versions force row level security;
