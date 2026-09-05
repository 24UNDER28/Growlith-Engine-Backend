-- Migration 31 — Phase 4 (6/6b): the workflow half of the §14 closed RPC set.
-- Same contract as migration 30: SECURITY DEFINER, pinned search_path, the
-- caller's authority RE-READ FROM THE DATABASE inside the body (never an
-- argument), and the audit event in the same transaction as the mutation.

-- ---------------------------------------------------------------------------
-- approve_deliverable() — CLIENT_ADMIN or staff; the client-driven transition
-- ---------------------------------------------------------------------------
-- §B.3: "the only client-driven transition in the system." Everything the
-- matrix obligates (the strict gate, allowed_roles, the approval-columns-only
-- write surface) is ALSO true here; this function is the door, the policy and
-- the column-lock trigger are the frame and the lock (§H.2/E.2).
--
-- REJECTED is accepted ONLY for staff callers: the state machine has no
-- REJECTED deliverable status — a client "no" is a revision request (notes
-- required), while staff may record an outright rejection on the review
-- trail without pretending the deliverable died.

create or replace function public.approve_deliverable(
  p_deliverable_id uuid,
  p_outcome        public.review_outcome,
  p_notes          text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_caller   uuid := (select auth.uid());
  v_is_staff boolean := public.is_platform_admin();
  v_row      public.deliverables;
  v_new_status public.deliverable_status;
begin
  if v_caller is null then
    raise exception 'approve_deliverable: authentication required'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.deliverables d
   where d.id = p_deliverable_id and d.deleted_at is null
   for update;
  if not found then
    raise exception 'approve_deliverable: no live deliverable %', p_deliverable_id
      using errcode = 'no_data_found';
  end if;

  -- Authority, from the database: the tenant's CLIENT_ADMIN, or internal
  -- staff. Not CLIENT_MEMBER, not another tenant's admin, and reachability
  -- is re-resolved live (ADR-0011) rather than trusted from the route that
  -- got here.
  if not v_is_staff and not public.is_client_admin_of(v_row.organization_id) then
    raise exception 'approve_deliverable: reserved for the client administrator of the owning organization and internal staff'
      using errcode = 'insufficient_privilege';
  end if;
  if not v_is_staff and not public.is_active_account() then
    raise exception 'approve_deliverable: account is not active'
      using errcode = 'insufficient_privilege';
  end if;

  if v_row.status <> 'CLIENT_REVIEW' then
    raise exception 'approve_deliverable: % is %, not CLIENT_REVIEW', v_row.id, v_row.status
      using errcode = 'check_violation',
            hint = 'Only a deliverable awaiting client review can be decided.';
  end if;

  if p_outcome = 'REJECTED' and not v_is_staff then
    raise exception 'approve_deliverable: a client decision is APPROVED or REVISION_REQUESTED; REJECTED is an internal review outcome'
      using errcode = 'check_violation';
  end if;

  if p_outcome in ('REVISION_REQUESTED', 'REJECTED')
     and btrim(coalesce(p_notes, '')) = '' then
    raise exception 'approve_deliverable: % requires notes', p_outcome
      using errcode = 'check_violation',
            hint = 'status_transitions.requires_reason is true for this edge; the reason is the review.';
  end if;

  v_new_status := case p_outcome
    when 'APPROVED'           then 'APPROVED'
    when 'REVISION_REQUESTED' then 'REVISION_REQUESTED'
    when 'REJECTED'           then 'REVISION_REQUESTED'  -- staff-recorded rejection keeps the work alive
  end;

  -- The parent update runs THROUGH the state-machine trigger (which re-reads
  -- allowed_roles against the caller's effective role — the same row this
  -- function just consulted is the one the trigger enforces: one definition,
  -- two enforcers, §13) and, for a client caller, through the
  -- approval-columns-only lock of migration 29.
  update public.deliverables d
     set status           = v_new_status,
         approved_at      = case when p_outcome = 'APPROVED' then now() else d.approved_at end,
         approved_by      = case when p_outcome = 'APPROVED' then v_caller else d.approved_by end,
         revision_count   = case when p_outcome = 'APPROVED' then d.revision_count else d.revision_count + 1 end,
         updated_at       = now(),
         updated_by       = v_caller
   where d.id = v_row.id;

  -- The immutable review record (deliverable_versions.review_* columns):
  -- APPROVED closes the CURRENT version row's story, but version rows are
  -- append-only by trigger, so the record of any decision is a NEW row only
  -- where one does not already exist. The authoritative history of THIS
  -- decision is the audit event below; the version row is written only for
  -- the revision path, where a new cycle genuinely begins.
  if v_new_status = 'REVISION_REQUESTED' then
    insert into public.deliverable_versions (
      organization_id, deliverable_id, version_number, status,
      submitted_by, reviewed_by, reviewed_at, review_outcome, review_notes
    ) values (
      v_row.organization_id, v_row.id,
      (select coalesce(max(v.version_number), 0) + 1
         from public.deliverable_versions v where v.deliverable_id = v_row.id),
      'REVISION_REQUESTED',
      null, v_caller, now(), p_outcome, left(btrim(p_notes), 4096)
    );
  end if;

  -- Notification: the deliverable's owner learns the client spoke. Fan-out
  -- to the project lead is deliberately NOT duplicated here: notification
  -- targeting is membership-derived (§5 rule 4) and belongs to the service
  -- layer that owns the "my work" view; this one row is the in-transaction
  -- fact the approval itself creates.
  if v_row.owner_user_id is not null and v_row.owner_user_id <> v_caller then
    insert into public.notifications (
      recipient_user_id, organization_id, notification_type, severity,
      title, body, subject_entity, subject_id
    ) values (
      v_row.owner_user_id, v_row.organization_id,
      case p_outcome when 'APPROVED' then 'DELIVERABLE_APPROVED' else 'REVISION_REQUESTED' end,
      'INFO',
      format('Client %s: %s',
             case p_outcome when 'APPROVED' then 'approved' else 'requested revisions on' end,
             v_row.title),
      nullif(left(btrim(coalesce(p_notes, '')), 2048), ''),
      'deliverable', v_row.id
    );
  end if;

  perform growlith.phase4_audit(
    v_row.organization_id, 'deliverable', v_row.id, 'STATUS_CHANGE', 'NOTICE',
    format('deliverable %s: client review outcome %s%s',
           v_row.id, p_outcome,
           case when p_notes is not null and btrim(p_notes) <> ''
                then ' — ' || left(btrim(p_notes), 300) else '' end),
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('status', v_new_status, 'outcome', p_outcome::text)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- submit_deliverable_review() — staff; §5 rule 2 lives HERE
-- ---------------------------------------------------------------------------
-- "A deliverable version's reviewed_by must be a LEAD or REVIEWER on the
-- project" cannot be a policy (cross-row, §D) and is too stateful for a
-- trigger on the version row (it fires for every writer including the
-- parent's own machinery). The RPC that writes the version row checks it once,
-- and SUPER_ADMIN/ADMIN are exempt because §5 is explicit that membership
-- "narrows nothing" for internal roles.

create or replace function public.submit_deliverable_review(
  p_deliverable_id uuid,
  p_outcome        public.review_outcome,
  p_notes          text default null,
  p_summary        text default null
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_caller   uuid := (select auth.uid());
  v_row      public.deliverables;
  v_role     public.project_member_role;
  v_next     integer;
begin
  if not public.is_platform_admin() then
    raise exception 'submit_deliverable_review: staff only'
      using errcode = 'insufficient_privilege';
  end if;
  if p_outcome = 'REJECTED' and not public.is_super_admin() then
    -- REJECTED as a review OUTCOME with no revision cycle is a judgement
    -- call to kill a work item; §A item 5 classifies "the client has been
    -- shown this" reversals as SUPER_ADMIN territory.
    raise exception 'submit_deliverable_review: REJECTED requires SUPER_ADMIN'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.deliverables d
   where d.id = p_deliverable_id and d.deleted_at is null
   for update;
  if not found then
    raise exception 'submit_deliverable_review: no live deliverable %', p_deliverable_id
      using errcode = 'no_data_found';
  end if;

  if v_row.status <> 'INTERNAL_REVIEW' then
    raise exception 'submit_deliverable_review: % is %, not INTERNAL_REVIEW', v_row.id, v_row.status
      using errcode = 'check_violation';
  end if;

  if p_outcome is distinct from 'APPROVED' and btrim(coalesce(p_notes, '')) = '' then
    raise exception 'submit_deliverable_review: a non-passing review must carry notes'
      using errcode = 'check_violation';
  end if;

  -- §5 rule 2, with the §5.1 exemption for internal roles.
  if not public.is_super_admin() then
    v_role := public.project_role_in(v_row.project_id);
    if v_role is null or v_role not in ('LEAD', 'REVIEWER') then
      raise exception 'submit_deliverable_review: reviewer must be a LEAD or REVIEWER on project % (is: %)',
        v_row.project_id, coalesce(v_role::text, 'none')
        using errcode = 'insufficient_privilege',
              hint = 'authorization.md §5 rule 2; ADMIN holds an override only as SUPER_ADMIN.';
    end if;
  end if;

  if p_outcome = 'APPROVED' then
    v_next := (select coalesce(max(v.version_number), 0) + 1
                 from public.deliverable_versions v
                where v.deliverable_id = v_row.id);

    insert into public.deliverable_versions (
      organization_id, deliverable_id, version_number, summary, status,
      submitted_by, submitted_at, reviewed_by, reviewed_at,
      review_outcome, review_notes
    ) values (
      v_row.organization_id, v_row.id, v_next,
      nullif(btrim(coalesce(p_summary, '')), ''),
      'SUBMITTED',
      coalesce(v_row.owner_user_id, v_caller), now(),
      v_caller, now(), p_outcome, nullif(btrim(coalesce(p_notes, '')), '')
    );

    update public.deliverables d
       set status = 'SUBMITTED',
           current_version = v_next,
           submitted_at = now(),
           updated_at = now(),
           updated_by = v_caller
     where d.id = v_row.id;
  else
    -- A failed internal review records nothing on the immutable version trail
    -- (no version was released); the audit event carries the notes.
    update public.deliverables d
       set status = 'IN_PROGRESS',
           updated_at = now(),
           updated_by = v_caller
     where d.id = v_row.id;
  end if;

  perform growlith.phase4_audit(
    v_row.organization_id, 'deliverable', v_row.id, 'STATUS_CHANGE', 'INFO',
    format('internal review of %s: %s%s', v_row.title, p_outcome,
           case when p_notes is not null and btrim(p_notes) <> ''
                then ' — ' || left(btrim(p_notes), 300) else '' end),
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('outcome', p_outcome::text)
  );

  return coalesce(v_next, 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- publish_report() — staff; freezes report_metrics at the instant of
-- publication (§B.4: "Frozen once published; report_metrics is append-only
-- regardless")
-- ---------------------------------------------------------------------------
-- `reports` is deliberately OUTSIDE the status_transitions machine
-- (migration 20: "a linear lifecycle with no branches to mis-authorize"), so
-- this RPC carries its own legality rules and they are exhaustive: the only
-- legal call is against a live DRAFT or INTERNAL_REVIEW report, and a
-- published report can never be un-published through this door —
-- un-publication a client has already been shown is a §A-item-5 trust event,
-- which in Phase 4 means: it is not a workflow RPC at all.

create or replace function public.publish_report(
  p_report_id     uuid,
  p_client_visible boolean default true
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_caller  uuid := (select auth.uid());
  v_row     public.reports;
  v_metric_rows integer;
  v_notify  boolean;
begin
  if not public.is_platform_admin() or not public.is_active_account() then
    raise exception 'publish_report: active internal staff only'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.reports r
   where r.id = p_report_id and r.deleted_at is null
   for update;
  if not found then
    raise exception 'publish_report: no live report %', p_report_id
      using errcode = 'no_data_found';
  end if;
  if v_row.status not in ('DRAFT', 'INTERNAL_REVIEW') then
    raise exception 'publish_report: % is already %', v_row.id, v_row.status
      using errcode = 'check_violation',
            hint = 'A published report is a frozen statement; corrections are a NEW report period, not an edit.';
  end if;

  -- Freeze the figures: one report_metrics row per metric_key/unit, summed
  -- over the report's period, plus the comparison from the immediately
  -- preceding window of the same length (§B.4: frozen at the instant of
  -- publication, reproducible forever after).
  insert into public.report_metrics (
    organization_id, report_id, metric_key, value, unit, currency,
    comparison_value, comparison_label, sort_order
  )
  select
    v_row.organization_id, v_row.id, cur.metric_key, cur.total, cur.unit, cur.currency,
    prev.total,
    'prior period',
    row_number() over (order by cur.metric_key)::smallint - 1
  from (
    select m.metric_key, m.unit, m.currency, sum(m.value) as total
    from public.metrics m
    where m.organization_id = v_row.organization_id
      and m.metric_date between v_row.period_start and v_row.period_end
      and (v_row.service_id is null or m.service_id = v_row.service_id)
    group by 1, 2, 3
  ) cur
  left join (
    select m.metric_key, m.unit, m.currency, sum(m.value) as total
    from public.metrics m
    where m.organization_id = v_row.organization_id
      and m.metric_date between
            (v_row.period_start - (v_row.period_end - v_row.period_start + 1))
            and (v_row.period_start - 1)
      and (v_row.service_id is null or m.service_id = v_row.service_id)
    group by 1, 2, 3
  ) prev
    on prev.metric_key = cur.metric_key
   and prev.unit = cur.unit
   and prev.currency is not distinct from cur.currency;
  get diagnostics v_metric_rows = row_count;

  update public.reports r
     set status = 'PUBLISHED',
         published_at = now(),
         published_by = v_caller,
         client_visible = p_client_visible,
         updated_at = now(),
         updated_by = v_caller
   where r.id = v_row.id;

  -- Client notification, gated by the tenant's own setting (§G: notification
  -- preferences ARE settings), to every live CLIENT_ADMIN of the tenant.
  if p_client_visible then
    select coalesce(s.notify_on_report_published, true) into v_notify
    from public.organization_settings s where s.organization_id = v_row.organization_id;
    if coalesce(v_notify, true) then
      insert into public.notifications (
        recipient_user_id, organization_id, notification_type, severity,
        title, body, subject_entity, subject_id
      )
      select m.user_id, v_row.organization_id, 'REPORT_PUBLISHED', 'INFO',
             v_row.title,
             format('Report for %s to %s is available.', v_row.period_start, v_row.period_end),
             'report', v_row.id
      from public.organization_memberships m
      where m.organization_id = v_row.organization_id
        and m.role = 'CLIENT_ADMIN'
        and m.status = 'ACTIVE'
        and m.deleted_at is null;
    end if;
  end if;

  perform growlith.phase4_audit(
    v_row.organization_id, 'report', v_row.id, 'STATUS_CHANGE', 'NOTICE',
    format('report %s published (%s metric rows frozen)', v_row.id, v_metric_rows),
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('status', 'PUBLISHED', 'client_visible', p_client_visible,
                       'metrics_frozen', v_metric_rows)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- purge_organization() — SUPER_ADMIN, audited BEFORE destroying (§14)
-- ---------------------------------------------------------------------------
-- The ordering is not stylistic: an audit write that follows the deletes is
-- an audit write that can be rolled back by the deletes' failure, or lost
-- with them. HARD_DELETE is written first; then, and only then, the
-- append-only escape hatch is armed FOR THIS TRANSACTION and the cascade runs.
-- profiles survive — people are not an organization's property; a person's
-- erasure is `erase_user()`, its own SUPER_ADMIN decision, its own audit.
--
-- Assumption (inherited from the whole §14 design and Phase 3's definer
-- functions): the migration role that OWNS these functions can write through
-- FORCE RLS on the children (it is the table owner with the platform's
-- superuser-equivalence). On a deployment where that is false, this RPC fails
-- loudly — it never silently half-purges, which is the correct failure.

create or replace function public.purge_organization(p_organization_id uuid, p_confirm_slug text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_row public.organizations;
begin
  if not public.is_super_admin() then
    raise exception 'purge_organization: SUPER_ADMIN only'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.organizations o where o.id = p_organization_id;
  if not found then
    raise exception 'purge_organization: no organization %', p_organization_id
      using errcode = 'no_data_found';
  end if;

  if lower(btrim(p_confirm_slug)) <> lower(v_row.slug::text) then
    raise exception 'purge_organization: confirmation slug % does not match %',
      p_confirm_slug, v_row.slug
      using errcode = 'check_violation';
  end if;

  -- The audit event, FIRST, with the identity of what is about to cease to
  -- exist. entity_id is the organization row itself (no organization_id
  -- column — the root names itself, per the Phase 2 convention).
  perform growlith.phase4_audit(
    v_row.id, 'organization', v_row.id, 'HARD_DELETE', 'CRITICAL',
    format('organization % (%s) purged', v_row.slug, v_row.id),
    to_jsonb(v_row),
    null
  );

  -- Arm the escape hatch for reject_mutation()/append-only triggers, for THIS
  -- transaction only (true = local). PostgREST callers cannot set GUCs; only
  -- this definer body can reach this line, and only a SUPER_ADMIN reached
  -- this function.
  perform set_config('growlith.allow_purge', 'on', true);

  -- Children before parents; explicit, so a future FK direction change
  -- cannot turn "cascade does it" into "cascade did it to the wrong rows".
  delete from public.notifications        where organization_id = p_organization_id;
  delete from public.comments             where organization_id = p_organization_id;
  delete from public.files                where organization_id = p_organization_id;
  delete from public.deliverable_versions v
    using public.deliverables d where v.deliverable_id = d.id and d.organization_id = p_organization_id;
  delete from public.tasks t              using public.projects p where t.project_id = p.id and p.organization_id = p_organization_id;
  delete from public.tasks                where organization_id = p_organization_id;
  delete from public.deliverables         where organization_id = p_organization_id;
  delete from public.project_memberships  where organization_id = p_organization_id;
  delete from public.projects             where organization_id = p_organization_id;
  delete from public.report_metrics       where organization_id = p_organization_id;
  delete from public.reports              where organization_id = p_organization_id;
  delete from public.metrics              where organization_id = p_organization_id;
  delete from public.services             where organization_id = p_organization_id;
  delete from public.engagements          where organization_id = p_organization_id;
  delete from public.invitations          where organization_id = p_organization_id;
  delete from public.organization_settings where organization_id = p_organization_id;
  delete from public.organization_memberships where organization_id = p_organization_id;
  delete from public.organizations        where id = p_organization_id;

  -- Disarm early on purpose: anything this transaction writes AFTER this
  -- point (nothing should, but "should" is what the tripwire is for) is back
  -- under the append-only rules.
  perform set_config('growlith.allow_purge', 'off', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- erase_user() — SUPER_ADMIN; GDPR erasure (§A item 3)
-- ---------------------------------------------------------------------------
-- No row is deleted (RESTRICT edges from memberships, comments and audit make
-- deletion either a lie or an avalanche); the identity is TOMBSTONED: every
-- personal value is overwritten, notifications and their personal text are
-- removed, comment bodies are scrubbed in place to keep threads intact, and
-- the audit records that it happened with an actor and a reason — never the
-- erased content itself. "bypasses append-only triggers by definition"
-- (§14): the deliverable_versions trail keeps its rows (they belong to the
-- organization's work product, not the person), and that IS the balance
-- GDPR's erasure-vs-integrity tension asks for here.

create or replace function public.erase_user(p_user_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_caller uuid := (select auth.uid());
  v_row    public.profiles;
begin
  if not public.is_super_admin() then
    raise exception 'erase_user: SUPER_ADMIN only'
      using errcode = 'insufficient_privilege';
  end if;
  if p_user_id = v_caller then
    raise exception 'erase_user: you cannot erase your own identity while signed in'
      using errcode = 'insufficient_privilege';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'erase_user: a reason is required'
      using errcode = 'check_violation';
  end if;

  select * into v_row from public.profiles where id = p_user_id;
  if not found then
    raise exception 'erase_user: no profile %', p_user_id
      using errcode = 'no_data_found';
  end if;

  -- Write the fact BEFORE the erasure, without the content: after-blob names
  -- what WAS scrubbed, never what was scrubbed from.
  perform growlith.phase4_audit(
    null, 'profile', p_user_id, 'UPDATE', 'CRITICAL',
    format('identity erased: %s', left(btrim(p_reason), 300)),
    null,
    jsonb_build_object(
      'erased_columns',
      jsonb_build_array('email', 'full_name', 'display_name', 'phone', 'avatar_path',
                        'last_seen_at', 'mfa_enrolled_at', 'notifications', 'comment_bodies'),
      'had_user_type', v_row.user_type::text
    )
  );

  -- Live power first, then presence, then content.
  update public.platform_role_grants g
     set revoked_at = now(), revoked_by = v_caller,
         revoke_reason = 'identity erased'
   where g.user_id = p_user_id and g.revoked_at is null;

  update public.organization_memberships m
     set deleted_at = now(), deleted_by = v_caller,
         status = 'DEACTIVATED', is_primary_contact = false
   where m.user_id = p_user_id and m.deleted_at is null;

  delete from public.notifications where recipient_user_id = p_user_id;

  update public.comments c
     set body = '[removed at the subject''s request]',
         is_internal = true,
         edited_at = now(),
         updated_by = v_caller,
         updated_at = now()
   where c.author_user_id = p_user_id
     and c.body is not null
     and c.body <> '[removed at the subject''s request]';

  -- Assignment edges point at a person; the work survives them.
  update public.tasks t set assignee_user_id = null, updated_by = v_caller, updated_at = now()
   where t.assignee_user_id = p_user_id;
  update public.projects pr set lead_user_id = null, updated_by = v_caller, updated_at = now()
   where pr.lead_user_id = p_user_id;
  update public.services s set lead_user_id = null, updated_by = v_caller, updated_at = now()
   where s.lead_user_id = p_user_id;
  update public.engagements e set account_manager_user_id = null, updated_by = v_caller, updated_at = now()
   where e.account_manager_user_id = p_user_id;
  update public.organizations o set account_manager_user_id = null, updated_by = v_caller, updated_at = now()
   where o.account_manager_user_id = p_user_id;

  update public.profiles p
     set email           = ('erased-' || p.id || '@erasure.invalid')::extensions.citext,
         full_name       = 'Erased User',
         display_name    = null,
         avatar_path     = null,
         phone           = null,
         last_seen_at    = null,
         mfa_enrolled_at = null,
         account_status  = 'DEACTIVATED',
         deleted_at      = now(),
         deleted_by      = v_caller,
         updated_at      = now()
   where p.id = p_user_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- client_activity_feed() — the projected feed, §F.4
-- ---------------------------------------------------------------------------
-- A whitelist in a function body is reviewable; a JSONB predicate in a policy
-- is not. No actor identity, no IP, no diff — and the row is only ever a
-- TITLE: names of work the client already sees through the visibility gates.
-- A dangling entity (purged) degrades to 'Item', never to a 500: this is a
-- feed, not an integrity check.

create or replace function public.client_activity_feed(
  p_organization_id uuid,
  p_limit           integer default 50,
  p_before          timestamptz default null
)
returns table (
  occurred_at   timestamptz,
  entity_kind   public.entity_kind,
  entity_id     uuid,
  action        public.audit_action,
  display_title text
)
language sql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select
    a.occurred_at,
    a.entity_kind,
    a.entity_id,
    a.action,
    coalesce(
      nullif(d.title, ''),
      nullif(pr.name, ''),
      nullif(r.title, ''),
      nullif(e.name, ''),
      nullif(s.name, ''),
      'Item'
    ) as display_title
  from public.audit_events a
  left join public.deliverables d on a.entity_kind = 'deliverable' and d.id = a.entity_id and d.deleted_at is null
  left join public.projects pr     on a.entity_kind = 'project'     and pr.id = a.entity_id and pr.deleted_at is null
  left join public.reports r       on a.entity_kind = 'report'      and r.id = a.entity_id and r.deleted_at is null
  left join public.engagements e   on a.entity_kind = 'engagement'  and e.id = a.entity_id and e.deleted_at is null
  left join public.services s      on a.entity_kind = 'service'     and s.id = a.entity_id and s.deleted_at is null
  left join public.comments c       on a.entity_kind = 'comment'     and c.id = a.entity_id and c.deleted_at is null
  where a.organization_id = p_organization_id
    -- Tenant reach, the ONLY authority the feed consults beyond the whitelist
    -- (clients and staff alike pass through has_org_access).
    and public.has_org_access(p_organization_id)
    and public.is_active_account()
    -- §F.4's allowlist, in both dimensions.
    and a.action in ('CREATE', 'UPDATE', 'STATUS_CHANGE', 'SOFT_DELETE')
    and a.entity_kind in ('engagement', 'service', 'project', 'deliverable', 'report', 'comment')
    and (a.entity_kind <> 'comment' or coalesce(c.is_internal, true) is not true)
    and (p_before is null or a.occurred_at < p_before)
  order by a.occurred_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

-- ---------------------------------------------------------------------------
-- ACLs
-- ---------------------------------------------------------------------------

revoke execute on function
  public.approve_deliverable(uuid, public.review_outcome, text),
  public.submit_deliverable_review(uuid, public.review_outcome, text, text),
  public.publish_report(uuid, boolean),
  public.purge_organization(uuid, text),
  public.erase_user(uuid, text),
  public.client_activity_feed(uuid, integer, timestamptz)
  from public, anon;

grant execute on function
  public.approve_deliverable(uuid, public.review_outcome, text),
  public.submit_deliverable_review(uuid, public.review_outcome, text, text),
  public.publish_report(uuid, boolean),
  public.purge_organization(uuid, text),
  public.erase_user(uuid, text),
  public.client_activity_feed(uuid, integer, timestamptz)
  to authenticated, service_role;
