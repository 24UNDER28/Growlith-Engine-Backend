-- Migration 19 — invitations
--
-- Pending access grants, for both client users and internal staff.
-- `organization_id` is nullable because a staff invitation belongs to no
-- tenant; a check enforces that an invitation is EITHER a client invitation
-- (organization + organization_role) OR a staff invitation (platform_role),
-- never both and never neither.
--
-- The raw token is NEVER stored. Only `token_hash` is persisted, so a database
-- disclosure does not hand the attacker a set of live invitation links. The
-- token itself exists once, in the email.
--
-- NOTE: no acceptance logic here. Creating and accepting invitations is
-- authentication work and belongs to a later phase; this migration models the
-- record and its integrity rules only.

create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),

  email extensions.citext not null,

  -- Client invitation branch.
  organization_id   uuid references public.organizations (id) on delete cascade,
  organization_role public.organization_role,

  -- Staff invitation branch.
  platform_role public.platform_role,

  invited_by uuid not null references public.profiles (id) on delete restrict,

  -- SHA-256 of the token, hex. Never the token.
  token_hash text not null,

  status     public.invitation_status not null default 'PENDING',
  expires_at timestamptz not null,

  accepted_at      timestamptz,
  accepted_user_id uuid references public.profiles (id) on delete restrict,
  revoked_at       timestamptz,
  revoked_by       uuid references public.profiles (id) on delete restrict,

  resent_count  smallint    not null default 0,
  last_sent_at  timestamptz not null default now(),
  message       text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint invitations_email_shape check (email like '%_@_%.__%'),
  constraint invitations_token_hash_shape check (token_hash ~ '^[a-f0-9]{64}$'),

  -- Exactly one branch.
  constraint invitations_exactly_one_branch
    check (
      (organization_id is not null and organization_role is not null
        and platform_role is null)
      or
      (organization_id is null and organization_role is null
        and platform_role is not null)
    ),

  constraint invitations_accepted_coherent
    check (
      status <> 'ACCEPTED'
      or (accepted_at is not null and accepted_user_id is not null)
    ),
  constraint invitations_revoked_coherent
    check ((revoked_at is null) = (revoked_by is null)),
  constraint invitations_revoked_status
    check (status <> 'REVOKED' or revoked_at is not null),
  constraint invitations_expiry_after_creation
    check (expires_at > created_at),
  constraint invitations_resent_count_non_negative check (resent_count >= 0)
);

comment on table public.invitations is
  'Pending access grants. Either a client invitation (organization + '
  'organization_role) or a staff invitation (platform_role). Only the token '
  'HASH is stored.';
comment on column public.invitations.token_hash is
  'SHA-256 hex of the invitation token. The raw token exists only in the '
  'email, so a database disclosure yields no usable invitation links.';

-- A token is a credential: unique, and looked up on every acceptance.
create unique index if not exists invitations_token_hash_key
  on public.invitations (token_hash);

-- No two live invitations for the same address into the same place. The
-- coalesce makes the staff-invitation (NULL organization) case deterministic.
create unique index if not exists invitations_pending_unique
  on public.invitations (
    email,
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status = 'PENDING';

-- The expiry sweep.
create index if not exists invitations_pending_expiry_idx
  on public.invitations (expires_at)
  where status = 'PENDING';

create index if not exists invitations_org_idx
  on public.invitations (organization_id, status)
  where organization_id is not null;

create index if not exists invitations_email_idx on public.invitations (email);
create index if not exists invitations_invited_by_idx on public.invitations (invited_by);
create index if not exists invitations_accepted_user_idx
  on public.invitations (accepted_user_id)
  where accepted_user_id is not null;
create index if not exists invitations_revoked_by_idx on public.invitations (revoked_by);

drop trigger if exists invitations_set_updated_at on public.invitations;
create trigger invitations_set_updated_at
  before update on public.invitations
  for each row execute function growlith.set_updated_at();

-- The invited address, target and role are the substance of the invitation.
-- If they were mutable, a PENDING invitation could be silently re-pointed at a
-- different organization or upgraded to a platform role after approval.
create or replace function growlith.freeze_invitation_terms()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.email             is distinct from old.email
     or new.organization_id   is distinct from old.organization_id
     or new.organization_role is distinct from old.organization_role
     or new.platform_role     is distinct from old.platform_role
     or new.token_hash        is distinct from old.token_hash
  then
    raise exception
      'invitations: email, target and role are immutable — revoke and reissue'
      using errcode = 'check_violation';
  end if;

  if old.status in ('ACCEPTED', 'REVOKED')
     and new.status is distinct from old.status
  then
    raise exception 'invitations: % is a terminal status', old.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists invitations_freeze_terms on public.invitations;
create trigger invitations_freeze_terms
  before update on public.invitations
  for each row execute function growlith.freeze_invitation_terms();

alter table public.invitations enable row level security;
alter table public.invitations force row level security;
