-- Migration 33 — Phase 5: archive_organization() (ADR-0029).
--
-- Soft-delete of a tenant. Distinct from purge_organization() (hard delete).
-- SUPER_ADMIN only, aal2 is an API concern, 409 if live memberships remain
-- so an archive cannot orphan an ACTIVE client admin. Audits BEFORE the
-- update, in the same transaction.

create or replace function public.archive_organization(
  p_organization_id uuid,
  p_reason          text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_caller uuid := (select auth.uid());
  v_row    public.organizations;
  v_live   integer;
begin
  if not public.is_super_admin() then
    raise exception 'archive_organization: SUPER_ADMIN only'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.organizations o
   where o.id = p_organization_id and o.deleted_at is null
   for update;
  if not found then
    raise exception 'archive_organization: no live organization %', p_organization_id
      using errcode = 'no_data_found';
  end if;

  select count(*) into v_live
  from public.organization_memberships m
  where m.organization_id = p_organization_id
    and m.deleted_at is null;

  if v_live > 0 then
    raise exception 'archive_organization: % live memberships remain', v_live
      using errcode = 'check_violation',
            hint = 'Remove every membership first, then archive.';
  end if;

  perform growlith.phase4_audit(
    v_row.id, 'organization', v_row.id, 'SOFT_DELETE', 'CRITICAL',
    format('organization %s archived: %s', v_row.slug,
           coalesce(nullif(btrim(p_reason), ''), 'no reason given')),
    to_jsonb(v_row) - 'created_at' - 'updated_at',
    jsonb_build_object('status', 'ARCHIVED', 'deleted', true)
  );

  update public.organizations o
     set status     = 'ARCHIVED',
         deleted_at = now(),
         deleted_by = v_caller,
         updated_at = now(),
         updated_by = v_caller
   where o.id = v_row.id;
end;
$$;

revoke execute on function public.archive_organization(uuid, text) from public, anon;
grant execute on function public.archive_organization(uuid, text) to authenticated, service_role;
