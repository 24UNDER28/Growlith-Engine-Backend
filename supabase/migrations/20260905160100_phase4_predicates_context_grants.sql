-- Migration 25 — Phase 4 (1/6): predicate helpers, extended auth_context(),
-- and the GRANT reconciliation that closes exactly what the matrix closes.
--
-- This migration creates NO policies; the policy set follows in 26–28. What
-- it does is make the policies possible and honest:
--
--   * §5.2's three project-membership helpers, same contract as the Phase 2
--     set (SECURITY DEFINER, STABLE, pinned search_path, execute granted to
--     `authenticated` — ADR-0008);
--   * the object-visibility helpers §E/§H.3 require so that NO policy body
--     ever queries a tenant table directly;
--   * §H.6's `can_read_storage_object()`, which keeps the two storage
--     mechanisms (path prefix and metadata row) from drifting apart;
--   * `auth_context()` grows `teams`, `projectRoles` and `projectRolesOverflow`
--     on the SAME round trip (§2: the guard needs them; a second query per
--     request would be the first crack in the one-shot design);
--   * the column- and command-level GRANT reconciliation of §F.1/§E.2 —
--     writes the matrix denies become writes the database cannot express at
--     all, independent of any row policy.

-- ---------------------------------------------------------------------------
-- §5.2 — project-membership predicates
-- ---------------------------------------------------------------------------

-- Vocabulary extension Phase 4 requires: report publication is auditable
-- (§B.4) and appears in the projected client feed (§F.4), so `report` becomes
-- an audit subject. APPENDED, never interleaved — enum labels are positional
-- (the `profile` precedent, migration 24); and since PostgreSQL 12 the
-- statement is legal in a transaction as long as the value is not READ back
-- inside the same one — this file does not use it, migrations 30–31 do.
alter type public.entity_kind add value if not exists 'report';

create or replace function public.current_project_ids()
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  -- Backed by project_memberships_user_idx (migration 11) — same shape as
  -- current_org_ids(), for exactly the same reason: one index scan per policy
  -- evaluation, no subquery in any policy body.
  select coalesce(array_agg(pm.project_id), '{}'::uuid[])
  from public.project_memberships pm
  where pm.user_id = auth.uid()
    and pm.deleted_at is null;
$$;

create or replace function public.project_role_in(p_project_id uuid)
returns public.project_member_role
language sql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select pm.project_role
  from public.project_memberships pm
  where pm.user_id = auth.uid()
    and pm.project_id = p_project_id
    and pm.deleted_at is null
  limit 1;
$$;

create or replace function public.is_project_member(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select p_project_id is not null
     and (p_project_id = any (public.current_project_ids()));
$$;

-- ---------------------------------------------------------------------------
-- §E — object-visibility predicates (the GATE, not the capability)
-- ---------------------------------------------------------------------------
-- Each returns TRUE only when the named row is inside the caller's tenant AND
-- released to clients. They exist so `deliverable_versions`, `files`,
-- `comments` and `storage.objects` policies can gate on a PARENT's rule
-- without inlining that rule a second time — the single most likely source of
-- policy drift is a parent gate re-expressed per child table.

create or replace function public.project_is_client_visible(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select exists (
    select 1
    from public.projects pr
    where pr.id = p_project_id
      and pr.deleted_at is null
      and pr.client_visible
      and public.has_org_access(pr.organization_id)
  );
$$;

-- E.1, verbatim: the strict deliverable gate. Both flag and status, even
-- though the Phase 2 CHECK makes one imply the other — the redundancy IS the
-- control.
create or replace function public.deliverable_is_client_visible(p_deliverable_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select exists (
    select 1
    from public.deliverables d
    where d.id = p_deliverable_id
      and d.deleted_at is null
      and d.client_visible
      and d.status in ('CLIENT_REVIEW', 'REVISION_REQUESTED', 'APPROVED', 'PUBLISHED')
      and public.has_org_access(d.organization_id)
  );
$$;

-- §E reports: published AND flagged. DRAFT/INTERNAL_REVIEW/ARCHIVED never
-- reach a client through any path.
create or replace function public.report_is_client_visible(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select exists (
    select 1
    from public.reports r
    where r.id = p_report_id
      and r.deleted_at is null
      and r.client_visible
      and r.status = 'PUBLISHED'
      and public.has_org_access(r.organization_id)
  );
$$;

-- §H.4 profiles client-select: "co-members, narrowed". The narrowing is the
-- column GRANT below; this predicate is only the graph question — does the
-- caller share any ACTIVE organization with the subject.
create or replace function public.shares_org_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select p_user_id is not null
     and (select auth.uid()) is not null
     and exists (
       select 1
       from public.organization_memberships mine
       join public.organization_memberships theirs
         on theirs.organization_id = mine.organization_id
       where mine.user_id = (select auth.uid())
         and theirs.user_id = p_user_id
         and mine.status = 'ACTIVE'
         and theirs.status = 'ACTIVE'
         and mine.deleted_at is null
         and theirs.deleted_at is null
     );
$$;

-- ---------------------------------------------------------------------------
-- §H.6 — storage
-- ---------------------------------------------------------------------------

-- Phase 2's can_access_storage_path() checks TENANCY ONLY and stays exactly
-- that (upload writes the object before the metadata row exists). Reads go
-- through the STRONGER predicate below: the flag lives on `files`, not on the
-- path, and a path-only read check would expose internal working files sitting
-- under the same org prefix.
create or replace function public.can_read_storage_object(p_path text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select public.is_platform_admin()
      or exists (
        select 1
        from public.files f
        where f.storage_path = p_path
          and f.deleted_at is null
          and f.client_visible
          and f.virus_scan_status = 'CLEAN'
          and public.has_org_access(f.organization_id)
      );
$$;

-- ---------------------------------------------------------------------------
-- The one deny-path audit writer (§11: denials are audited)
-- ---------------------------------------------------------------------------
-- Client-reachable on purpose — a denial by definition happens on the request
-- path — but the narrowest such function the schema will ever have: fixed
-- action vocabulary via parameter type, actor pinned to auth.uid(), no way to
-- write any other row kind, and it refuses when there IS no caller.
create or replace function public.record_authorization_denial(
  p_organization_id uuid,
  p_entity_kind     public.entity_kind,
  p_entity_id       uuid,
  p_reason          text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    -- Anonymous denials are probes, not permission events: unauthenticated
    -- traffic must never write the audit trail.
    return;
  end if;

  insert into public.audit_events (
    organization_id, actor_user_id, actor_role, entity_kind, entity_id,
    action, severity, reason
  ) values (
    p_organization_id,
    v_actor,
    coalesce(public.auth_platform_role()::text, 'CLIENT'),
    p_entity_kind,
    p_entity_id,
    'PERMISSION_DENIED',
    'WARNING',
    left(coalesce(btrim(p_reason), 'unspecified'), 512)
  );
exception
  when insufficient_privilege then
    -- service_role must never need this path; if a future caller wires it
    -- wrong, the audit insert failing must not mask the original 403.
    return;
end;
$$;

-- ---------------------------------------------------------------------------
-- auth_context() — Phase 4 shape (same round trip, §2)
-- ---------------------------------------------------------------------------

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
    ), '[]'::jsonb),
    -- Phase 4 additions (§2): the same three facts the guard would otherwise
    -- pay a query each for. Capped, never cached (§2 risk A-4: a truncated
    -- map is flagged by projectRolesOverflow and the caller falls back to
    -- project_role_in() per project — truncation never silently permits).
    'teams', coalesce((
      select jsonb_agg(distinct t.team::text order by t.team::text)
      from public.staff_team_memberships t
      where t.user_id = p.id
        and t.deleted_at is null
    ), '[]'::jsonb),
    'projectRoles', coalesce((
      select jsonb_agg(capped.order
        order by capped.project_id
      )
      from (
        select
          pm.project_id,
          jsonb_build_object('projectId', pm.project_id, 'role', pm.project_role::text) as order
        from public.project_memberships pm
        where pm.user_id = p.id
          and pm.deleted_at is null
        order by pm.project_id
        limit 500
      ) capped
    ), '[]'::jsonb),
    'projectRolesOverflow', (
      select count(*) > 500
      from public.project_memberships pm
      where pm.user_id = p.id
        and pm.deleted_at is null
    )
  )
  from public.profiles p
  where p.id = auth.uid()
    and p.deleted_at is null;
$$;

comment on function public.auth_context() is
  'Identity + platform role + live memberships + teams + project roles of the '
  'current user, as jsonb, in ONE round trip. SECURITY DEFINER because the '
  'membership/grant tables stay closed to client SELECT even under RLS; the '
  'payload describes only the caller. Never trusted from JWT claims '
  '(ADR-0011); Phase 4 added teams/projectRoles on the same contract.';

-- ---------------------------------------------------------------------------
-- Function ACLs for the new surface
-- ---------------------------------------------------------------------------

revoke execute
  on function
    public.current_project_ids(),
    public.project_role_in(uuid),
    public.is_project_member(uuid),
    public.project_is_client_visible(uuid),
    public.deliverable_is_client_visible(uuid),
    public.report_is_client_visible(uuid),
    public.shares_org_with(uuid),
    public.can_read_storage_object(text),
    public.record_authorization_denial(uuid, public.entity_kind, uuid, text)
  from public, anon;

-- The policies themselves evaluate these as the querying role; the API also
-- calls record_authorization_denial() directly. service_role needs execute
-- because the Next server calls the denial audit through the user-JWT client
-- and the definer triggers call the visibility helpers as owner — both fine —
-- but admin tooling evaluates them as service_role too.
grant execute
  on function
    public.current_project_ids(),
    public.project_role_in(uuid),
    public.is_project_member(uuid),
    public.project_is_client_visible(uuid),
    public.deliverable_is_client_visible(uuid),
    public.report_is_client_visible(uuid),
    public.shares_org_with(uuid),
    public.can_read_storage_object(text),
    public.record_authorization_denial(uuid, public.entity_kind, uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- §F.1 / §E.2 — GRANT reconciliation (deny at the privilege layer)
-- ---------------------------------------------------------------------------
-- Everything below is guarded on `authenticated` existing, exactly like
-- migration 23, so the file stays a no-op in environments without the
-- Supabase roles.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    return;
  end if;

  -- ── Writes the matrix needs at the table level ──────────────────────────
  -- Staff-side CRUD that Phase 2 left closed pending the policy set. The
  -- ROWS these writes may touch are decided entirely by the policies in
  -- migrations 26–28; being granted here means nothing without them.
  execute 'grant insert, update on
             public.organizations,
             public.engagements,
             public.services,
             public.reports,
             public.staff_team_memberships,
             public.invitations,
             public.project_memberships
           to authenticated';

  execute 'grant insert on
             public.deliverable_versions,
             public.metrics,
             public.report_metrics
           to authenticated';

  -- ── Writes the matrix DENIES, removed from the privilege layer ──────────
  -- notification:create is ✗ for every role ("server-side emission only, via
  -- definer", §B.4). A GRANT for it would be a contradiction the policies
  -- would have to outvote on every insert.
  execute 'revoke insert on public.notifications from authenticated';

  -- notification:update is exactly read_at/archived_at (§B.4). A table-wide
  -- UPDATE could rewrite the message itself; column privileges cannot.
  execute 'revoke update on public.notifications from authenticated';
  execute 'grant update (read_at, archived_at) on public.notifications to authenticated';

  -- ── profiles: read narrowed by COLUMN (§F.1), write limited to self-edit
  -- columns. phone/last_seen_at/mfa_enrolled_at join the never-granted set —
  -- presence is delivered through auth_context()/definer paths only, and a
  -- column nobody can select cannot leak through a future policy mistake.
  execute 'revoke select on public.profiles from authenticated';
  execute 'grant select (
               id, email, full_name, display_name, avatar_path, timezone,
               locale, user_type, account_status, created_at, updated_at, deleted_at
             ) on public.profiles to authenticated';
  execute 'grant update (full_name, display_name, timezone, locale) on public.profiles to authenticated';

  -- ── invitations: never the token (§B.1 note, §F.1). accept_invitation() —
  -- the only legitimate reader of token_hash — is definer and unaffected.
  execute 'revoke select on public.invitations from authenticated';
  execute 'grant select (
               id, email, organization_id, organization_role, platform_role,
               invited_by, status, expires_at, accepted_at, accepted_user_id,
               revoked_at, revoked_by, last_sent_at, message, created_at, updated_at
             ) on public.invitations to authenticated';

  -- ── project_memberships: allocation_pct is the [C] column of §B.3. The
  -- roster itself stays visible to the tenant — it is the PEOPLE, and the
  -- PEOPLE are the point of a visible project.
  execute 'revoke select on public.project_memberships from authenticated';
  execute 'grant select (
               id, organization_id, project_id, user_id, project_role,
               added_by, created_at, updated_at, deleted_at, deleted_by
             ) on public.project_memberships to authenticated';
end
$$;

-- account_status changes (suspend/reinstate/deactivate) are user:update ADMIN
-- with [R]: the definer RPC, CRITICAL-audited, never a column anyone can
-- write through PostgREST. The profiles UPDATE grant above simply does not
-- contain the column.
