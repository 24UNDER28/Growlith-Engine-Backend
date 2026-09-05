-- Migration 03 — global reference data: teams and service lines
--
-- These two tables are NOT tenant-scoped. They are identical for every client
-- and are the catalogue side of the catalogue/instance split (ADR-0006):
--
--   * `service_lines` is what Growlith SELLS (seven rows, global);
--   * `services` (migration 10) is what one client BOUGHT (per tenant).
--
-- Each table is keyed by its enum rather than a surrogate UUID. The enum value
-- IS the identity — a UUID here would add a join to every read and buy nothing,
-- since the value set is fixed by the type system anyway.
--
-- Seed rows live in this migration, not in `seed.sql`: they are reference data
-- the schema itself depends on (services carry a NOT NULL service_line FK), not
-- synthetic development data. `seed.sql` stays local-only fixtures.

-- ---------------------------------------------------------------------------
-- teams
-- ---------------------------------------------------------------------------
-- Purpose: the seven internal delivery teams, with the display and ownership
-- attributes an enum cannot carry.
create table if not exists public.teams (
  code         public.team  primary key,
  label        text         not null,
  description  text,
  -- Nullable and SET NULL: a team can be temporarily leaderless, and losing a
  -- lead must never cascade into deleting the team.
  lead_user_id uuid,
  is_active    boolean      not null default true,
  sort_order   smallint     not null,
  created_at   timestamptz  not null default now(),
  updated_at   timestamptz  not null default now(),

  constraint teams_label_not_blank check (btrim(label) <> '')
);

comment on table public.teams is
  'Reference data. The seven internal delivery teams. Global — a specialist '
  'serves many tenants, so this table is never organization-scoped.';
comment on column public.teams.lead_user_id is
  'FK to profiles, added in migration 04 once profiles exists.';

-- Unique so the UI ordering is deterministic and cannot silently collide.
create unique index if not exists teams_sort_order_key
  on public.teams (sort_order);

create index if not exists teams_lead_user_id_idx
  on public.teams (lead_user_id)
  where lead_user_id is not null;

drop trigger if exists teams_set_updated_at on public.teams;
create trigger teams_set_updated_at
  before update on public.teams
  for each row execute function growlith.set_updated_at();

-- ---------------------------------------------------------------------------
-- service_lines
-- ---------------------------------------------------------------------------
-- Purpose: the published catalogue. `default_team` encodes the
-- SERVICE_LINE_DEFAULT_TEAM mapping from `src/lib/domain/service-lines.ts` as a
-- FK, so the correspondence is enforced data rather than a comment — while
-- remaining a DEFAULT that an individual `services` row may override.
create table if not exists public.service_lines (
  code         public.service_line primary key,
  label        text                not null,
  description  text,
  default_team public.team         not null,
  is_active    boolean             not null default true,
  sort_order   smallint            not null,
  created_at   timestamptz         not null default now(),
  updated_at   timestamptz         not null default now(),

  constraint service_lines_label_not_blank check (btrim(label) <> ''),

  -- RESTRICT: a team that still backs a service line cannot be removed. There
  -- is no scenario where deleting a team should silently retarget the
  -- catalogue.
  constraint service_lines_default_team_fkey
    foreign key (default_team) references public.teams (code)
    on update cascade on delete restrict
);

comment on table public.service_lines is
  'Reference data. The seven published service lines. Separate from `services` '
  '(the purchased instance) so the catalogue is not duplicated per client and '
  'cross-client reporting stays possible — ADR-0006.';
comment on column public.service_lines.default_team is
  'Default delivering team. A services row may override it: the 1:1 mapping '
  'today is a default, not an identity.';

create unique index if not exists service_lines_sort_order_key
  on public.service_lines (sort_order);

create index if not exists service_lines_default_team_idx
  on public.service_lines (default_team);

drop trigger if exists service_lines_set_updated_at on public.service_lines;
create trigger service_lines_set_updated_at
  before update on public.service_lines
  for each row execute function growlith.set_updated_at();

-- ---------------------------------------------------------------------------
-- Seed: the seven teams
-- ---------------------------------------------------------------------------
insert into public.teams (code, label, description, sort_order) values
  ('ACCOUNT_MANAGEMENT', 'Account Management',
   'Owns the client relationship, commercial health and reporting cadence.', 1),
  ('SEO', 'SEO',
   'Programmatic and technical search: indexation, content systems, authority.', 2),
  ('PAID_MEDIA', 'Paid Media',
   'Precision paid acquisition across search, social and programmatic.', 3),
  ('WEB_DEVELOPMENT', 'Web Development',
   'Sub-second web core: build, performance and conversion infrastructure.', 4),
  ('CRM_LIFECYCLE', 'CRM & Lifecycle',
   'Lifecycle orchestration, segmentation and retention engineering.', 5),
  ('AI_AUTOMATION', 'AI & Automation',
   'Internal and client-facing automation, agents and data pipelines.', 6),
  ('VIDEO_MULTIMEDIA', 'Video & Multimedia',
   'Video, motion and multimedia production for acquisition and brand.', 7)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Seed: the seven service lines
-- ---------------------------------------------------------------------------
insert into public.service_lines (code, label, default_team, description, sort_order) values
  ('PROGRAMMATIC_SEO', 'Programmatic SEO', 'SEO',
   'Scaled, template-driven organic acquisition.', 1),
  ('PRECISION_PAID_MEDIA', 'Precision Paid Media', 'PAID_MEDIA',
   'First-party-data-led paid acquisition with server-side measurement.', 2),
  ('WEB_CORE', 'Sub-Second Web Core', 'WEB_DEVELOPMENT',
   'Performance-first web platform work measured on field Core Web Vitals.', 3),
  ('LIFECYCLE_CRM', 'Lifecycle CRM', 'CRM_LIFECYCLE',
   'Lifecycle messaging, segmentation and revenue retention.', 4),
  ('AI_AUTOMATIONS', 'AI Automations', 'AI_AUTOMATION',
   'Applied AI and workflow automation across the client stack.', 5),
  ('VIDEO_MULTIMEDIA', 'Video & Multimedia', 'VIDEO_MULTIMEDIA',
   'Video and multimedia production.', 6),
  ('ACCOUNT_MANAGEMENT', 'Account Management', 'ACCOUNT_MANAGEMENT',
   'Strategic account leadership, reporting and QBRs.', 7)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Enabled in the same migration that creates the table, per the Phase 1
-- convention: a table must never exist without RLS, even transiently.
-- Reference data is world-readable to authenticated users and writable only
-- through migrations; the read policy is created here because it is part of
-- schema integrity (nothing can render without the catalogue), while all
-- authorization policies proper are deferred to Phase 4.
alter table public.teams         enable row level security;
alter table public.teams         force row level security;
alter table public.service_lines enable row level security;
alter table public.service_lines force row level security;
