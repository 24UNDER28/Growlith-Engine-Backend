-- Migration 27 — Phase 3 authentication definer functions
--
-- Three SECURITY DEFINER functions, plus one deliberate amendment to a Phase 2
-- trigger function, plus their EXECUTE grants.
--
--   1. public.auth_context()               — one round trip resolving identity,
--                                             platform role and live memberships
--   2. public.accept_invitation(text)      — the single atomic activation event
--   3. public.touch_last_seen()            — throttled presence touch
--   4. growlith.freeze_invitation_terms()  — token_hash rotation allowed while
--                                             PENDING (invitation resend)
--
-- NAMESPACE NOTE (a deliberate, documented refinement of the design text)
-- `docs/architecture/authentication.md` refers to these as `growlith.*`.
-- The enforced Phase 2 convention (migration 23) is the opposite: the
-- `growlith` schema stays closed — trigger bodies only — because PostgREST
-- exposes exactly the schemas in its `db-schemas` list (just `public`) and
-- exposing `growlith` would publish every trigger function as an RPC.
-- Directly invocable definer helpers therefore live in `public`, exactly like
-- the Phase 2 RLS predicates (`public.auth_platform_role()` and friends), with
-- EXECUTE granted narrowly. The design's `growlith.` prefix read as "the
-- definer namespace"; this migration implements it as `public.` + pinned
-- search_path + revoked grants, which is what the convention actually means.
--
-- All three follow the Phase 2 definer rules: pinned `search_path`,
-- `security definer`, `stable` where read-only, and REVOKE from PUBLIC/anon
-- (EXECUTE is granted to PUBLIC by default on new functions — `anon` must
-- never reach any of these).

-- ---------------------------------------------------------------------------
-- 1. auth_context()
-- ---------------------------------------------------------------------------
-- The one round trip behind requireAuthContext() (design §5): profile row,
-- live platform role, live memberships — resolved BY THE DATABASE, anchored on
-- auth.uid(), so application code and (future) RLS policies share one
-- definition of "who is this and what state are they in".
--
-- Why a definer function rather than a plain select: `profiles`,
-- `platform_role_grants` and `organization_memberships` have RLS enabled with
-- no policies yet (Phase 4 writes them), so the caller's own JWT sees nothing.
-- A definer function is the sanctioned, auditable read path (ADR-0008/0012)
-- and keeps working unchanged once policies land, because it bypasses RLS
-- rather than depending on its absence.
--
-- Returns jsonb rather than a composite: one stable wire shape across
-- PostgREST, no column-order coupling, and the application validates it with
-- a Zod schema at the boundary (ADR-0017).
--
-- STABLE: read-only, evaluated once per statement. NULL when the caller has no
-- live profile row (deleted, or an auth user created outside the trigger's
-- reach) — the application treats that as unauthenticated and logs loudly,
-- because an authenticated principal invisible to policy is the worst state.

create or replace function public.auth_context()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'userId', p.id,
    'email', p.email,
    'fullName', p.full_name,
    'userType', p.user_type::text,
    'accountStatus', p.account_status::text,
    'lastSeenAt', p.last_seen_at,
    'mfaEnrolledAt', p.mfa_enrolled_at,
    'platformRole', public.auth_platform_role()::text,
    'memberships', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'organizationId', m.organization_id,
          'role', m.role::text,
          'status', m.status::text,
          'isPrimaryContact', m.is_primary_contact
        )
        order by m.organization_id
      )
      from public.organization_memberships m
      where m.user_id = p.id
        and m.deleted_at is null
    ), '[]'::jsonb)
  )
  from public.profiles p
  where p.id = auth.uid()
    and p.deleted_at is null;
$$;

comment on function public.auth_context() is
  'Identity + platform role + live memberships of the current user, as jsonb. '
  'SECURITY DEFINER because RLS policies do not exist until Phase 4; the '
  'application NEVER trusts JWT claims for these facts (ADR-0011).';

-- ---------------------------------------------------------------------------
-- 2. accept_invitation(p_raw_token text)
-- ---------------------------------------------------------------------------
-- The single activation event (design §2.2). Called through the request-scoped
-- user client immediately after verifyOtp proves mailbox control, so
-- auth.uid() is the accepter. In ONE transaction it:
--
--   1. lazily flips PENDING invitations past expires_at to EXPIRED;
--   2. looks up the invitation by sha256(token) — the raw token is never
--      stored, so a database disclosure yields no usable links;
--   3. rejects anything not PENDING and unexpired, with a machine-readable
--      message prefix the application maps to neutral redirect states;
--   4. verifies the invited address matches the authenticated identity's
--      address (a link forwarded to the wrong mailbox must not activate);
--   5. client branch: activates the membership (ACTIVE, joined_at), activates
--      the profile (INVITED → ACTIVE), enforcing the one-live-membership
--      invariant for CLIENT profiles;
--      staff branch: activates the profile and inserts the platform_role_grants
--      row with granted_by = invitations.invited_by (a grant is an event with
--      a granter);
--   6. flips the invitation ACCEPTED — last, guarded by status='PENDING', so
--      a concurrent acceptance of the same token loses the race explicitly;
--   7. writes INVITE_ACCEPTED, STATUS_CHANGE and (staff) ROLE_GRANT audit rows
--      in the same transaction: here audit IS the control, so its failure
--      aborts the operation.
--
-- plpgsql on purpose: the body references enum values added by migration 26,
-- and plpgsql validates statements at first CALL, in a transaction after the
-- one that added them — never at CREATE time.

create or replace function public.accept_invitation(p_raw_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_hash    text := encode(extensions.digest(p_raw_token, 'sha256'), 'hex');
  v_inv     public.invitations%rowtype;
  v_email   text;
  v_before  public.account_status;
  v_membership_updated boolean := false;
  v_grant_inserted     boolean := false;
begin
  if auth.uid() is null then
    raise exception 'INVITATION_NO_SESSION: invitation acceptance requires a verified session'
      using errcode = '28000';
  end if;

  -- 1. Lazy expiry sweep. Status PENDING -> EXPIRED is legal under the
  --    terminal-status trigger (only ACCEPTED/REVOKED are frozen).
  update public.invitations
     set status = 'EXPIRED'
   where status = 'PENDING'
     and expires_at < now();

  -- 2. Token lookup.
  select * into v_inv
  from public.invitations
  where token_hash = v_hash;

  if not found then
    raise exception 'INVITATION_UNKNOWN: this invitation link is not valid'
      using errcode = '22023';
  end if;

  -- 3. State gate. Message prefixes are a machine contract consumed by
  --    src/server/auth/routes-password.ts and the confirm callback; every
  --    state the link holder can reach maps to a neutral user-facing page.
  if v_inv.status = 'EXPIRED' or (v_inv.status = 'PENDING' and v_inv.expires_at <= now()) then
    raise exception 'INVITATION_EXPIRED: this invitation link has expired'
      using errcode = '22023';
  elsif v_inv.status = 'REVOKED' then
    raise exception 'INVITATION_REVOKED: this invitation was revoked'
      using errcode = '22023';
  elsif v_inv.status = 'ACCEPTED' then
    raise exception 'INVITATION_ALREADY_ACCEPTED: this invitation has already been accepted'
      using errcode = '22023';
  elsif v_inv.status <> 'PENDING' then
    raise exception 'INVITATION_UNKNOWN: this invitation link is not valid'
      using errcode = '22023';
  end if;

  -- 4. Mailbox binding: the invited address must be the accepter's address.
  select u.email into v_email from auth.users u where u.id = auth.uid();
  if v_email is null or v_email::extensions.citext <> v_inv.email then
    raise exception 'INVITATION_EMAIL_MISMATCH: this invitation was issued for a different address'
      using errcode = '22023';
  end if;

  select account_status into v_before
  from public.profiles
  where id = auth.uid()
    and deleted_at is null;

  if v_before is null then
    -- The on_auth_user_created trigger makes this unreachable except by
    -- direct auth-store surgery. Fail closed.
    raise exception 'INVITATION_NO_PROFILE: the accepting identity has no profile'
      using errcode = '22023';
  end if;

  if v_before not in ('INVITED', 'ACTIVE') then
    raise exception 'INVITATION_ACCOUNT_STATE: this account cannot accept an invitation in its current state'
      using errcode = '22023';
  end if;

  -- 5a. Client branch.
  if v_inv.organization_id is not null then
    -- A CLIENT profile holds at most one live membership. A second live
    -- membership elsewhere is a rejection, not a merge.
    if exists (
      select 1
      from public.organization_memberships m
      where m.user_id = auth.uid()
        and m.organization_id <> v_inv.organization_id
        and m.status <> 'DEACTIVATED'
        and m.deleted_at is null
    ) then
      raise exception 'MEMBERSHIP_CONFLICT: this account already belongs to another organization'
        using errcode = '22023';
    end if;

    update public.organization_memberships
       set status = 'ACTIVE',
           joined_at = now()
     where id = (
       select m.id
       from public.organization_memberships m
       where m.user_id = auth.uid()
         and m.organization_id = v_inv.organization_id
         and m.deleted_at is null
       limit 1
     );
    -- rowcount is available immediately after UPDATE ... WHERE id = (subquery)
    get diagnostics v_membership_updated = row_count;

    if not v_membership_updated then
      raise exception 'MEMBERSHIP_MISSING: the invited membership row is absent — re-issue the invitation'
        using errcode = '22023';
    end if;

  -- 5b. Staff branch: the grant is deferred to acceptance because a grant is
  --     an event with a granter (design §2.1 step 5).
  else
    insert into public.platform_role_grants (user_id, role, granted_by, reason)
    values (
      auth.uid(),
      v_inv.platform_role,
      v_inv.invited_by,
      'Invitation ' || v_inv.id || ' accepted by invitee'
    )
    on conflict do nothing;
    -- One live grant per (user, role) already existed: accepting is still
    -- correct; the pre-existing grant simply stays.
    get diagnostics v_grant_inserted = row_count;
  end if;

  -- 6. Flip the invitation, racing explicitly.
  update public.invitations
     set status = 'ACCEPTED',
         accepted_at = now(),
         accepted_user_id = auth.uid()
   where id = v_inv.id
     and status = 'PENDING';

  if not found then
    raise exception 'INVITATION_ALREADY_ACCEPTED: this invitation has already been accepted'
      using errcode = '22023';
  end if;

  -- Profile activation. INVITED -> ACTIVE is RPC-only in the application's
  -- transition graph; existing ACTIVE (dashboard-confirmed user invited by
  -- mistake) is tolerated rather than failed, so the acceptance is idempotent.
  if v_before = 'INVITED' then
    update public.profiles
       set account_status = 'ACTIVE',
           updated_by = auth.uid()
     where id = auth.uid()
       and account_status = 'INVITED';
  end if;

  -- 7. Audit, in-transaction. Failure aborts acceptance: here the audit IS
  --    the control (design §12).
  insert into public.audit_events
    (organization_id, actor_user_id, entity_kind, entity_id, action, severity, after, reason)
  values
    (
      v_inv.organization_id,
      auth.uid(),
      'profile',
      auth.uid(),
      'INVITE_ACCEPTED',
      'NOTICE',
      jsonb_build_object(
        'invitationId', v_inv.id,
        'branch', case when v_inv.organization_id is not null then 'client' else 'staff' end,
        'membershipActivated', v_membership_updated,
        'grantInserted', v_grant_inserted
      ),
      'invitation accepted via email link'
    );

  if v_before = 'INVITED' then
    insert into public.audit_events
      (organization_id, actor_user_id, entity_kind, entity_id, action, severity,
       changed_fields, before, after)
    values
      (
        v_inv.organization_id,
        auth.uid(),
        'profile',
        auth.uid(),
        'STATUS_CHANGE',
        'NOTICE',
        array['account_status'],
        jsonb_build_object('accountStatus', v_before),
        jsonb_build_object('accountStatus', 'ACTIVE')
      );
  end if;

  if v_grant_inserted then
    insert into public.audit_events
      (actor_user_id, entity_kind, entity_id, action, severity, after, reason)
    values
      (
        auth.uid(),
        'profile',
        auth.uid(),
        'ROLE_GRANT',
        'CRITICAL',
        jsonb_build_object('role', v_inv.platform_role::text, 'via', 'invitation'),
        'granted by invitation issuer at acceptance'
      );
  end if;

  -- The current month's partition is ensured by the DEFAULT partition, so this
  -- insert can never fail for want of one.

  return jsonb_build_object(
    'invitationId', v_inv.id,
    'branch', case when v_inv.organization_id is not null then 'client' else 'staff' end,
    'organizationId', v_inv.organization_id,
    'platformRole', v_inv.platform_role::text
  );
end;
$$;

comment on function public.accept_invitation(text) is
  'Atomic invitation acceptance: verifies the raw token against token_hash, '
  'activates profile + membership (client) or role grant (staff), flips the '
  'invitation ACCEPTED and writes audit rows in one transaction. The raw token '
  'is never stored.';

-- ---------------------------------------------------------------------------
-- 3. touch_last_seen()
-- ---------------------------------------------------------------------------
-- Presence, throttled IN SQL so a double fire from the application (RSC layout
-- + route handler resolving the same request) is harmless by construction: the
-- second call sees a fresh last_seen_at and writes nothing.

create or replace function public.touch_last_seen()
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  update public.profiles
     set last_seen_at = now(),
         updated_by = id
   where id = auth.uid()
     and deleted_at is null
     and (last_seen_at is null or last_seen_at < now() - interval '5 minutes');
end;
$$;

comment on function public.touch_last_seen() is
  'Throttled presence touch for the current user. No-op within 5 minutes of '
  'the last touch, so callers never need to coordinate.';

-- ---------------------------------------------------------------------------
-- 4. growlith.freeze_invitation_terms(): allow token_hash rotation on PENDING
-- ---------------------------------------------------------------------------
-- Phase 2 froze token_hash unconditionally. Phase 3's resend rotates the
-- credential ("re-runs inviteUserByEmail with a fresh app token — new
-- token_hash on the same row", design §2.3), which is safe exactly while the
-- invitation is PENDING: email/target/role stay frozen ALWAYS, and once a row
-- is ACCEPTED or REVOKED its token_hash is history. Forward-only: the trigger
-- is replaced, not edited in a prior file.

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
  then
    raise exception
      'invitations: email, target and role are immutable — revoke and reissue'
      using errcode = 'check_violation';
  end if;

  -- The token is a credential, and a resend mints a fresh one. Rotation is
  -- permitted only while the row is PENDING and stays PENDING: an accepted or
  -- revoked invitation's hash is evidence, not a live credential.
  if new.token_hash is distinct from old.token_hash
     and not (old.status = 'PENDING' and new.status = 'PENDING')
  then
    raise exception
      'invitations: token_hash may rotate only on a PENDING invitation'
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

-- ---------------------------------------------------------------------------
-- 5. EXECUTE grants
-- ---------------------------------------------------------------------------
-- New functions are executable by PUBLIC by default. These three carry the
-- authenticated read path and the only user-driven activation write in the
-- system: revoke from everyone, grant to authenticated only. service_role
-- keeps its own grant and is unaffected.

revoke execute on function public.auth_context() from public, anon;
revoke execute on function public.accept_invitation(text) from public, anon;
revoke execute on function public.touch_last_seen() from public, anon;

grant execute on function public.auth_context() to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.touch_last_seen() to authenticated;
