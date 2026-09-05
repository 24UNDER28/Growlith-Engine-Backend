-- Migration 18 — notifications
--
-- Per-user delivery of events. Recipient-scoped rather than tenant-scoped:
-- `organization_id` is NULLABLE because a platform notice ("scheduled
-- maintenance", "your account was suspended") belongs to no tenant.
--
-- Deliberately NO foreign key on `subject_id`. A notification must survive the
-- deletion of the thing it announces — "the deliverable you were reviewing was
-- removed" is exactly the message that would be destroyed by a cascade. This
-- is the one place in the schema a soft reference is correct, and it is still
-- typed: `subject_entity` uses the shared `entity_kind` vocabulary, so the
-- application can resolve it without guessing.
--
-- No soft delete either. Notifications are ephemeral by nature; the durable
-- record is `audit_events`. Archived rows are hard-deleted by a retention job.

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),

  recipient_user_id uuid not null
                      references public.profiles (id) on delete cascade,
  organization_id   uuid references public.organizations (id) on delete cascade,

  notification_type public.notification_type     not null,
  severity          public.notification_severity not null default 'INFO',

  title text not null,
  body  text,

  subject_entity public.entity_kind,
  subject_id     uuid,
  action_url     text,

  read_at     timestamptz,
  archived_at timestamptz,

  created_at timestamptz not null default now(),

  constraint notifications_title_not_blank check (btrim(title) <> ''),
  -- Either both subject columns or neither: half a reference is unusable.
  constraint notifications_subject_coherent
    check ((subject_entity is null) = (subject_id is null)),
  -- Relative paths only. An absolute URL in a notification is a phishing
  -- vector the moment anything can write to this table.
  constraint notifications_action_url_relative
    check (action_url is null or action_url ~ '^/[A-Za-z0-9/_\-?=&.%]*$'),
  constraint notifications_archived_after_read
    check (archived_at is null or read_at is null or archived_at >= read_at)
);

comment on table public.notifications is
  'Per-recipient event delivery. organization_id is nullable for platform '
  'notices. subject_id is intentionally unconstrained so a notification '
  'outlives the entity it announces.';
comment on column public.notifications.subject_id is
  'Soft reference, no FK by design. Paired with subject_entity from the shared '
  'entity_kind vocabulary so it is still typed.';

-- THE unread badge query, run on effectively every page load. Partial, so the
-- index holds only unread rows and stays small regardless of history.
create index if not exists notifications_unread_idx
  on public.notifications (recipient_user_id, created_at desc)
  where read_at is null and archived_at is null;

-- The full inbox.
create index if not exists notifications_recipient_idx
  on public.notifications (recipient_user_id, created_at desc)
  where archived_at is null;

create index if not exists notifications_org_idx
  on public.notifications (organization_id, created_at desc)
  where organization_id is not null;

-- Deep-link back from an entity to the notifications about it.
create index if not exists notifications_subject_idx
  on public.notifications (subject_entity, subject_id)
  where subject_id is not null;

-- The retention sweep.
create index if not exists notifications_archived_idx
  on public.notifications (archived_at)
  where archived_at is not null;

alter table public.notifications enable row level security;
alter table public.notifications force row level security;

-- ---------------------------------------------------------------------------
-- A tenant notification only ever reaches someone entitled to that tenant
-- ---------------------------------------------------------------------------
-- Schema integrity, not authorization: without this a notification is a
-- side channel that leaks another organization's deliverable titles into a
-- client's inbox, entirely outside RLS on the underlying table.
create or replace function growlith.enforce_notification_recipient_tenancy()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_type public.user_type;
begin
  if new.organization_id is null then
    return new;
  end if;

  select user_type into v_user_type
  from public.profiles
  where id = new.recipient_user_id;

  -- Internal staff are cross-tenant by role and may be notified about any
  -- organization.
  if v_user_type = 'INTERNAL' then
    return new;
  end if;

  if not exists (
    select 1
    from public.organization_memberships m
    where m.user_id = new.recipient_user_id
      and m.organization_id = new.organization_id
      and m.deleted_at is null
  ) then
    raise exception
      'notifications: recipient % has no membership in organization % — '
      'refusing to deliver a cross-tenant notification',
      new.recipient_user_id, new.organization_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists notifications_recipient_tenancy on public.notifications;
create trigger notifications_recipient_tenancy
  before insert or update of recipient_user_id, organization_id
  on public.notifications
  for each row execute function growlith.enforce_notification_recipient_tenancy();
