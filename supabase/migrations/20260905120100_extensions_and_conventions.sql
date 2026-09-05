-- Migration 01 — extensions and shared conventions
--
-- Purpose: everything every later migration depends on. Extensions, the schema
-- for internal helper functions, and the generic trigger functions that
-- implement the conventions agreed in the Phase 2 design:
--
--   * `updated_at` is maintained by the database, never by the client;
--   * `organization_id` on a tenant-scoped row is DERIVED from its parent and
--     is immutable thereafter, so it can never be forged or drift;
--   * append-only tables reject UPDATE and DELETE outright.
--
-- Forward-only. Never edited after it has been applied anywhere.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
-- pgcrypto: gen_random_uuid() and digest() for invitation token hashing.
-- citext:   case-insensitive email and slug comparison without lower() on
--           every predicate (and therefore without every index needing to be
--           expression-based).
--
-- Supabase hosts extensions in the `extensions` schema. A bare local
-- PostgreSQL has no such schema, so it is created first; on Supabase the
-- CREATE SCHEMA is a no-op and the extensions are already present, making the
-- whole block idempotent in both environments.
--
-- Types from these extensions are referenced fully qualified
-- (`extensions.citext`) throughout the schema rather than relying on
-- search_path, so migrations resolve identically no matter which role applies
-- them.
create schema if not exists extensions;
grant usage on schema extensions to public;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;

-- ---------------------------------------------------------------------------
-- Internal helper schema
-- ---------------------------------------------------------------------------
-- `growlith` holds trigger functions and, later, the SECURITY DEFINER RLS
-- helpers. Keeping them out of `public` means PostgREST never exposes them as
-- RPC endpoints by accident — an exposure that would be silent and total.
create schema if not exists growlith;

comment on schema growlith is
  'Internal helpers: trigger functions and (from migration 07) SECURITY DEFINER '
  'RLS predicates. Never exposed through PostgREST.';

revoke all on schema growlith from public;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function growlith.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function growlith.set_updated_at() is
  'BEFORE UPDATE trigger. Forces updated_at to the transaction timestamp so a '
  'client can never backdate a row or forget to touch it.';

-- ---------------------------------------------------------------------------
-- Tenant key derivation
-- ---------------------------------------------------------------------------
-- TG_ARGV[0] = name of the FK column pointing at the parent
-- TG_ARGV[1] = fully-qualified parent table
--
-- On INSERT the tenant key is read from the parent row and overwrites whatever
-- the client supplied. This removes the entire class of "attacker posts a
-- different organization_id": the column is not client input at all.
create or replace function growlith.derive_organization_id()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_parent_column constant text := tg_argv[0];
  v_parent_table  constant text := tg_argv[1];
  v_parent_id     uuid;
  v_org_id        uuid;
begin
  execute format('select ($1).%I', v_parent_column) into v_parent_id using new;

  if v_parent_id is null then
    -- Optional parents (a task with no deliverable) are legitimate; the row's
    -- own organization_id is then already set by another trigger or by the
    -- caller and is validated by the composite foreign key.
    return new;
  end if;

  execute format('select organization_id from %s where id = $1', v_parent_table)
    into v_org_id using v_parent_id;

  if v_org_id is null then
    raise exception
      'parent row % not found in % — cannot derive organization_id',
      v_parent_id, v_parent_table
      using errcode = 'foreign_key_violation';
  end if;

  -- If the caller supplied a tenant key, it must agree with the parent's.
  --
  -- Silently overwriting a mismatch was the first implementation and it was
  -- wrong: an operator who attached a project to the wrong service would have
  -- had the row quietly re-homed into ANOTHER TENANT and returned as success.
  -- The composite FK would then be satisfied, because by that point the row is
  -- internally consistent. A misdirected write must fail loudly.
  if new.organization_id is not null and new.organization_id <> v_org_id then
    raise exception
      'tenant mismatch: parent % belongs to organization %, but the row '
      'declares organization %',
      v_parent_id, v_org_id, new.organization_id
      using errcode = 'check_violation';
  end if;

  new.organization_id := v_org_id;
  return new;
end;
$$;

comment on function growlith.derive_organization_id() is
  'BEFORE INSERT trigger. Reads organization_id from the parent row, ignoring '
  'any client-supplied value. Composite FKs then make drift impossible.';

-- ---------------------------------------------------------------------------
-- Tenant key immutability
-- ---------------------------------------------------------------------------
create or replace function growlith.freeze_organization_id()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'organization_id is immutable (attempted % -> %)',
      old.organization_id, new.organization_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function growlith.freeze_organization_id() is
  'BEFORE UPDATE trigger. Moving a row between tenants is never a valid '
  'operation; the correct action is create-in-target plus soft-delete-in-source.';

-- ---------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------
create or replace function growlith.reject_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  -- Single, explicit escape hatch. The GDPR-erasure purge must be able to
  -- physically remove a tenant's rows, and a cascade from a hard-deleted
  -- parent must not deadlock against its own children. The flag is set by the
  -- Phase 4 purge RPC (SUPER_ADMIN only, SECURITY DEFINER) for the duration of
  -- one transaction and is invisible to PostgREST callers, who cannot issue
  -- `set_config`. Every purge writes a HARD_DELETE audit event first.
  if current_setting('growlith.allow_purge', true) = 'on' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  raise exception '% is append-only; % is not permitted', tg_table_name, tg_op
    using errcode = 'insufficient_privilege',
          hint = 'Append a corrective row instead of mutating history.';
end;
$$;

comment on function growlith.reject_mutation() is
  'BEFORE UPDATE OR DELETE trigger for append-only tables (audit_events, '
  'deliverable_versions, report_metrics). Applies to every role including '
  'service_role, which bypasses RLS but not triggers. Bypassed only inside a '
  'transaction that has set growlith.allow_purge = on.';

-- ---------------------------------------------------------------------------
-- Soft-delete coherence
-- ---------------------------------------------------------------------------
create or replace function growlith.enforce_soft_delete_fields()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.deleted_at is null and new.deleted_by is not null then
    raise exception 'deleted_by set without deleted_at on %', tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
