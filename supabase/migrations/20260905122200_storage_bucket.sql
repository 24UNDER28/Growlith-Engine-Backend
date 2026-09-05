-- Migration 22 — private Storage bucket
--
-- One private bucket. Every object lives under `{organization_id}/…`, which is
-- the SECOND, independent tenant-isolation mechanism (the first is the
-- `files.organization_id` column and its composite FKs). The two must always
-- agree; the pgTAP suite asserts they do.
--
-- Storage POLICIES are not written here. They are authorization, and belong to
-- Phase 4 alongside the table policies, so that the whole access surface is
-- reviewed as one artefact rather than in two halves that can disagree.
-- What this migration does is create the bucket, make it private, and install
-- the helper the future policies will use — so the bucket can never exist in a
-- public state, even transiently.
--
-- The whole file is guarded on `storage.buckets` existing, so it is a no-op on
-- a bare PostgreSQL used for schema validation and applies normally on
-- Supabase.

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice
      'storage.buckets not present (bare PostgreSQL); skipping bucket creation';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'growlith-private',
    'growlith-private',
    false,                    -- never public; access is via signed URLs only
    524288000,                -- 500 MB: video deliverables are a service line
    null                      -- MIME allow-listing is enforced in the upload path
  )
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit;
end
$$;

-- ---------------------------------------------------------------------------
-- The path-prefix predicate
-- ---------------------------------------------------------------------------
-- Phase 4's storage.objects policies reduce to this call. Defined now so the
-- rule lives in one place and the pgTAP suite can test it directly, rather
-- than being re-expressed inside four separate policy bodies where one could
-- silently drift.
create or replace function public.storage_path_org_id(p_path text)
returns uuid
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when split_part(p_path, '/', 1) ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(p_path, '/', 1)::uuid
    else null
  end;
$$;

comment on function public.storage_path_org_id(text) is
  'Extracts the organization id from an org-prefixed storage path, or NULL if '
  'the path is not prefixed. A NULL result must always deny access.';

create or replace function public.can_access_storage_path(p_path text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(
    public.has_org_access(public.storage_path_org_id(p_path)),
    false
  );
$$;

comment on function public.can_access_storage_path(text) is
  'The single predicate every Phase 4 storage.objects policy will use. '
  'Deny-by-default: an unprefixed path yields NULL, coalesced to false.';
