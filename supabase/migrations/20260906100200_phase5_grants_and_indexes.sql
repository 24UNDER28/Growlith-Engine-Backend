-- Migration 34 — Phase 5 GRANT reconciliation and lookup indexes.
--
-- * profiles.avatar_path is a self-edit column (PATCH /me, PATCH /users/{id}
--   for the caller). Phase 4 granted SELECT but not UPDATE.
-- * invitations.resent_count is part of the invitation DTO the list/get
--   endpoints return; Phase 4 omitted it from the column GRANT (token_hash
--   stays revoked).
-- * lower(full_name) supports `?q=` on GET /users without a sequential scan.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    return;
  end if;

  execute 'grant update (full_name, display_name, timezone, locale, avatar_path)
           on public.profiles to authenticated';

  execute 'grant select (
               id, email, organization_id, organization_role, platform_role,
               invited_by, status, expires_at, accepted_at, accepted_user_id,
               revoked_at, revoked_by, resent_count, last_sent_at, message,
               created_at, updated_at
             ) on public.invitations to authenticated';
end
$$;

create index if not exists profiles_full_name_lower_idx
  on public.profiles (lower(full_name) text_pattern_ops)
  where deleted_at is null;

create index if not exists organizations_display_name_lower_idx
  on public.organizations (lower(display_name) text_pattern_ops)
  where deleted_at is null;
