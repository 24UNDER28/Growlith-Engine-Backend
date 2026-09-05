-- Migration 26 — Phase 3 authentication enum values
--
-- Additive `alter type ... add value` ONLY, in its own migration with no other
-- statement, per the PostgreSQL restriction that a value added inside a
-- transaction cannot be used before that transaction commits
-- (`scripts/db-apply.mjs` runs the whole file set in ONE transaction, so this
-- separation is load-bearing, not stylistic).
--
-- Values added:
--   audit_action : LOGOUT, PASSWORD_RESET_REQUESTED, MFA_ENROLLED, MFA_REMOVED,
--                  SESSIONS_REVOKED
--   entity_kind  : profile
--
-- `entity_kind` must stay byte-identical to ENTITY_KINDS in
-- `src/lib/domain/entities.ts`; the parity test in tests/unit/schema.spec.ts
-- reads both the `create type` statement and any `alter type ... add value`
-- statements, in order, so it covers this migration too.
--
-- Guarded by a catalog check rather than `if not exists`, which PostgreSQL does
-- not support for ADD VALUE — re-running the file locally stays harmless.

do $$
begin
  -- ---------------------------------------------------------------------
  -- audit_action: the Phase 3 runtime writes
  -- ---------------------------------------------------------------------
  -- Each name is an event with an actor, not a status: LOGOUT is the
  -- account holder ending their own sessions globally; SESSIONS_REVOKED is
  -- the system ending them (suspension, deactivation, password change);
  -- MFA_ENROLLED / MFA_REMOVED are factor lifecycle; PASSWORD_RESET_REQUESTED
  -- records that a recovery email was sent (never whether it succeeded —
  -- that would disclose which addresses hold accounts).
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'audit_action'
      and e.enumlabel = 'LOGOUT'
  ) then
    alter type public.audit_action add value 'LOGOUT';
  end if;

  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'audit_action'
      and e.enumlabel = 'PASSWORD_RESET_REQUESTED'
  ) then
    alter type public.audit_action add value 'PASSWORD_RESET_REQUESTED';
  end if;

  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'audit_action'
      and e.enumlabel = 'MFA_ENROLLED'
  ) then
    alter type public.audit_action add value 'MFA_ENROLLED';
  end if;

  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'audit_action'
      and e.enumlabel = 'MFA_REMOVED'
  ) then
    alter type public.audit_action add value 'MFA_REMOVED';
  end if;

  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'audit_action'
      and e.enumlabel = 'SESSIONS_REVOKED'
  ) then
    alter type public.audit_action add value 'SESSIONS_REVOKED';
  end if;

  -- ---------------------------------------------------------------------
  -- entity_kind: authentication events need a subject, and the subject of
  -- LOGIN, LOGOUT, STATUS_CHANGE, MFA_* is a person.
  -- ---------------------------------------------------------------------
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'entity_kind'
      and e.enumlabel = 'profile'
  ) then
    alter type public.entity_kind add value 'profile';
  end if;
end
$$;
