-- Migration 30 — Phase 4 (6/6a): the privilege-changing half of the §14
-- closed RPC set. Every one of these exists because the rule it enforces is
-- NOT expressible as a predicate over the new row (§0, ADR-0012): role
-- ceilings compare caller to target, the last-admin floor counts rows, and a
-- primary-contact swap is atomic-by-definition. Adding a thirteenth RPC
-- requires an ADR, exactly as §14 states.
--
-- Contract, per function, from §14: SECURITY DEFINER, pinned search_path,
-- authority RE-CHECKED FROM THE DATABASE inside the body (never trusted from
-- an argument or a claim), and the audit event written IN THE SAME
-- TRANSACTION as the mutation. `authenticated` holds no write grant on
-- organization_memberships or platform_role_grants (§A ceiling 4), so these
-- five functions are not one of several doors — they are the only door.

-- ---------------------------------------------------------------------------
-- Shared audit writer for the Phase 4 definer set
-- ---------------------------------------------------------------------------
-- The generic record_audit_event() machinery is a trigger on the business
-- tables; these RPCs write cross-entity, intent-bearing entries (ROLE_GRANT
-- with a reason) that no diff trigger could infer. actor and actor_role are
-- resolved HERE, from the database, not accepted as parameters — an audit
-- trail whose actor is an argument is not an audit trail.

create or replace function growlith.phase4_audit(
  p_organization_id uuid,
  p_entity_kind     public.entity_kind,
  p_entity_id       uuid,
  p_action          public.audit_action,
  p_severity        public.audit_severity,
  p_reason          text,
  p_before          jsonb default null,
  p_after           jsonb default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  insert into public.audit_events (
    organization_id, actor_user_id, actor_role, request_id,
    entity_kind, entity_id, action, severity, reason, before, after
  ) values (
    p_organization_id,
    v_actor,
    public.auth_platform_role()::text,
    nullif(current_setting('growlith.request_id', true), ''),
    p_entity_kind,
    p_entity_id,
    p_action,
    p_severity,
    left(nullif(btrim(coalesce(p_reason, '')), ''), 512),
    p_before,
    p_after
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- grant_platform_role() — SUPER_ADMIN only (§A items 1)
-- ---------------------------------------------------------------------------

create or replace function public.grant_platform_role(
  p_user_id    uuid,
  p_role       public.platform_role,
  p_reason     text,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_caller  uuid := (select auth.uid());
  v_target  public.profiles;
  v_live    public.platform_role_grants;
  v_id      uuid;
begin
  if not public.is_super_admin() then
    raise exception 'grant_platform_role: SUPER_ADMIN only'
      using errcode = 'insufficient_privilege';
  end if;

  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'grant_platform_role: a reason is required'
      using errcode = 'check_violation';
  end if;

  select * into v_target from public.profiles
   where id = p_user_id and deleted_at is null;
  if not found then
    raise exception 'grant_platform_role: no live profile %', p_user_id
      using errcode = 'no_data_found';
  end if;

  if v_target.user_type <> 'INTERNAL' then
    raise exception 'grant_platform_role: % is a CLIENT profile — client-side roles are organization memberships', p_user_id
      using errcode = 'check_violation';
  end if;

  -- The one-live-grant invariant (§14). The partial unique index
  -- platform_role_grants_active_key is the backstop under concurrency; the
  -- explicit read makes the failure legible.
  select * into v_live from public.platform_role_grants g
   where g.user_id = p_user_id
     and g.revoked_at is null
   limit 1;
  if found then
    raise exception 'grant_platform_role: % already holds a live % grant; revoke it first',
      p_user_id, v_live.role
      using errcode = 'check_violation',
            hint = 'A revoked grant can never be un-revoked; re-grant instead (freeze trigger, migration 05).';
  end if;

  insert into public.platform_role_grants (
    user_id, role, granted_by, reason, expires_at
  ) values (
    p_user_id, p_role, v_caller, left(btrim(p_reason), 1024), p_expires_at
  )
  returning id into v_id;

  perform growlith.phase4_audit(
    null, 'profile', p_user_id, 'ROLE_GRANT', 'CRITICAL',
    format('platform role %s granted to %s: %s', p_role, p_user_id, left(btrim(p_reason), 200)),
    null,
    jsonb_build_object('platform_role', p_role::text, 'expires_at', p_expires_at)
  );

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- revoke_platform_role() — SUPER_ADMIN only; the last-SUPER_ADMIN guard
-- ---------------------------------------------------------------------------
-- Lockout protection: the platform must not end up with zero live
-- SUPER_ADMIN grants. The guard reads LIVE grants (revoked + expired are out),
-- and only trips when the caller would revoke their own role into that empty
-- state — revoking a SECOND admin while another admin remains is always fine.

create or replace function public.revoke_platform_role(
  p_user_id uuid,
  p_reason  text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_caller    uuid := (select auth.uid());
  v_grant     public.platform_role_grants;
  v_other_sas integer;
begin
  if not public.is_super_admin() then
    raise exception 'revoke_platform_role: SUPER_ADMIN only'
      using errcode = 'insufficient_privilege';
  end if;

  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'revoke_platform_role: a reason is required'
      using errcode = 'check_violation';
  end if;

  select * into v_grant from public.platform_role_grants g
   where g.user_id = p_user_id and g.revoked_at is null
   limit 1;
  if not found then
    raise exception 'revoke_platform_role: % holds no live grant', p_user_id
      using errcode = 'no_data_found';
  end if;

  if v_grant.role = 'SUPER_ADMIN' and p_user_id = v_caller then
    select count(*) into v_other_sas
    from public.platform_role_grants g
    where g.role = 'SUPER_ADMIN'
      and g.revoked_at is null
      and (g.expires_at is null or g.expires_at > now())
      and g.user_id <> v_caller;
    if v_other_sas = 0 then
      raise exception 'revoke_platform_role: this would leave the platform without any SUPER_ADMIN'
        using errcode = 'check_violation',
              hint = 'Grant the role to a successor first, then revoke your own.';
    end if;
  end if;

  update public.platform_role_grants
     set revoked_at   = now(),
         revoked_by   = v_caller,
         revoke_reason = left(btrim(p_reason), 1024)
   where id = v_grant.id;

  perform growlith.phase4_audit(
    null, 'profile', p_user_id, 'ROLE_REVOKE', 'CRITICAL',
    format('platform role %s revoked from %s: %s',
           v_grant.role, p_user_id, left(btrim(p_reason), 200)),
    jsonb_build_object('platform_role', v_grant.role::text),
    jsonb_build_object('revoked', true)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- add_organization_member() — staff or the tenant's CLIENT_ADMIN
-- ---------------------------------------------------------------------------
-- Ceiling 1 by role: a CLIENT_ADMIN may only ever grant CLIENT_MEMBER;
-- elevation of a client into CLIENT_ADMIN requires an internal actor
-- ("otherwise the first compromised client admin permanently owns the
-- tenant", §A). The profile must be a live CLIENT — the Phase 2
-- user-type trigger enforces the same rule again at row level.

create or replace function public.add_organization_member(
  p_organization_id uuid,
  p_user_id         uuid,
  p_role            public.organization_role,
  p_job_title       text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_caller  uuid := (select auth.uid());
  v_is_staff boolean := public.is_platform_admin();
  v_target  public.profiles;
  v_dupes   integer;
  v_id      uuid;
begin
  if v_caller is null then
    raise exception 'add_organization_member: authentication required'
      using errcode = 'insufficient_privilege';
  end if;

  if not v_is_staff then
    if not public.is_client_admin_of(p_organization_id) then
      raise exception 'add_organization_member: not an administrator of this organization'
        using errcode = 'insufficient_privilege';
    end if;
    -- Ceiling 1 (CLIENT_ADMIN callers only; staff have no role ceiling here —
    -- ADMIN/SA may add a CLIENT_ADMIN, which is the elevation path §A names).
    if p_role <> 'CLIENT_MEMBER' then
      raise exception 'add_organization_member: a CLIENT_ADMIN may only grant CLIENT_MEMBER'
        using errcode = 'insufficient_privilege',
              hint = 'CLIENT_ADMIN elevation requires an internal actor (§A ceiling 1).';
    end if;
  end if;

  -- Ceiling 2, applied to every caller: membership changes made about
  -- yourself are exactly the self-elevation race §A calls out. Adding
  -- yourself to an organization is a membership change about yourself.
  if p_user_id = v_caller then
    raise exception 'add_organization_member: cannot add yourself to an organization'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_target from public.profiles
   where id = p_user_id and deleted_at is null;
  if not found then
    raise exception 'add_organization_member: no live profile %', p_user_id
      using errcode = 'no_data_found';
  end if;
  if v_target.user_type <> 'CLIENT' then
    raise exception 'add_organization_member: % is not a CLIENT profile', p_user_id
      using errcode = 'check_violation';
  end if;

  select count(*) into v_dupes
  from public.organization_memberships m
  where m.organization_id = p_organization_id
    and m.user_id = p_user_id
    and m.deleted_at is null;
  if v_dupes > 0 then
    raise exception 'add_organization_member: % is already a member of %',
      p_user_id, p_organization_id
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.organizations o
    where o.id = p_organization_id and o.deleted_at is null
  ) then
    raise exception 'add_organization_member: no live organization %', p_organization_id
      using errcode = 'no_data_found';
  end if;

  insert into public.organization_memberships (
    organization_id, user_id, role, status, joined_at, job_title
  ) values (
    p_organization_id, p_user_id, p_role, 'ACTIVE', now(), nullif(btrim(coalesce(p_job_title, '')), '')
  )
  returning id into v_id;

  perform growlith.phase4_audit(
    p_organization_id, 'profile', p_user_id, 'ROLE_GRANT', 'CRITICAL',
    format('organization membership %s added as %s',
           p_user_id, p_role),
    null,
    jsonb_build_object('role', p_role::text, 'status', 'ACTIVE')
  );

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- update_organization_member() — role, status, primary-contact moves
-- ---------------------------------------------------------------------------
-- Carries all four ceilings (§14: "Idem, plus no self-modification, plus
-- last-admin protection"). The last-admin floor and the primary-contact rule
-- are enforced for EVERY caller, not just CLIENT_ADMIN: §14 lists them as
-- RPC rules; an organization without a reachable client admin cannot approve
-- deliverables at all, and no internal actor should discover that by
-- accident. Recovery is ordered and cheap: name the successor first.

create or replace function public.update_organization_member(
  p_membership_id            uuid,
  p_role                     public.organization_role default null,
  p_status                   public.membership_status default null,
  p_is_primary_contact       boolean default null,
  p_new_primary_membership_id uuid default null,
  p_job_title                text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_caller  uuid := (select auth.uid());
  v_is_staff boolean := public.is_platform_admin();
  v_row     public.organization_memberships;
  v_new_role public.organization_role;
  v_new_status public.membership_status;
  v_last_admin integer;
  v_replacement public.organization_memberships;
begin
  if v_caller is null then
    raise exception 'update_organization_member: authentication required'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.organization_memberships m
   where m.id = p_membership_id and m.deleted_at is null
   for update;
  if not found then
    raise exception 'update_organization_member: no live membership %', p_membership_id
      using errcode = 'no_data_found';
  end if;

  if not v_is_staff then
    if not public.is_client_admin_of(v_row.organization_id) then
      raise exception 'update_organization_member: not an administrator of this organization'
        using errcode = 'insufficient_privilege';
    end if;
    -- Ceilings 1 and 2 for a CLIENT_ADMIN caller: the row they touch must be
    -- a CLIENT_MEMBER row, and it may never become anything else.
    if v_row.user_id = v_caller
       or v_row.role <> 'CLIENT_MEMBER'
       or (p_role is not null and p_role <> 'CLIENT_MEMBER') then
      raise exception 'update_organization_member: a CLIENT_ADMIN may modify only OTHER members'' CLIENT_MEMBER rows'
        using errcode = 'insufficient_privilege',
              hint = 'Ceilings 1–2, authorization.md §A.';
    end if;
  else
    -- Staff path keeps the no-self rule too (§14's "plus" list is about the
    -- RPC, not about one role) — self-modification is the race, whoever
    -- starts it.
    if v_row.user_id = v_caller then
      raise exception 'update_organization_member: cannot modify your own membership'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  v_new_role   := coalesce(p_role, v_row.role);
  v_new_status := coalesce(p_status, v_row.status);

  -- The last-admin floor: the resulting state must leave at least one live
  -- ACTIVE CLIENT_ADMIN in the organization. Counting the org-wide set,
  -- excluding this row, is the whole rule — no ordering games.
  if v_row.role = 'CLIENT_ADMIN' and v_row.status = 'ACTIVE'
     and (v_new_role <> 'CLIENT_ADMIN' or v_new_status <> 'ACTIVE') then
    select count(*) into v_last_admin
    from public.organization_memberships m
    where m.organization_id = v_row.organization_id
      and m.role = 'CLIENT_ADMIN'
      and m.status = 'ACTIVE'
      and m.deleted_at is null
      and m.id <> v_row.id;
    if v_last_admin = 0 then
      raise exception 'update_organization_member: % is the last live CLIENT_ADMIN of this organization', p_membership_id
        using errcode = 'check_violation',
              hint = 'Add or promote a successor first, then apply this change.';
    end if;
  end if;

  -- Primary-contact bookkeeping, atomic in both directions. Removing the
  -- flag requires naming the replacement IN THIS CALL (§14,
  -- remove_organization_member's "Idem, plus" clause applies here too — the
  -- flag may never point at nothing, not even for one statement).
  if p_is_primary_contact is true and v_row.is_primary_contact is not true then
    -- Take the flag: demote the current holder first (the partial unique
    -- index makes any other order a race against the index itself).
    update public.organization_memberships m
       set is_primary_contact = false
     where m.organization_id = v_row.organization_id
       and m.is_primary_contact
       and m.deleted_at is null
       and m.id <> v_row.id;
  end if;

  if v_row.is_primary_contact and coalesce(p_is_primary_contact, true) is not true then
    if p_new_primary_membership_id is null then
      raise exception 'update_organization_member: removing is_primary_contact requires p_new_primary_membership_id in the same call'
        using errcode = 'check_violation';
    end if;

    select * into v_replacement from public.organization_memberships m
     where m.id = p_new_primary_membership_id
       and m.organization_id = v_row.organization_id
       and m.deleted_at is null
       and m.status = 'ACTIVE'
       and m.id <> v_row.id
     for update;
    if not found then
      raise exception 'update_organization_member: replacement % is not a live ACTIVE member of this organization',
        p_new_primary_membership_id
        using errcode = 'check_violation';
    end if;

    update public.organization_memberships m
       set is_primary_contact = true
     where m.id = v_replacement.id;
  end if;

  update public.organization_memberships m
     set role = v_new_role,
         status = v_new_status,
         is_primary_contact = coalesce(p_is_primary_contact, m.is_primary_contact),
         job_title = coalesce(nullif(btrim(p_job_title), ''), m.job_title)
   where m.id = v_row.id;

  perform growlith.phase4_audit(
    v_row.organization_id, 'profile', v_row.user_id, 'ROLE_GRANT', 'CRITICAL',
    format('organization membership %s updated (role %s→%s, status %s→%s)',
           v_row.id, v_row.role, v_new_role, v_row.status, v_new_status),
    to_jsonb(v_row) - 'created_at' - 'updated_at' - 'created_by' - 'updated_by',
    jsonb_build_object('role', v_new_role::text, 'status', v_new_status::text)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- remove_organization_member() — the soft delete, with its two floors
-- ---------------------------------------------------------------------------

create or replace function public.remove_organization_member(
  p_membership_id             uuid,
  p_new_primary_membership_id uuid default null,
  p_reason                    text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_caller  uuid := (select auth.uid());
  v_is_staff boolean := public.is_platform_admin();
  v_row     public.organization_memberships;
  v_live_admins integer;
  v_live_members integer;
  v_replacement public.organization_memberships;
begin
  if v_caller is null then
    raise exception 'remove_organization_member: authentication required'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.organization_memberships m
   where m.id = p_membership_id and m.deleted_at is null
   for update;
  if not found then
    raise exception 'remove_organization_member: no live membership %', p_membership_id
      using errcode = 'no_data_found';
  end if;

  if not v_is_staff then
    if not public.is_client_admin_of(v_row.organization_id)
       or v_row.role <> 'CLIENT_MEMBER' then
      raise exception 'remove_organization_member: a CLIENT_ADMIN may remove only CLIENT_MEMBER members of their own organization'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- Removal is a modification; the no-self rule carries (§14). A client who
  -- wants to leave the tenant asks an internal actor — the alternative, a
  -- self-removal path, is indistinguishable from an account-compromise
  -- lockout attack, and an organization waking up without an admin is the
  -- failure mode the floor exists for.
  if v_row.user_id = v_caller then
    raise exception 'remove_organization_member: cannot remove your own membership'
      using errcode = 'insufficient_privilege';
  end if;

  if v_row.role = 'CLIENT_ADMIN' and v_row.status = 'ACTIVE' then
    select count(*) into v_live_admins
    from public.organization_memberships m
    where m.organization_id = v_row.organization_id
      and m.role = 'CLIENT_ADMIN'
      and m.status = 'ACTIVE'
      and m.deleted_at is null
      and m.id <> v_row.id;
    if v_live_admins = 0 then
      raise exception 'remove_organization_member: % is the last live CLIENT_ADMIN of this organization', p_membership_id
        using errcode = 'check_violation',
              hint = 'Add or promote a successor first.';
    end if;
  end if;

  if v_row.is_primary_contact then
    -- The replacement rule relaxes exactly when there is no one to replace:
    -- removing the LAST live member leaves the organization without a
    -- primary contact by construction, and naming a replacement would be
    -- asking for a member who does not exist.
    select count(*) into v_live_members
    from public.organization_memberships m
    where m.organization_id = v_row.organization_id
      and m.deleted_at is null
      and m.id <> v_row.id;

    if v_live_members > 0 then
      if p_new_primary_membership_id is null then
        raise exception 'remove_organization_member: removing the is_primary_contact holder requires naming a replacement'
          using errcode = 'check_violation';
      end if;
      select * into v_replacement from public.organization_memberships m
       where m.id = p_new_primary_membership_id
         and m.organization_id = v_row.organization_id
         and m.deleted_at is null
         and m.status = 'ACTIVE'
         and m.id <> v_row.id
       for update;
      if not found then
        raise exception 'remove_organization_member: replacement % is not a live ACTIVE member of this organization',
          p_new_primary_membership_id
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  update public.organization_memberships m
     set deleted_at = now(),
         deleted_by = v_caller,
         status = 'DEACTIVATED',
         is_primary_contact = false
   where m.id = v_row.id;

  if v_replacement.id is not null then
    update public.organization_memberships m
       set is_primary_contact = true
     where m.id = v_replacement.id;
  end if;

  perform growlith.phase4_audit(
    v_row.organization_id, 'profile', v_row.user_id, 'ROLE_REVOKE', 'CRITICAL',
    format('organization membership %s removed (role %s): %s',
           v_row.id, v_row.role, coalesce(nullif(btrim(p_reason), ''), 'no reason given')),
    to_jsonb(v_row) - 'created_at' - 'updated_at' - 'created_by' - 'updated_by',
    null
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- ACLs — the closed set stays closed at the EXECUTE layer too
-- ---------------------------------------------------------------------------
-- service_role is included because the Next server calls these THROUGH the
-- user-JWT client only for user-initiated flows; admin tooling and the
-- invitation acceptance path (which runs pre-session for the INVITED user via
-- its own definer chain — accept_invitation does not call these) may reach
-- them as service_role. The authority checks inside each body are identical
-- either way — which is the point of "SECURITY DEFINER re-checks from the
-- database".

revoke execute on function
  public.grant_platform_role(uuid, public.platform_role, text, timestamptz),
  public.revoke_platform_role(uuid, text),
  public.add_organization_member(uuid, uuid, public.organization_role, text),
  public.update_organization_member(uuid, public.organization_role, public.membership_status, boolean, uuid, text),
  public.remove_organization_member(uuid, uuid, text)
  from public, anon;

grant execute on function
  public.grant_platform_role(uuid, public.platform_role, text, timestamptz),
  public.revoke_platform_role(uuid, text),
  public.add_organization_member(uuid, uuid, public.organization_role, text),
  public.update_organization_member(uuid, public.organization_role, public.membership_status, boolean, uuid, text),
  public.remove_organization_member(uuid, uuid, text)
  to authenticated, service_role;
