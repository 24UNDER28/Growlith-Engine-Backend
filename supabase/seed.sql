-- ===========================================================================
-- Phase 7 — Local development seed (SYNTHETIC DATA ONLY)
--
-- Implements PHASE7_SEED_DESIGN.md. Everything here is fabricated:
-- fictional companies (Acme, Globex, Initech, Umbrella), RFC 2606 `.test`
-- emails and `.example` websites, deterministic token HASHES and synthetic
-- checksums only. No production data, real domains, secrets, or credentials
-- appear anywhere in this file.
--
-- Determinism contract
--   * T = this transaction's current_date/now(). Every date is a fixed offset
--     from T — no literal calendar dates, no random(), no gen_random_uuid()
--     for pinned-id rows.
--   * All ids are fixed (metrics are the documented exception — natural-key
--     identity; audit_events and storage.objects use their own keys).
--   * The whole file is ONE transaction (begin/commit) and every insert is
--     idempotent (on conflict do nothing / existence guards), so running it
--     twice is a byte-for-byte row-count no-op.
--
-- Local-only contract
--   * This file is applied by scripts/db-seed.mjs / `supabase db reset` in a
--     LOCAL development database. It must NEVER be applied to a shared or
--     production database: it runs as the migration owner with RLS bypassed,
--     and disabling the audit triggers (below) is safe only inside this
--     transaction on a throwaway schema.
--   * Credentials are NOT seeded here (GoTrue-owned). The optional local
--     scripts/db-seed-auth.mjs provisions dev passwords through the Admin API.
--
-- Audit trigger discipline (design §8.1)
--   The 12 per-table audit triggers are DISABLED for the duration of this
--   transaction so the curated 72-event trail (explicit occurred_at, actors,
--   request ids) can be written instead of 72 "now() by service_role" rows.
--   They are re-enabled BEFORE commit; all other triggers stay ON, so every
--   real constraint path (derive_org, tenancy, currency matching, active
--   teams, status transitions, soft-delete coherence) is exercised normally.
--   A mid-seed failure rolls back the disable — trigger state can never leak.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Silence the audit projection for the duration of this transaction
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select * from (values
    ('organizations'), ('engagements'), ('services'), ('projects'),
    ('deliverables'), ('tasks'), ('comments'), ('files'), ('reports'),
    ('organization_memberships'), ('platform_role_grants'),
    ('project_memberships')
  ) as t(tbl)
  loop
    execute format('alter table public.%I disable trigger %I',
      r.tbl, r.tbl || '_audit');
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. People — 20 identities (10 internal, 10 client) (§4.3, §4.4)
-- ---------------------------------------------------------------------------
-- Inserting into auth.users fires growlith.handle_new_auth_user(), which
-- creates the public.profiles row (user_type from raw metadata; ACTIVE when
-- email_confirmed_at is set, else INVITED). The seed takes the same path a
-- real sign-up takes, then enriches only display/timezone/status metadata.
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
values
  -- Internal staff — legacy ids kept
  ('11111111-1111-4111-8111-111111111111', 'super@growlith.test',
   '{"full_name":"Ada Superuser","user_type":"INTERNAL"}'::jsonb,
   ((current_date - 520) + time '08:00:00') at time zone 'UTC'),
  ('22222222-2222-4222-8222-222222222222', 'admin@growlith.test',
   '{"full_name":"Ben Operator","user_type":"INTERNAL"}'::jsonb,
   ((current_date - 500) + time '08:05:00') at time zone 'UTC'),
  ('33333333-3333-4333-8333-333333333333', 'seo@growlith.test',
   '{"full_name":"Cara Search","user_type":"INTERNAL"}'::jsonb,
   ((current_date - 480) + time '08:10:00') at time zone 'UTC'),
  -- davina → pax (ids 01…07 in §4.3 table order)
  ('70000000-0000-4000-8000-000000000001', 'web@growlith.test',
   '{"full_name":"Davina Deploy","user_type":"INTERNAL"}'::jsonb,
   ((current_date - 400) + time '08:15:00') at time zone 'UTC'),
  ('70000000-0000-4000-8000-000000000002', 'paid@growlith.test',
   '{"full_name":"Priya Precision","user_type":"INTERNAL"}'::jsonb,
   ((current_date - 380) + time '08:20:00') at time zone 'UTC'),
  ('70000000-0000-4000-8000-000000000003', 'crm@growlith.test',
   '{"full_name":"Omar Lifecycle","user_type":"INTERNAL"}'::jsonb,
   ((current_date - 340) + time '08:25:00') at time zone 'UTC'),
  ('70000000-0000-4000-8000-000000000004', 'ai@growlith.test',
   '{"full_name":"Lana Automate","user_type":"INTERNAL"}'::jsonb,
   ((current_date - 300) + time '08:30:00') at time zone 'UTC'),
  ('70000000-0000-4000-8000-000000000005', 'video@growlith.test',
   '{"full_name":"Marcus Motion","user_type":"INTERNAL"}'::jsonb,
   ((current_date - 260) + time '08:35:00') at time zone 'UTC'),
  ('70000000-0000-4000-8000-000000000006', 'zoe@growlith.test',
   '{"full_name":"Zoe Former","user_type":"INTERNAL"}'::jsonb,
   ((current_date - 430) + time '08:40:00') at time zone 'UTC'),
  ('70000000-0000-4000-8000-000000000007', 'pax@growlith.test',
   '{"full_name":"Pax Contractor","user_type":"INTERNAL"}'::jsonb,
   ((current_date - 30) + time '08:45:00') at time zone 'UTC'),
  -- Client users — legacy ids kept
  ('44444444-4444-4444-8444-444444444444', 'owner@acme.test',
   '{"full_name":"Dana Acme","user_type":"CLIENT"}'::jsonb,
   ((current_date - 240) + time '09:00:00') at time zone 'UTC'),
  ('55555555-5555-4555-8555-555555555555', 'analyst@acme.test',
   '{"full_name":"Eli Acme","user_type":"CLIENT"}'::jsonb,
   ((current_date - 180) + time '09:05:00') at time zone 'UTC'),
  ('66666666-6666-4666-8666-666666666666', 'owner@globex.test',
   '{"full_name":"Fay Globex","user_type":"CLIENT"}'::jsonb,
   ((current_date - 90) + time '09:10:00') at time zone 'UTC'),
  -- nova → udith (ids 01…07 in §4.4 table order)
  ('80000000-0000-4000-8000-000000000001', 'nova@acme.test',
   '{"full_name":"Nova Acme","user_type":"CLIENT"}'::jsonb,
   ((current_date - 120) + time '09:15:00') at time zone 'UTC'),
  ('80000000-0000-4000-8000-000000000002', 'pierre@acme.test',
   '{"full_name":"Pierre Acme","user_type":"CLIENT"}'::jsonb,
   null),  -- invited, not yet confirmed → INVITED account
  ('80000000-0000-4000-8000-000000000003', 'susie@acme.test',
   '{"full_name":"Susie Acme","user_type":"CLIENT"}'::jsonb,
   ((current_date - 200) + time '09:20:00') at time zone 'UTC'),
  ('80000000-0000-4000-8000-000000000004', 'gwen@globex.test',
   '{"full_name":"Gwen Globex","user_type":"CLIENT"}'::jsonb,
   ((current_date - 60) + time '09:25:00') at time zone 'UTC'),
  ('80000000-0000-4000-8000-000000000005', 'owner@umbrella.test',
   '{"full_name":"Umbra Umbrella","user_type":"CLIENT"}'::jsonb,
   ((current_date - 400) + time '09:30:00') at time zone 'UTC'),
  ('80000000-0000-4000-8000-000000000006', 'umari@umbrella.test',
   '{"full_name":"Umari Umbrella","user_type":"CLIENT"}'::jsonb,
   ((current_date - 380) + time '09:35:00') at time zone 'UTC'),
  ('80000000-0000-4000-8000-000000000007', 'udith@umbrella.test',
   '{"full_name":"Udith Umbrella","user_type":"CLIENT"}'::jsonb,
   ((current_date - 350) + time '09:40:00') at time zone 'UTC')
on conflict (id) do nothing;

-- Enrichment the constructor trigger cannot express: display metadata,
-- timezones, MFA enrolment (metadata only), and the deliberate account-state
-- variants (zoe DEACTIVATED, umbra SUSPENDED, udith DEACTIVATED). pierre stays
-- INVITED; everyone else stays ACTIVE from the trigger.
update public.profiles set
  display_name = full_name,
  timezone     = case id
    when '70000000-0000-4000-8000-000000000001' then 'Europe/London'
    when '70000000-0000-4000-8000-000000000003' then 'Asia/Dubai'
    when '70000000-0000-4000-8000-000000000004' then 'Australia/Sydney'
    when '70000000-0000-4000-8000-000000000005' then 'Europe/London'
    when '80000000-0000-4000-8000-000000000005' then 'Australia/Sydney'
    when '80000000-0000-4000-8000-000000000006' then 'Australia/Sydney'
    when '80000000-0000-4000-8000-000000000007' then 'Australia/Sydney'
    else 'America/New_York'
  end,
  account_status = case id
    when '70000000-0000-4000-8000-000000000006' then 'DEACTIVATED'
    when '80000000-0000-4000-8000-000000000005' then 'SUSPENDED'
    when '80000000-0000-4000-8000-000000000007' then 'DEACTIVATED'
    else account_status
  end,
  mfa_enrolled_at = case id
    when '11111111-1111-4111-8111-111111111111' then ((current_date - 300) + time '10:00:00') at time zone 'UTC'
    when '22222222-2222-4222-8222-222222222222' then ((current_date - 260) + time '10:00:00') at time zone 'UTC'
    else mfa_enrolled_at
  end,
  avatar_path = case id
    when '44444444-4444-4444-8444-444444444444'
      then 'aaaaaaaa-0000-4000-8000-000000000001/seed/avatar/dana-avatar.png'
    else avatar_path
  end
where id in (
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '70000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000002',
  '70000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000004',
  '70000000-0000-4000-8000-000000000005', '70000000-0000-4000-8000-000000000006',
  '70000000-0000-4000-8000-000000000007',
  '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '80000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000002',
  '80000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000004',
  '80000000-0000-4000-8000-000000000005', '80000000-0000-4000-8000-000000000006',
  '80000000-0000-4000-8000-000000000007'
);

-- ---------------------------------------------------------------------------
-- 2. Platform roles — 10 grants (§4.3/§4.5) + staff teams — 10 rows (§4.3)
-- ---------------------------------------------------------------------------
insert into public.platform_role_grants
  (id, user_id, role, granted_by, granted_at, reason, expires_at,
   revoked_at, revoked_by, revoke_reason)
values
  ('e2000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   'SUPER_ADMIN', '11111111-1111-4111-8111-111111111111',
   ((current_date - 520) + time '08:30:00') at time zone 'UTC',
   'Founding platform owner.', null, null, null, null),
  ('e2000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222',
   'ADMIN', '11111111-1111-4111-8111-111111111111',
   ((current_date - 500) + time '09:00:00') at time zone 'UTC',
   'Delivery operations.', null, null, null, null),
  -- All specialists: risk R-1 least-privilege violation, kept visible on purpose.
  ('e2000000-0000-4000-8000-000000000003', '33333333-3333-4333-8333-333333333333',
   'ADMIN', '11111111-1111-4111-8111-111111111111',
   ((current_date - 480) + time '09:00:00') at time zone 'UTC',
   'Specialist. Requires ADMIN only because no TEAM_MEMBER role exists — risk R-1.',
   null, null, null, null),
  ('e2000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000001',
   'ADMIN', '11111111-1111-4111-8111-111111111111',
   ((current_date - 400) + time '09:00:00') at time zone 'UTC',
   'Specialist. Requires ADMIN only because no TEAM_MEMBER role exists — risk R-1.',
   null, null, null, null),
  ('e2000000-0000-4000-8000-000000000005', '70000000-0000-4000-8000-000000000002',
   'ADMIN', '11111111-1111-4111-8111-111111111111',
   ((current_date - 380) + time '09:00:00') at time zone 'UTC',
   'Specialist. Requires ADMIN only because no TEAM_MEMBER role exists — risk R-1.',
   null, null, null, null),
  ('e2000000-0000-4000-8000-000000000006', '70000000-0000-4000-8000-000000000003',
   'ADMIN', '11111111-1111-4111-8111-111111111111',
   ((current_date - 340) + time '09:00:00') at time zone 'UTC',
   'Specialist. Requires ADMIN only because no TEAM_MEMBER role exists — risk R-1.',
   null, null, null, null),
  ('e2000000-0000-4000-8000-000000000007', '70000000-0000-4000-8000-000000000004',
   'ADMIN', '11111111-1111-4111-8111-111111111111',
   ((current_date - 300) + time '09:00:00') at time zone 'UTC',
   'Specialist. Requires ADMIN only because no TEAM_MEMBER role exists — risk R-1.',
   null, null, null, null),
  ('e2000000-0000-4000-8000-000000000008', '70000000-0000-4000-8000-000000000005',
   'ADMIN', '11111111-1111-4111-8111-111111111111',
   ((current_date - 260) + time '09:00:00') at time zone 'UTC',
   'Specialist. Requires ADMIN only because no TEAM_MEMBER role exists — risk R-1.',
   null, null, null, null),
  -- zoe: revoked (history only, CRITICAL-worthy offboarding trail)
  ('e2000000-0000-4000-8000-000000000009', '70000000-0000-4000-8000-000000000006',
   'ADMIN', '11111111-1111-4111-8111-111111111111',
   ((current_date - 430) + time '09:00:00') at time zone 'UTC',
   'Specialist. Requires ADMIN only because no TEAM_MEMBER role exists — risk R-1.',
   null,
   ((current_date - 90) + time '17:00:00') at time zone 'UTC',
   '11111111-1111-4111-8111-111111111111', 'Offboarding — departure.'),
  -- pax: time-boxed contractor grant
  ('e2000000-0000-4000-8000-000000000010', '70000000-0000-4000-8000-000000000007',
   'ADMIN', '11111111-1111-4111-8111-111111111111',
   ((current_date - 30) + time '09:00:00') at time zone 'UTC',
   'Contractor engagement (time-boxed).', now() + interval '30 days',
   null, null, null)
on conflict (id) do nothing;

insert into public.staff_team_memberships
  (id, user_id, team, is_lead, allocation_pct, created_at,
   deleted_at, deleted_by)
values
  ('e3000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222',
   'ACCOUNT_MANAGEMENT', true, 100, now() - interval '500 days', null, null),
  ('e3000000-0000-4000-8000-000000000002', '33333333-3333-4333-8333-333333333333',
   'SEO', false, 80, now() - interval '480 days', null, null),
  ('e3000000-0000-4000-8000-000000000003', '33333333-3333-4333-8333-333333333333',
   'AI_AUTOMATION', false, 20, now() - interval '300 days', null, null),
  ('e3000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000001',
   'WEB_DEVELOPMENT', true, 80, now() - interval '400 days', null, null),
  ('e3000000-0000-4000-8000-000000000005', '70000000-0000-4000-8000-000000000002',
   'PAID_MEDIA', true, 70, now() - interval '380 days', null, null),
  ('e3000000-0000-4000-8000-000000000006', '70000000-0000-4000-8000-000000000003',
   'CRM_LIFECYCLE', true, 75, now() - interval '340 days', null, null),
  ('e3000000-0000-4000-8000-000000000007', '70000000-0000-4000-8000-000000000004',
   'AI_AUTOMATION', true, 60, now() - interval '300 days', null, null),
  ('e3000000-0000-4000-8000-000000000008', '70000000-0000-4000-8000-000000000005',
   'VIDEO_MULTIMEDIA', true, 65, now() - interval '260 days', null, null),
  -- zoe's soft-deleted membership: offboarding evidence (RESTRICT keeps it).
  ('e3000000-0000-4000-8000-000000000009', '70000000-0000-4000-8000-000000000006',
   'SEO', false, 100, now() - interval '430 days',
   ((current_date - 90) + time '17:05:00') at time zone 'UTC',
   '11111111-1111-4111-8111-111111111111'),
  ('e3000000-0000-4000-8000-000000000010', '70000000-0000-4000-8000-000000000007',
   'AI_AUTOMATION', false, 20, now() - interval '30 days', null, null)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Organizations + settings — 4 tenants (§4.2)
-- ---------------------------------------------------------------------------
insert into public.organizations
  (id, slug, legal_name, display_name, region, industry, website_url, status,
   primary_currency, account_manager_user_id, onboarded_at, created_at)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'acme-industrials',
   'Acme Industrials Inc.', 'Acme Industrials', 'NYC', 'Manufacturing',
   'https://acme-industrials.example', 'ACTIVE', 'USD',
   '22222222-2222-4222-8222-222222222222',
   ((current_date - 240) + time '09:00:00') at time zone 'UTC',
   now() - interval '240 days'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'globex-health',
   'Globex Health Ltd.', 'Globex Health', 'LDN', 'Healthcare',
   'https://globex-health.example', 'ACTIVE', 'GBP',
   '22222222-2222-4222-8222-222222222222',
   ((current_date - 90) + time '09:00:00') at time zone 'UTC',
   now() - interval '90 days'),
  ('cccccccc-0000-4000-8000-000000000003', 'initech-capital',
   'Initech Capital Ltd.', 'Initech Capital', 'DIFC', 'Financial Services',
   'https://initech-capital.example', 'ONBOARDING', 'AED',
   '22222222-2222-4222-8222-222222222222',
   ((current_date - 14) + time '09:00:00') at time zone 'UTC',
   now() - interval '14 days'),
  ('dddddddd-0000-4000-8000-000000000004', 'umbrella-labs',
   'Umbrella Labs Pty Ltd.', 'Umbrella Labs', 'SYD', 'E-commerce',
   'https://umbrella-labs.example', 'PAUSED', 'AUD',
   '22222222-2222-4222-8222-222222222222',
   ((current_date - 400) + time '09:00:00') at time zone 'UTC',
   now() - interval '400 days')
on conflict (id) do nothing;

-- Per-org settings rows are created 1:1 by the organizations insert trigger;
-- enrich the named values. logo_file_id is set later, after the files insert.
update public.organization_settings set
  brand_primary_color        = case organization_id
    when 'aaaaaaaa-0000-4000-8000-000000000001' then '#0f7c5b'
    when 'bbbbbbbb-0000-4000-8000-000000000002' then '#1f4d8f'
    else brand_primary_color
  end,
  default_report_cadence     = case organization_id
    when 'aaaaaaaa-0000-4000-8000-000000000001' then 'MONTHLY'
    else default_report_cadence
  end,
  require_approval_for_publish = case organization_id
    when 'aaaaaaaa-0000-4000-8000-000000000001' then true
    else require_approval_for_publish
  end,
  notify_on_report_published = case organization_id
    when 'dddddddd-0000-4000-8000-000000000004' then false  -- paused account
    else notify_on_report_published
  end,
  timezone = case organization_id
    when 'aaaaaaaa-0000-4000-8000-000000000001' then 'America/New_York'
    when 'bbbbbbbb-0000-4000-8000-000000000002' then 'Europe/London'
    when 'cccccccc-0000-4000-8000-000000000003' then 'Asia/Dubai'
    when 'dddddddd-0000-4000-8000-000000000004' then 'Australia/Sydney'
    else timezone
  end
where organization_id in (
  'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
  'cccccccc-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000004'
);

-- ---------------------------------------------------------------------------
-- 4. Client memberships — 10 rows, deliberate non-overlap (§4.4)
-- ---------------------------------------------------------------------------
insert into public.organization_memberships
  (id, organization_id, user_id, role, status, is_primary_contact, job_title,
   invited_by, joined_at, created_at)
values
  ('a0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   '44444444-4444-4444-8444-444444444444', 'CLIENT_ADMIN', 'ACTIVE', true,
   'VP Growth', null,
   ((current_date - 240) + time '10:00:00') at time zone 'UTC', now() - interval '240 days'),
  ('a0000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001',
   '55555555-5555-4555-8555-555555555555', 'CLIENT_MEMBER', 'ACTIVE', false,
   'Marketing Analyst', null,
   ((current_date - 180) + time '10:00:00') at time zone 'UTC', now() - interval '180 days'),
  ('a0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001',
   '80000000-0000-4000-8000-000000000001', 'CLIENT_MEMBER', 'ACTIVE', false,
   'Growth Coordinator', '44444444-4444-4444-8444-444444444444',
   ((current_date - 120) + time '10:00:00') at time zone 'UTC', now() - interval '120 days'),
  ('a0000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001',
   '80000000-0000-4000-8000-000000000002', 'CLIENT_MEMBER', 'INVITED', false,
   'Marketing Manager', '44444444-4444-4444-8444-444444444444',
   null, now() - interval '5 days'),
  ('a0000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001',
   '80000000-0000-4000-8000-000000000003', 'CLIENT_MEMBER', 'SUSPENDED', false,
   'Content Lead', '44444444-4444-4444-8444-444444444444',
   ((current_date - 200) + time '10:00:00') at time zone 'UTC', now() - interval '200 days'),
  ('b0000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
   '66666666-6666-4666-8666-666666666666', 'CLIENT_ADMIN', 'ACTIVE', true,
   'Head of Digital', null,
   ((current_date - 90) + time '10:00:00') at time zone 'UTC', now() - interval '90 days'),
  ('b0000000-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002',
   '80000000-0000-4000-8000-000000000004', 'CLIENT_MEMBER', 'ACTIVE', false,
   'Digital Producer', '66666666-6666-4666-8666-666666666666',
   ((current_date - 60) + time '10:00:00') at time zone 'UTC', now() - interval '60 days'),
  ('d0000000-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004',
   '80000000-0000-4000-8000-000000000005', 'CLIENT_ADMIN', 'SUSPENDED', false,
   'Founder', '22222222-2222-4222-8222-222222222222',
   ((current_date - 400) + time '10:00:00') at time zone 'UTC', now() - interval '400 days'),
  ('d0000000-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000004',
   '80000000-0000-4000-8000-000000000006', 'CLIENT_MEMBER', 'ACTIVE', true,
   'Operations Director', '80000000-0000-4000-8000-000000000005',
   ((current_date - 380) + time '10:00:00') at time zone 'UTC', now() - interval '380 days'),
  ('d0000000-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000004',
   '80000000-0000-4000-8000-000000000007', 'CLIENT_MEMBER', 'DEACTIVATED', false,
   'Ops Lead', '80000000-0000-4000-8000-000000000005',
   ((current_date - 350) + time '10:00:00') at time zone 'UTC', now() - interval '350 days')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Engagements — 8 rows (§5.1)
-- ---------------------------------------------------------------------------
insert into public.engagements
  (id, organization_id, code, name, engagement_type, status, currency,
   contract_value, monthly_retainer, start_date, end_date, renewal_date,
   account_manager_user_id, signed_at, notes_internal, created_at)
values
  ('a1000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'ACM-2026-R1', 'Acme growth retainer 2026', 'RETAINER', 'ACTIVE', 'USD',
   240000.00, 20000.00, current_date - 240, null, current_date + 120,
   '22222222-2222-4222-8222-222222222222',
   ((current_date - 238) + time '10:00:00') at time zone 'UTC',
   'Margin thin in Q1; revisit scope at renewal.',
   ((current_date - 240) + time '09:00:00') at time zone 'UTC'),
  ('a1000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001',
   'ACM-2025-P1', 'Acme site authority audit', 'PROJECT', 'COMPLETED', 'USD',
   45000.00, null, current_date - 420, current_date - 270, null,
   '22222222-2222-4222-8222-222222222222',
   ((current_date - 425) + time '09:00:00') at time zone 'UTC', null,
   ((current_date - 420) + time '09:00:00') at time zone 'UTC'),
  ('a1000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001',
   'ACM-2026-A1', 'Acme growth advisory Q3', 'ADVISORY', 'ACTIVE', 'USD',
   9000.00, null, current_date - 45, current_date + 45, null,
   '22222222-2222-4222-8222-222222222222',
   ((current_date - 47) + time '09:00:00') at time zone 'UTC', null,
   ((current_date - 45) + time '09:00:00') at time zone 'UTC'),
  ('b1000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
   'GLX-2026-P1', 'Globex site rebuild', 'PROJECT', 'ACTIVE', 'GBP',
   85000.00, null, current_date - 90, current_date + 150, null,
   '22222222-2222-4222-8222-222222222222',
   ((current_date - 88) + time '10:00:00') at time zone 'UTC', null,
   ((current_date - 90) + time '09:00:00') at time zone 'UTC'),
  ('b1000000-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002',
   'GLX-2025-A1', 'Globex measurement advisory', 'ADVISORY', 'COMPLETED', 'GBP',
   12000.00, null, current_date - 330, current_date - 210, null,
   '22222222-2222-4222-8222-222222222222',
   ((current_date - 335) + time '09:00:00') at time zone 'UTC', null,
   ((current_date - 330) + time '09:00:00') at time zone 'UTC'),
  ('c1000000-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003',
   'ICH-2026-P1', 'Initech regulatory web foundation', 'PROJECT', 'DRAFT', 'AED',
   180000.00, null, current_date + 7, current_date + 180, null,
   '22222222-2222-4222-8222-222222222222', null, null,
   ((current_date - 14) + time '09:00:00') at time zone 'UTC'),
  ('d1000000-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004',
   'UMB-2025-R1', 'Umbrella paid retainer 2025', 'RETAINER', 'PAUSED', 'AUD',
   96000.00, 8000.00, current_date - 400, null, current_date + 45,
   '22222222-2222-4222-8222-222222222222',
   ((current_date - 398) + time '09:00:00') at time zone 'UTC',
   'Paused with the client suspension; revisit at reactivation.',
   ((current_date - 400) + time '09:00:00') at time zone 'UTC'),
  ('d1000000-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000004',
   'UMB-2024-P1', 'Umbrella authority content sprint', 'PROJECT', 'COMPLETED', 'AUD',
   38000.00, null, current_date - 520, current_date - 360, null,
   '22222222-2222-4222-8222-222222222222',
   ((current_date - 505) + time '09:00:00') at time zone 'UTC', null,
   ((current_date - 520) + time '09:00:00') at time zone 'UTC')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 6. Services — 13 rows, every service line and team (§5.2)
-- ---------------------------------------------------------------------------
insert into public.services
  (id, organization_id, engagement_id, service_line, delivering_team, name,
   scope_summary, status, currency, fee, fee_model, start_date, end_date,
   lead_user_id, created_at)
values
  ('a2000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'PROGRAMMATIC_SEO', 'SEO',
   'Programmatic SEO — category pages',
   'Category page templates with search intent coverage.',
   'ACTIVE', 'USD', 12000.00, 'RETAINER', current_date - 240, null,
   '33333333-3333-4333-8333-333333333333',
   ((current_date - 240) + time '09:00:00') at time zone 'UTC'),
  ('a2000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'WEB_CORE', 'WEB_DEVELOPMENT',
   'Sub-second web core', 'Core Web Vitals and rendering performance.',
   'ACTIVE', 'USD', 8000.00, 'RETAINER', current_date - 180, null,
   '70000000-0000-4000-8000-000000000001',
   ((current_date - 180) + time '09:00:00') at time zone 'UTC'),
  ('a2000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'PRECISION_PAID_MEDIA', 'PAID_MEDIA',
   'Precision paid — always-on', 'Always-on acquisition across channels.',
   'ACTIVE', 'USD', 14000.00, 'PERFORMANCE', current_date - 200, null,
   '70000000-0000-4000-8000-000000000002',
   ((current_date - 200) + time '09:00:00') at time zone 'UTC'),
  ('a2000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'LIFECYCLE_CRM', 'CRM_LIFECYCLE',
   'Lifecycle nurture & scoring', 'Nurture sequences and lead scoring.',
   'ACTIVE', 'USD', 9000.00, 'RETAINER', current_date - 150, null,
   '70000000-0000-4000-8000-000000000003',
   ((current_date - 150) + time '09:00:00') at time zone 'UTC'),
  ('a2000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'ACCOUNT_MANAGEMENT', 'ACCOUNT_MANAGEMENT',
   'Account leadership & QBRs', 'Quarterly business reviews and reporting.',
   'ACTIVE', 'USD', 3500.00, 'RETAINER', current_date - 240, null,
   '22222222-2222-4222-8222-222222222222',
   ((current_date - 240) + time '09:00:00') at time zone 'UTC'),
  ('a2000000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000002', 'PROGRAMMATIC_SEO', 'SEO',
   'Site authority audit (2025)', 'Technical and authority audit programme.',
   'COMPLETED', 'USD', 45000.00, 'FIXED', current_date - 420, current_date - 270,
   '33333333-3333-4333-8333-333333333333',
   ((current_date - 420) + time '09:00:00') at time zone 'UTC'),
  ('b2000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b1000000-0000-4000-8000-000000000001', 'WEB_CORE', 'WEB_DEVELOPMENT',
   'Platform rebuild', 'Full site rebuild programme.',
   'ACTIVE', 'GBP', 85000.00, 'FIXED', current_date - 90, null,
   '70000000-0000-4000-8000-000000000001',
   ((current_date - 90) + time '09:00:00') at time zone 'UTC'),
  ('b2000000-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b1000000-0000-4000-8000-000000000001', 'AI_AUTOMATIONS', 'AI_AUTOMATION',
   'AI workflows & RAG pilots', 'Automation mapping and RAG pilots.',
   'ACTIVE', 'GBP', 12000.00, 'FIXED', current_date - 60, null,
   '70000000-0000-4000-8000-000000000004',
   ((current_date - 60) + time '09:00:00') at time zone 'UTC'),
  ('b2000000-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b1000000-0000-4000-8000-000000000001', 'VIDEO_MULTIMEDIA', 'VIDEO_MULTIMEDIA',
   'Founder video series', 'Founder-led video episodes.',
   'ACTIVE', 'GBP', 15000.00, 'FIXED', current_date - 45, null,
   '70000000-0000-4000-8000-000000000005',
   ((current_date - 45) + time '09:00:00') at time zone 'UTC'),
  ('b2000000-0000-4000-8000-000000000004', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b1000000-0000-4000-8000-000000000001', 'ACCOUNT_MANAGEMENT', 'ACCOUNT_MANAGEMENT',
   'Rebuild delivery management', 'Delivery governance for the rebuild.',
   'ACTIVE', 'GBP', 4000.00, 'RETAINER', current_date - 90, null,
   '22222222-2222-4222-8222-222222222222',
   ((current_date - 90) + time '09:00:00') at time zone 'UTC'),
  ('c2000000-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003',
   'c1000000-0000-4000-8000-000000000001', 'WEB_CORE', 'WEB_DEVELOPMENT',
   'Regulatory web foundation', 'Discovery and architecture for a regulated build.',
   'PLANNED', 'AED', 180000.00, 'FIXED', current_date + 7, null,
   '70000000-0000-4000-8000-000000000001',
   ((current_date - 14) + time '09:00:00') at time zone 'UTC'),
  ('d2000000-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004',
   'd1000000-0000-4000-8000-000000000001', 'PRECISION_PAID_MEDIA', 'PAID_MEDIA',
   'Paid retargeting refresh', 'Retargeting refresh — paused with the account.',
   'PAUSED', 'AUD', 8000.00, 'RETAINER', current_date - 400, null,
   '70000000-0000-4000-8000-000000000002',
   ((current_date - 400) + time '09:00:00') at time zone 'UTC'),
  ('d2000000-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000004',
   'd1000000-0000-4000-8000-000000000002', 'PROGRAMMATIC_SEO', 'SEO',
   'Authority content sprint (2024)', 'Authority content sprint delivered in 2024.',
   'COMPLETED', 'AUD', 38000.00, 'FIXED', current_date - 520, current_date - 360,
   '33333333-3333-4333-8333-333333333333',
   ((current_date - 520) + time '09:00:00') at time zone 'UTC')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 7. Projects — 13 rows (§5.3)
-- ---------------------------------------------------------------------------
insert into public.projects
  (id, organization_id, service_id, code, name, description, status, priority,
   health, owning_team, lead_user_id, start_date, target_date, completed_at,
   client_visible, created_at)
values
  ('a3000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000001', 'ACM-SEO-01',
   'Category template rollout', null, 'IN_PROGRESS', 'HIGH', 'ON_TRACK', 'SEO',
   '33333333-3333-4333-8333-333333333333', current_date - 60, current_date + 30,
   null, true, now() - interval '60 days'),
  ('a3000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000003', 'ACM-PAID-01',
   'Precision paid acquisition Q3', null, 'IN_PROGRESS', 'URGENT', 'AT_RISK',
   'PAID_MEDIA', '70000000-0000-4000-8000-000000000002',
   current_date - 45, current_date + 14, null, true, now() - interval '45 days'),
  ('a3000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000002', 'ACM-WEB-01',
   'Core Web Vitals sprint 4', null, 'BLOCKED', 'HIGH', 'OFF_TRACK',
   'WEB_DEVELOPMENT', '70000000-0000-4000-8000-000000000001',
   current_date - 100, current_date + 5, null, true, now() - interval '100 days'),
  ('a3000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000004', 'ACM-CRM-01',
   'Lifecycle nurture revamp', null, 'IN_REVIEW', 'HIGH', 'ON_TRACK',
   'CRM_LIFECYCLE', '70000000-0000-4000-8000-000000000003',
   current_date - 80, current_date + 21, null, true, now() - interval '80 days'),
  ('a3000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000005', 'ACM-INT-01',
   'Margin & pricing analysis', null, 'IN_PROGRESS', 'MEDIUM', 'ON_TRACK',
   'ACCOUNT_MANAGEMENT', '22222222-2222-4222-8222-222222222222',
   current_date - 120, current_date + 45, null, false, now() - interval '120 days'),
  ('a3000000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000006', 'ACM-AUDIT-02',
   'Site authority audit', null, 'COMPLETED', 'HIGH', 'ON_TRACK', 'SEO',
   '33333333-3333-4333-8333-333333333333', current_date - 420, current_date - 280,
   ((current_date - 280) + time '17:00:00') at time zone 'UTC', true,
   now() - interval '420 days'),
  ('b3000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b2000000-0000-4000-8000-000000000001', 'GLX-WEB-1',
   'Rebuild phase one', null, 'IN_PROGRESS', 'URGENT', 'ON_TRACK',
   'WEB_DEVELOPMENT', '70000000-0000-4000-8000-000000000001',
   current_date - 90, current_date + 60, null, true, now() - interval '90 days'),
  -- ADR-0006 as data: b3-002 is SEO-owned but rides the WEB_CORE service b2-001.
  ('b3000000-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b2000000-0000-4000-8000-000000000001', 'GLX-SEO-01',
   'Indexation & redirect programme', null, 'IN_PROGRESS', 'MEDIUM', 'ON_TRACK',
   'SEO', '33333333-3333-4333-8333-333333333333',
   current_date - 60, current_date + 40, null, true, now() - interval '60 days'),
  ('b3000000-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b2000000-0000-4000-8000-000000000002', 'GLX-AI-01',
   'Automation opportunity mapping', null, 'IN_PROGRESS', 'MEDIUM', 'ON_TRACK',
   'AI_AUTOMATION', '70000000-0000-4000-8000-000000000004',
   current_date - 45, current_date + 30, null, true, now() - interval '45 days'),
  ('b3000000-0000-4000-8000-000000000004', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b2000000-0000-4000-8000-000000000003', 'GLX-VID-01',
   'Founder video series ep 1–3', null, 'IN_REVIEW', 'HIGH', 'ON_TRACK',
   'VIDEO_MULTIMEDIA', '70000000-0000-4000-8000-000000000005',
   current_date - 50, current_date + 10, null, true, now() - interval '50 days'),
  ('c3000000-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003',
   'c2000000-0000-4000-8000-000000000001', 'ICH-2026-01',
   'Discovery & architecture', null, 'PLANNED', 'MEDIUM', 'ON_TRACK',
   'WEB_DEVELOPMENT', '70000000-0000-4000-8000-000000000001',
   current_date + 7, current_date + 90, null, true, now() - interval '14 days'),
  ('d3000000-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004',
   'd2000000-0000-4000-8000-000000000001', 'UMB-PAID-01',
   'Paid retargeting refresh', null, 'BLOCKED', 'HIGH', 'OFF_TRACK',
   'PAID_MEDIA', '70000000-0000-4000-8000-000000000002',
   current_date - 300, current_date + 30, null, true, now() - interval '300 days'),
  ('d3000000-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000004',
   'd2000000-0000-4000-8000-000000000002', 'UMB-SEO-01',
   'Authority content sprint', null, 'COMPLETED', 'HIGH', 'ON_TRACK', 'SEO',
   '33333333-3333-4333-8333-333333333333', current_date - 500, current_date - 370,
   ((current_date - 370) + time '17:00:00') at time zone 'UTC', true,
   now() - interval '500 days')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 8. Project memberships — 35 rows, one live LEAD per project (§5.4)
-- ---------------------------------------------------------------------------
-- Ids follow the §5.4 table order (e1-001 = a3-001's first listed member).
insert into public.project_memberships
  (id, organization_id, project_id, user_id, project_role, allocation_pct,
   added_by, created_at)
values
  -- a3-001
  ('e1000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333',
   'LEAD', 60, '33333333-3333-4333-8333-333333333333', now() - interval '60 days'),
  ('e1000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001',
   'CONTRIBUTOR', 15, '33333333-3333-4333-8333-333333333333', now() - interval '60 days'),
  ('e1000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222',
   'REVIEWER', 10, '33333333-3333-4333-8333-333333333333', now() - interval '60 days'),
  ('e1000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001',
   'OBSERVER', 5, '33333333-3333-4333-8333-333333333333', now() - interval '60 days'),
  -- a3-002
  ('e1000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000002',
   'LEAD', 50, '70000000-0000-4000-8000-000000000002', now() - interval '45 days'),
  ('e1000000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000005',
   'CONTRIBUTOR', 20, '70000000-0000-4000-8000-000000000002', now() - interval '45 days'),
  ('e1000000-0000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000002', '44444444-4444-4444-8444-444444444444',
   'OBSERVER', 5, '70000000-0000-4000-8000-000000000002', now() - interval '45 days'),
  ('e1000000-0000-4000-8000-000000000008', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000002', '55555555-5555-4555-8555-555555555555',
   'OBSERVER', 5, '70000000-0000-4000-8000-000000000002', now() - interval '45 days'),
  -- a3-003
  ('e1000000-0000-4000-8000-000000000009', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000001',
   'LEAD', 70, '70000000-0000-4000-8000-000000000001', now() - interval '100 days'),
  ('e1000000-0000-4000-8000-000000000010', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000003', '33333333-3333-4333-8333-333333333333',
   'CONTRIBUTOR', 10, '70000000-0000-4000-8000-000000000001', now() - interval '100 days'),
  ('e1000000-0000-4000-8000-000000000011', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222',
   'REVIEWER', 10, '70000000-0000-4000-8000-000000000001', now() - interval '100 days'),
  -- a3-004
  ('e1000000-0000-4000-8000-000000000012', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000003',
   'LEAD', 60, '70000000-0000-4000-8000-000000000003', now() - interval '80 days'),
  ('e1000000-0000-4000-8000-000000000013', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000004',
   'CONTRIBUTOR', 25, '70000000-0000-4000-8000-000000000003', now() - interval '80 days'),
  ('e1000000-0000-4000-8000-000000000014', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000004', '44444444-4444-4444-8444-444444444444',
   'OBSERVER', 5, '70000000-0000-4000-8000-000000000003', now() - interval '80 days'),
  -- a3-005 (internal-only project)
  ('e1000000-0000-4000-8000-000000000015', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000005', '22222222-2222-4222-8222-222222222222',
   'LEAD', 30, '22222222-2222-4222-8222-222222222222', now() - interval '120 days'),
  ('e1000000-0000-4000-8000-000000000016', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111',
   'REVIEWER', 5, '22222222-2222-4222-8222-222222222222', now() - interval '120 days'),
  -- a3-006 (zoe's historical membership — restrict-on-delete evidence)
  ('e1000000-0000-4000-8000-000000000017', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000006', '33333333-3333-4333-8333-333333333333',
   'LEAD', 40, '33333333-3333-4333-8333-333333333333', now() - interval '420 days'),
  ('e1000000-0000-4000-8000-000000000018', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000006', '70000000-0000-4000-8000-000000000006',
   'CONTRIBUTOR', 30, '33333333-3333-4333-8333-333333333333', now() - interval '420 days'),
  ('e1000000-0000-4000-8000-000000000019', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000006', '22222222-2222-4222-8222-222222222222',
   'REVIEWER', 5, '33333333-3333-4333-8333-333333333333', now() - interval '420 days'),
  -- b3-001
  ('e1000000-0000-4000-8000-000000000020', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001',
   'LEAD', 50, '70000000-0000-4000-8000-000000000001', now() - interval '90 days'),
  ('e1000000-0000-4000-8000-000000000021', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000005',
   'CONTRIBUTOR', 20, '70000000-0000-4000-8000-000000000001', now() - interval '90 days'),
  ('e1000000-0000-4000-8000-000000000022', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000001', '66666666-6666-4666-8666-666666666666',
   'OBSERVER', 5, '70000000-0000-4000-8000-000000000001', now() - interval '90 days'),
  -- b3-002 (SEO project on the WEB_CORE service — ADR-0006)
  ('e1000000-0000-4000-8000-000000000023', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000002', '33333333-3333-4333-8333-333333333333',
   'LEAD', 40, '33333333-3333-4333-8333-333333333333', now() - interval '60 days'),
  ('e1000000-0000-4000-8000-000000000024', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001',
   'CONTRIBUTOR', 10, '33333333-3333-4333-8333-333333333333', now() - interval '60 days'),
  -- b3-003
  ('e1000000-0000-4000-8000-000000000025', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000004',
   'LEAD', 40, '70000000-0000-4000-8000-000000000004', now() - interval '45 days'),
  ('e1000000-0000-4000-8000-000000000026', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000003',
   'CONTRIBUTOR', 10, '70000000-0000-4000-8000-000000000004', now() - interval '45 days'),
  ('e1000000-0000-4000-8000-000000000027', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000004',
   'OBSERVER', 5, '70000000-0000-4000-8000-000000000004', now() - interval '45 days'),
  -- b3-004
  ('e1000000-0000-4000-8000-000000000028', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000005',
   'LEAD', 40, '70000000-0000-4000-8000-000000000005', now() - interval '50 days'),
  ('e1000000-0000-4000-8000-000000000029', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000004',
   'CONTRIBUTOR', 5, '70000000-0000-4000-8000-000000000005', now() - interval '50 days'),
  ('e1000000-0000-4000-8000-000000000030', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000004', '66666666-6666-4666-8666-666666666666',
   'OBSERVER', 5, '70000000-0000-4000-8000-000000000005', now() - interval '50 days'),
  -- c3-001
  ('e1000000-0000-4000-8000-000000000031', 'cccccccc-0000-4000-8000-000000000003',
   'c3000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001',
   'LEAD', 20, '70000000-0000-4000-8000-000000000001', now() - interval '14 days'),
  -- d3-001
  ('e1000000-0000-4000-8000-000000000032', 'dddddddd-0000-4000-8000-000000000004',
   'd3000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000002',
   'LEAD', 30, '70000000-0000-4000-8000-000000000002', now() - interval '300 days'),
  ('e1000000-0000-4000-8000-000000000033', 'dddddddd-0000-4000-8000-000000000004',
   'd3000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000005',
   'CONTRIBUTOR', 10, '70000000-0000-4000-8000-000000000002', now() - interval '300 days'),
  -- d3-002 (zoe historical)
  ('e1000000-0000-4000-8000-000000000034', 'dddddddd-0000-4000-8000-000000000004',
   'd3000000-0000-4000-8000-000000000002', '33333333-3333-4333-8333-333333333333',
   'LEAD', 30, '33333333-3333-4333-8333-333333333333', now() - interval '500 days'),
  ('e1000000-0000-4000-8000-000000000035', 'dddddddd-0000-4000-8000-000000000004',
   'd3000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000006',
   'CONTRIBUTOR', 25, '33333333-3333-4333-8333-333333333333', now() - interval '500 days')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 9. Deliverables — 19 rows (§6.2). b4-002 is RESERVED for the Phase 4 proof
--     harness and deliberately absent (§9.4).
-- ---------------------------------------------------------------------------
insert into public.deliverables
  (id, organization_id, project_id, title, deliverable_type, status,
   client_visible, due_date, submitted_at, approved_at, approved_by,
   owner_user_id, created_at)
values
  ('a4000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', 'Category template set v1',
   'PAGE_TEMPLATE_SET', 'CLIENT_REVIEW', true, current_date + 7,
   ((current_date - 2) + time '16:00:00') at time zone 'UTC',
   null, null, '33333333-3333-4333-8333-333333333333',
   ((current_date - 8) + time '09:00:00') at time zone 'UTC'),
  ('a4000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', 'Indexation audit',
   'AUDIT', 'IN_PROGRESS', false, current_date + 21,
   null, null, null, '33333333-3333-4333-8333-333333333333',
   ((current_date - 14) + time '09:00:00') at time zone 'UTC'),
  ('a4000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', 'Template set v2 — mobile variants',
   'PAGE_TEMPLATE_SET', 'APPROVED', true, current_date - 1,
   ((current_date - 6) + time '15:00:00') at time zone 'UTC',
   ((current_date - 3) + time '14:00:00') at time zone 'UTC',
   '44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333',
   ((current_date - 12) + time '09:00:00') at time zone 'UTC'),
  ('a4000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', 'Q3 SEO playbook',
   'DOCUMENT', 'PUBLISHED', true, current_date - 10,
   ((current_date - 12) + time '13:00:00') at time zone 'UTC',
   ((current_date - 11) + time '10:00:00') at time zone 'UTC',
   '44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333',
   ((current_date - 16) + time '09:00:00') at time zone 'UTC'),
  ('a4000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000002', 'Q3 paid growth campaign',
   'CAMPAIGN', 'CLIENT_REVIEW', true, current_date + 2,
   ((current_date - 1) + time '15:00:00') at time zone 'UTC',
   null, null, '70000000-0000-4000-8000-000000000002',
   ((current_date - 6) + time '09:00:00') at time zone 'UTC'),
  ('a4000000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000002', 'Creative testing framework',
   'DOCUMENT', 'SUBMITTED', true, current_date - 2,
   ((current_date - 4) + time '15:00:00') at time zone 'UTC',
   null, null, '70000000-0000-4000-8000-000000000002',
   ((current_date - 8) + time '09:00:00') at time zone 'UTC'),
  ('a4000000-0000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000003', 'LCP remediation bundle',
   'DOCUMENT', 'INTERNAL_REVIEW', false, current_date - 3,
   ((current_date - 5) + time '15:00:00') at time zone 'UTC',
   null, null, '70000000-0000-4000-8000-000000000001',
   ((current_date - 12) + time '09:00:00') at time zone 'UTC'),
  ('a4000000-0000-4000-8000-000000000008', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000003', 'CWV field data review',
   'AUDIT', 'DRAFT', false, current_date + 14,
   null, null, null, '70000000-0000-4000-8000-000000000001',
   ((current_date - 10) + time '09:00:00') at time zone 'UTC'),
  ('a4000000-0000-4000-8000-000000000009', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000004', 'Nurture sequence v1',
   'AUTOMATION', 'REVISION_REQUESTED', true, current_date + 5,
   ((current_date - 8) + time '15:00:00') at time zone 'UTC',
   null, null, '70000000-0000-4000-8000-000000000003',
   ((current_date - 14) + time '09:00:00') at time zone 'UTC'),
  ('a4000000-0000-4000-8000-000000000010', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000004', 'Nurture sequence v2',
   'AUTOMATION', 'APPROVED', true, current_date + 9,
   ((current_date - 2) + time '15:00:00') at time zone 'UTC',
   ((current_date - 1) + time '09:30:00') at time zone 'UTC',
   '44444444-4444-4444-8444-444444444444', '70000000-0000-4000-8000-000000000003',
   ((current_date - 14) + time '09:00:00') at time zone 'UTC'),
  ('a4000000-0000-4000-8000-000000000011', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000006', 'Site authority audit',
   'AUDIT', 'PUBLISHED', true, current_date - 400,
   ((current_date - 405) + time '13:00:00') at time zone 'UTC',
   ((current_date - 404) + time '10:00:00') at time zone 'UTC',
   '44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333',
   ((current_date - 418) + time '09:00:00') at time zone 'UTC'),
  ('b4000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000001', 'Design system foundations',
   'DESIGN', 'IN_PROGRESS', false, current_date + 14,
   null, null, null, '70000000-0000-4000-8000-000000000001',
   ((current_date - 30) + time '09:00:00') at time zone 'UTC'),
  ('b4000000-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000001', 'Site rebuild scope doc',
   'DOCUMENT', 'INTERNAL_REVIEW', false, current_date + 7,
   ((current_date - 3) + time '15:00:00') at time zone 'UTC',
   null, null, '70000000-0000-4000-8000-000000000001',
   ((current_date - 12) + time '09:00:00') at time zone 'UTC'),
  ('b4000000-0000-4000-8000-000000000004', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000004', 'Founder video — episode 1',
   'VIDEO', 'CLIENT_REVIEW', true, current_date + 3,
   ((current_date - 1) + time '15:00:00') at time zone 'UTC',
   null, null, '70000000-0000-4000-8000-000000000005',
   ((current_date - 12) + time '09:00:00') at time zone 'UTC'),
  ('b4000000-0000-4000-8000-000000000005', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000004', 'Episode 1 title pack & thumbnails',
   'DESIGN', 'APPROVED', true, current_date - 2,
   ((current_date - 5) + time '15:00:00') at time zone 'UTC',
   ((current_date - 2) + time '11:00:00') at time zone 'UTC',
   '66666666-6666-4666-8666-666666666666', '70000000-0000-4000-8000-000000000005',
   ((current_date - 12) + time '09:00:00') at time zone 'UTC'),
  ('b4000000-0000-4000-8000-000000000006', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000003', 'RAG connector POC',
   'AUTOMATION', 'CLIENT_REVIEW', true, current_date + 6,
   ((current_date - 1) + time '15:00:00') at time zone 'UTC',
   null, null, '70000000-0000-4000-8000-000000000004',
   ((current_date - 10) + time '09:00:00') at time zone 'UTC'),
  ('b4000000-0000-4000-8000-000000000007', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000002', 'Redirect & 301 map',
   'DOCUMENT', 'IN_PROGRESS', false, current_date + 9,
   null, null, null, '33333333-3333-4333-8333-333333333333',
   ((current_date - 14) + time '09:00:00') at time zone 'UTC'),
  ('d4000000-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004',
   'd3000000-0000-4000-8000-000000000001', 'Paid creative set v1',
   'CAMPAIGN', 'IN_PROGRESS', false, current_date - 30,
   null, null, null, '70000000-0000-4000-8000-000000000002',
   ((current_date - 60) + time '09:00:00') at time zone 'UTC'),
  ('d4000000-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000004',
   'd3000000-0000-4000-8000-000000000002', 'Technical SEO audit',
   'AUDIT', 'PUBLISHED', true, current_date - 380,
   ((current_date - 382) + time '13:00:00') at time zone 'UTC',
   ((current_date - 380) + time '10:00:00') at time zone 'UTC',
   '80000000-0000-4000-8000-000000000005', '33333333-3333-4333-8333-333333333333',
   ((current_date - 395) + time '09:00:00') at time zone 'UTC')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 10. Deliverable versions — 13 append-only history rows (§6.3)
-- ---------------------------------------------------------------------------
insert into public.deliverable_versions
  (id, organization_id, deliverable_id, version_number, summary, status,
   submitted_by, submitted_at, reviewed_by, reviewed_at, review_outcome,
   review_notes, created_at)
values
  ('a6000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000001', 1, null, 'SUBMITTED',
   '33333333-3333-4333-8333-333333333333',
   ((current_date - 2) + time '16:00:00') at time zone 'UTC',
   null, null, null, null,
   ((current_date - 2) + time '16:00:00') at time zone 'UTC'),
  ('a6000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000003', 1, null, 'SUBMITTED',
   '33333333-3333-4333-8333-333333333333',
   ((current_date - 6) + time '15:00:00') at time zone 'UTC',
   '44444444-4444-4444-8444-444444444444',
   ((current_date - 5) + time '09:00:00') at time zone 'UTC',
   'REVISION_REQUESTED',
   'Add explicit mobile breakpoint variants before approval.',
   ((current_date - 6) + time '15:00:00') at time zone 'UTC'),
  ('a6000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000003', 2, null, 'SUBMITTED',
   '33333333-3333-4333-8333-333333333333',
   ((current_date - 3) + time '12:00:00') at time zone 'UTC',
   '44444444-4444-4444-8444-444444444444',
   ((current_date - 3) + time '14:00:00') at time zone 'UTC',
   'APPROVED', 'Mobile variants look right — approving.',
   ((current_date - 3) + time '12:00:00') at time zone 'UTC'),
  ('a6000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000004', 1, null, 'SUBMITTED',
   '33333333-3333-4333-8333-333333333333',
   ((current_date - 12) + time '13:00:00') at time zone 'UTC',
   '44444444-4444-4444-8444-444444444444',
   ((current_date - 11) + time '10:00:00') at time zone 'UTC',
   'APPROVED', 'Approved for publication.',
   ((current_date - 12) + time '13:00:00') at time zone 'UTC'),
  ('a6000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000005', 1, null, 'SUBMITTED',
   '70000000-0000-4000-8000-000000000002',
   ((current_date - 1) + time '15:00:00') at time zone 'UTC',
   null, null, null, null,
   ((current_date - 1) + time '15:00:00') at time zone 'UTC'),
  ('a6000000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000006', 1, null, 'SUBMITTED',
   '70000000-0000-4000-8000-000000000002',
   ((current_date - 4) + time '15:00:00') at time zone 'UTC',
   null, null, null, null,
   ((current_date - 4) + time '15:00:00') at time zone 'UTC'),
  ('a6000000-0000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000009', 1, null, 'SUBMITTED',
   '70000000-0000-4000-8000-000000000003',
   ((current_date - 8) + time '15:00:00') at time zone 'UTC',
   '44444444-4444-4444-8444-444444444444',
   ((current_date - 4) + time '10:00:00') at time zone 'UTC',
   'REVISION_REQUESTED', 'Swap emails 3 and 4 in the nurture sequence.',
   ((current_date - 8) + time '15:00:00') at time zone 'UTC'),
  ('a6000000-0000-4000-8000-000000000008', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000010', 1, null, 'SUBMITTED',
   '70000000-0000-4000-8000-000000000003',
   ((current_date - 2) + time '15:00:00') at time zone 'UTC',
   '44444444-4444-4444-8444-444444444444',
   ((current_date - 1) + time '09:30:00') at time zone 'UTC',
   'APPROVED', 'Approved.',
   ((current_date - 2) + time '15:00:00') at time zone 'UTC'),
  ('a6000000-0000-4000-8000-000000000009', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000011', 1, null, 'SUBMITTED',
   '33333333-3333-4333-8333-333333333333',
   ((current_date - 405) + time '13:00:00') at time zone 'UTC',
   '44444444-4444-4444-8444-444444444444',
   ((current_date - 404) + time '10:00:00') at time zone 'UTC',
   'APPROVED', 'Approved — sign off on the audit.',
   ((current_date - 405) + time '13:00:00') at time zone 'UTC'),
  ('b6000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b4000000-0000-4000-8000-000000000004', 1, null, 'SUBMITTED',
   '70000000-0000-4000-8000-000000000005',
   ((current_date - 1) + time '15:00:00') at time zone 'UTC',
   null, null, null, null,
   ((current_date - 1) + time '15:00:00') at time zone 'UTC'),
  ('b6000000-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b4000000-0000-4000-8000-000000000005', 1, null, 'SUBMITTED',
   '70000000-0000-4000-8000-000000000005',
   ((current_date - 5) + time '15:00:00') at time zone 'UTC',
   '66666666-6666-4666-8666-666666666666',
   ((current_date - 2) + time '11:00:00') at time zone 'UTC',
   'APPROVED', 'Title pack approved.',
   ((current_date - 5) + time '15:00:00') at time zone 'UTC'),
  ('b6000000-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b4000000-0000-4000-8000-000000000006', 1, null, 'SUBMITTED',
   '70000000-0000-4000-8000-000000000004',
   ((current_date - 1) + time '15:00:00') at time zone 'UTC',
   null, null, null, null,
   ((current_date - 1) + time '15:00:00') at time zone 'UTC'),
  ('d6000000-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004',
   'd4000000-0000-4000-8000-000000000002', 1, null, 'SUBMITTED',
   '33333333-3333-4333-8333-333333333333',
   ((current_date - 382) + time '13:00:00') at time zone 'UTC',
   '80000000-0000-4000-8000-000000000005',
   ((current_date - 380) + time '10:00:00') at time zone 'UTC',
   'APPROVED', 'Approved for publication.',
   ((current_date - 382) + time '13:00:00') at time zone 'UTC')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 11. Tasks — 32 rows (§6.1), all 6 statuses, 10 deliberately overdue
-- ---------------------------------------------------------------------------
-- Every assignee holds a live non-OBSERVER project membership (the
-- tasks_assignee_project_member trigger demands it — exercised, not evaded).
-- Overdue = due_date < T and status not DONE/CANCELLED.
insert into public.tasks
  (id, organization_id, project_id, deliverable_id, title, status, priority,
   assignee_user_id, assigned_team, due_date, started_at, completed_at,
   estimated_hours, actual_hours, blocked_reason, position, created_at)
values
  -- ---- Acme · a3-001 (category template rollout) ----
  ('a7000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001',
   'Build the PDP template variant', 'IN_PROGRESS', 'HIGH',
   '33333333-3333-4333-8333-333333333333', 'SEO', current_date + 3,
   ((current_date - 8) + time '10:00:00') at time zone 'UTC', null,
   12, null, null, 1, now() - interval '10 days'),
  ('a7000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', null,
   'Investigate crawl budget anomaly', 'TODO', 'MEDIUM',
   '33333333-3333-4333-8333-333333333333', 'SEO', current_date + 10,
   null, null, 4, null, null, 2, now() - interval '7 days'),
  ('a7000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', null,
   'Finalize mobile template QA', 'TODO', 'HIGH',
   '33333333-3333-4333-8333-333333333333', 'SEO', current_date - 3,
   null, null, 6, null, null, 3, now() - interval '6 days'),   -- overdue
  ('a7000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', null,
   'Index scheduling regression', 'BLOCKED', 'URGENT',
   '70000000-0000-4000-8000-000000000001', 'WEB_DEVELOPMENT',
   current_date - 5,
   ((current_date - 20) + time '10:00:00') at time zone 'UTC', null,
   8, null, 'Search Console historical data export pending',
   4, now() - interval '20 days'),                            -- overdue
  ('a7000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', null,
   'Roll out data layer to 1,200 pages', 'IN_REVIEW', 'HIGH',
   '70000000-0000-4000-8000-000000000001', 'SEO', current_date - 1,
   ((current_date - 6) + time '10:00:00') at time zone 'UTC', null,
   16, 14, null, 5, now() - interval '8 days'),               -- overdue
  ('a7000000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000003',
   'Deliverable QA pass on template set', 'DONE', 'MEDIUM',
   '33333333-3333-4333-8333-333333333333', 'SEO', current_date - 3,
   ((current_date - 6) + time '10:00:00') at time zone 'UTC',
   ((current_date - 3) + time '16:00:00') at time zone 'UTC',
   5, 6, null, 6, now() - interval '7 days'),
  -- ---- Acme · a3-002 (paid acquisition Q3) ----
  ('a7000000-0000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000002', null,
   'Launch creative testing matrix v1', 'IN_PROGRESS', 'HIGH',
   '70000000-0000-4000-8000-000000000002', 'PAID_MEDIA', current_date + 1,
   ((current_date - 3) + time '10:00:00') at time zone 'UTC', null,
   10, null, null, 1, now() - interval '5 days'),   -- due-soon
  ('a7000000-0000-4000-8000-000000000008', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000002', null,
   'CAPI match-rate monitoring', 'TODO', 'MEDIUM',
   '70000000-0000-4000-8000-000000000002', 'PAID_MEDIA', current_date - 2,
   null, null, 6, null, null, 2, now() - interval '4 days'),  -- overdue
  ('a7000000-0000-4000-8000-000000000009', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000002', null,
   'Retargeting exclusion list buildout', 'DONE', 'MEDIUM',
   '70000000-0000-4000-8000-000000000002', 'PAID_MEDIA', current_date - 4,
   ((current_date - 8) + time '10:00:00') at time zone 'UTC',
   ((current_date - 4) + time '15:00:00') at time zone 'UTC',
   4, 4, null, 3, now() - interval '9 days'),
  -- ---- Acme · a3-003 (Core Web Vitals, blocked) ----
  ('a7000000-0000-4000-8000-000000000010', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000003', null,
   'Remove render-blocking CSS from PDP', 'IN_PROGRESS', 'URGENT',
   '70000000-0000-4000-8000-000000000001', 'WEB_DEVELOPMENT', current_date - 4,
   ((current_date - 12) + time '10:00:00') at time zone 'UTC', null,
   9, null, null, 1, now() - interval '14 days'),              -- overdue
  ('a7000000-0000-4000-8000-000000000011', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000003', null,
   'Vendor JS budget audit', 'BLOCKED', 'HIGH',
   '70000000-0000-4000-8000-000000000001', 'WEB_DEVELOPMENT', current_date - 7,
   ((current_date - 12) + time '10:00:00') at time zone 'UTC', null,
   5, null, 'Awaiting client CMS admin access', 2,
   now() - interval '14 days'),                                -- overdue
  ('a7000000-0000-4000-8000-000000000012', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000003', null,
   'LCP experiment analysis', 'DONE', 'MEDIUM',
   '70000000-0000-4000-8000-000000000001', 'WEB_DEVELOPMENT', current_date - 9,
   ((current_date - 14) + time '10:00:00') at time zone 'UTC',
   ((current_date - 9) + time '15:00:00') at time zone 'UTC',
   3, 2, null, 3, now() - interval '16 days'),
  -- ---- Acme · a3-004 (nurture revamp, in review) ----
  ('a7000000-0000-4000-8000-000000000013', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000004', 'a4000000-0000-4000-8000-000000000009',
   'Segment refresh for nurture', 'IN_REVIEW', 'HIGH',
   '70000000-0000-4000-8000-000000000003', 'CRM_LIFECYCLE', current_date + 2,
   ((current_date - 4) + time '10:00:00') at time zone 'UTC', null,
   8, null, null, 1, now() - interval '6 days'),
  ('a7000000-0000-4000-8000-000000000014', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000004', null,
   'Nurture sequence copy deck', 'DONE', 'HIGH',
   '70000000-0000-4000-8000-000000000003', 'CRM_LIFECYCLE', current_date - 2,
   ((current_date - 8) + time '10:00:00') at time zone 'UTC',
   ((current_date - 2) + time '16:00:00') at time zone 'UTC',
   6, 6, null, 2, now() - interval '9 days'),
  ('a7000000-0000-4000-8000-000000000015', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000004', null,
   'AI lead-scoring model v1', 'IN_PROGRESS', 'MEDIUM',
   '70000000-0000-4000-8000-000000000004', 'AI_AUTOMATION', current_date - 3,
   ((current_date - 5) + time '10:00:00') at time zone 'UTC', null,
   14, null, null, 3, now() - interval '7 days'),              -- overdue
  -- ---- Acme · a3-005 (internal project) ----
  ('a7000000-0000-4000-8000-000000000016', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000005', null,
   'Renewal pricing scenarios', 'IN_PROGRESS', 'MEDIUM',
   '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGEMENT', current_date + 14,
   ((current_date - 4) + time '10:00:00') at time zone 'UTC', null,
   6, null, null, 1, now() - interval '6 days'),
  -- ---- Acme · a3-006 (completed audit) ----
  ('a7000000-0000-4000-8000-000000000017', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000006', null,
   'Crawl implementation audit', 'DONE', 'HIGH',
   '33333333-3333-4333-8333-333333333333', 'SEO', current_date - 400,
   ((current_date - 405) + time '10:00:00') at time zone 'UTC',
   ((current_date - 380) + time '17:00:00') at time zone 'UTC',
   10, 11, null, 1, now() - interval '420 days'),
  ('a7000000-0000-4000-8000-000000000018', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000006', null,
   'Internal linking QA', 'DONE', 'MEDIUM',
   '70000000-0000-4000-8000-000000000006', 'SEO', current_date - 395,
   ((current_date - 400) + time '10:00:00') at time zone 'UTC',
   ((current_date - 370) + time '17:00:00') at time zone 'UTC',
   8, 9, null, 2, now() - interval '420 days'),
  -- ---- Globex · b3-001 (rebuild phase one) ----
  ('b7000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000001', null,
   'Migrate contact form to edge functions', 'IN_PROGRESS', 'URGENT',
   '70000000-0000-4000-8000-000000000001', 'WEB_DEVELOPMENT', current_date + 10,
   ((current_date - 10) + time '10:00:00') at time zone 'UTC', null,
   12, null, null, 1, now() - interval '15 days'),
  ('b7000000-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000001', null,
   'CSP header rollout', 'BLOCKED', 'HIGH',
   '70000000-0000-4000-8000-000000000001', 'WEB_DEVELOPMENT', current_date - 2,
   ((current_date - 6) + time '10:00:00') at time zone 'UTC', null,
   4, null, 'Security review approval pending', 2,
   now() - interval '8 days'),                                 -- overdue
  ('b7000000-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000001', null,
   'Design tokens export pipeline', 'DONE', 'MEDIUM',
   '70000000-0000-4000-8000-000000000005', 'WEB_DEVELOPMENT', current_date - 6,
   ((current_date - 10) + time '10:00:00') at time zone 'UTC',
   ((current_date - 6) + time '15:00:00') at time zone 'UTC',
   5, 4, null, 3, now() - interval '12 days'),
  -- ---- Globex · b3-002 (SEO on the web service, ADR-0006) ----
  ('b7000000-0000-4000-8000-000000000004', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000002', null,
   'Build 301 map for legacy URLs', 'IN_PROGRESS', 'HIGH',
   '33333333-3333-4333-8333-333333333333', 'SEO', current_date + 5,
   ((current_date - 12) + time '10:00:00') at time zone 'UTC', null,
   10, null, null, 1, now() - interval '14 days'),
  ('b7000000-0000-4000-8000-000000000005', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000002', null,
   'Canonical audit', 'TODO', 'MEDIUM',
   '33333333-3333-4333-8333-333333333333', 'SEO', current_date + 12,
   null, null, 4, null, null, 2, now() - interval '6 days'),
  -- ---- Globex · b3-003 (AI) ----
  ('b7000000-0000-4000-8000-000000000006', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000003', null,
   'RAG ingest pipeline v1', 'IN_PROGRESS', 'HIGH',
   '70000000-0000-4000-8000-000000000004', 'AI_AUTOMATION', current_date - 1,
   ((current_date - 6) + time '10:00:00') at time zone 'UTC', null,
   20, null, null, 1, now() - interval '8 days'),              -- overdue
  ('b7000000-0000-4000-8000-000000000007', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000003', null,
   'Map 12 automation candidates', 'TODO', 'MEDIUM',
   '70000000-0000-4000-8000-000000000004', 'AI_AUTOMATION', current_date + 14,
   null, null, 8, null, null, 2, now() - interval '5 days'),
  -- ---- Globex · b3-004 (video) ----
  ('b7000000-0000-4000-8000-000000000008', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000004', 'b4000000-0000-4000-8000-000000000004',
   'Storyboard episode 1', 'DONE', 'HIGH',
   '70000000-0000-4000-8000-000000000005', 'VIDEO_MULTIMEDIA', current_date - 10,
   ((current_date - 12) + time '10:00:00') at time zone 'UTC',
   ((current_date - 10) + time '15:00:00') at time zone 'UTC',
   3, 3, null, 1, now() - interval '14 days'),
  ('b7000000-0000-4000-8000-000000000009', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000004', 'b4000000-0000-4000-8000-000000000004',
   'Edit episode 1 cut', 'IN_REVIEW', 'HIGH',
   '70000000-0000-4000-8000-000000000005', 'VIDEO_MULTIMEDIA', current_date + 4,
   ((current_date - 1) + time '10:00:00') at time zone 'UTC', null,
   6, null, null, 2, now() - interval '3 days'),
  -- ---- Initech · c3-001 (unassigned team queue) ----
  ('c7000000-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003',
   'c3000000-0000-4000-8000-000000000001', null,
   'Stakeholder interview synthesis', 'TODO', 'MEDIUM',
   null, 'WEB_DEVELOPMENT', current_date + 21, null, null,
   6, null, null, 1, now() - interval '5 days'),
  -- ---- Umbrella · d3-001 (blocked, paused) ----
  ('d7000000-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004',
   'd3000000-0000-4000-8000-000000000001', null,
   'Rebuild creative refresh calendar', 'BLOCKED', 'HIGH',
   '70000000-0000-4000-8000-000000000002', 'PAID_MEDIA', current_date - 21,
   ((current_date - 45) + time '10:00:00') at time zone 'UTC', null,
   6, null, 'Client account suspended — awaiting reactivation',
   1, now() - interval '60 days'),                              -- overdue
  ('d7000000-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000004',
   'd3000000-0000-4000-8000-000000000001', null,
   'Pause flight pacing', 'DONE', 'MEDIUM',
   '70000000-0000-4000-8000-000000000002', 'PAID_MEDIA', current_date - 60,
   ((current_date - 62) + time '10:00:00') at time zone 'UTC',
   ((current_date - 60) + time '15:00:00') at time zone 'UTC',
   2, 2, null, 2, now() - interval '65 days'),
  -- ---- Umbrella · d3-002 (completed sprint) ----
  ('d7000000-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000004',
   'd3000000-0000-4000-8000-000000000002', null,
   'Authority content sprint brief', 'DONE', 'HIGH',
   '33333333-3333-4333-8333-333333333333', 'SEO', current_date - 390,
   ((current_date - 395) + time '10:00:00') at time zone 'UTC',
   ((current_date - 390) + time '17:00:00') at time zone 'UTC',
   8, 8, null, 1, now() - interval '500 days'),
  ('d7000000-0000-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000004',
   'd3000000-0000-4000-8000-000000000002', null,
   'Editorial QA', 'DONE', 'MEDIUM',
   '70000000-0000-4000-8000-000000000006', 'SEO', current_date - 380,
   ((current_date - 385) + time '10:00:00') at time zone 'UTC',
   ((current_date - 380) + time '17:00:00') at time zone 'UTC',
   5, 5, null, 2, now() - interval '500 days')
on conflict (id) do nothing;
-- ---------------------------------------------------------------------------
-- 12. Comments — 12 rows (§6.4)
-- ---------------------------------------------------------------------------
insert into public.comments
  (id, organization_id, deliverable_id, task_id, parent_comment_id,
   author_user_id, body, is_internal, created_at)
values
  ('a8000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000001', null, null,
   '44444444-4444-4444-8444-444444444444',
   'Looks strong. Can we see the mobile breakpoint before we approve?',
   false, ((current_date - 2) + time '10:30:00') at time zone 'UTC'),
  ('a8000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000001', null, null,
   '33333333-3333-4333-8333-333333333333',
   'Mobile variant is behind a flag; margin is tight on this one.',
   true, ((current_date - 2) + time '11:05:00') at time zone 'UTC'),
  ('a8000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000009', null, null,
   '44444444-4444-4444-8444-444444444444',
   'Revision: swap emails 3 and 4 in the nurture sequence.',
   false, ((current_date - 4) + time '10:00:00') at time zone 'UTC'),
  ('a8000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000009', null,
   'a8000000-0000-4000-8000-000000000003',
   '70000000-0000-4000-8000-000000000003',
   'Adjusted; v2 is uploaded.',
   true, ((current_date - 2) + time '15:20:00') at time zone 'UTC'),
  ('a8000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000005', null, null,
   '70000000-0000-4000-8000-000000000002',
   'Loving the creative direction, cara — can you confirm the channel variation list?',
   false, ((current_date - 1) + time '09:45:00') at time zone 'UTC'),
  ('a8000000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000007', null, null,
   '70000000-0000-4000-8000-000000000001',
   'LCP bundle is internal until the CWV picture stabilises.',
   true, ((current_date - 3) + time '16:10:00') at time zone 'UTC'),
  ('a8000000-0000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-000000000001',
   null, 'a7000000-0000-4000-8000-000000000011', null,
   '70000000-0000-4000-8000-000000000001',
   'Blocked on CMS admin access from the client side.',
   true, ((current_date - 6) + time '12:00:00') at time zone 'UTC'),
  ('a8000000-0000-4000-8000-000000000008', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000001', null, null,
   '55555555-5555-4555-8555-555555555555',
   'Confirming once the mobile variant is visible.',
   false, ((current_date - 1) + time '08:50:00') at time zone 'UTC'),
  ('a8000000-0000-4000-8000-000000000009', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000010', null, null,
   '44444444-4444-4444-8444-444444444444',
   'Approving v2. Ship it.',
   false, ((current_date - 1) + time '09:20:00') at time zone 'UTC'),
  ('b8000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b4000000-0000-4000-8000-000000000004', null, null,
   '66666666-6666-4666-8666-666666666666',
   'Love the first cut — one small edit at 02:14.',
   false, ((current_date - 1) + time '16:20:00') at time zone 'UTC'),
  ('b8000000-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b4000000-0000-4000-8000-000000000004', null,
   'b8000000-0000-4000-8000-000000000001',
   '70000000-0000-4000-8000-000000000005',
   'Edit flagged; new cut tomorrow.',
   false, ((current_date - 1) + time '17:05:00') at time zone 'UTC'),
  ('d8000000-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004',
   'd4000000-0000-4000-8000-000000000002', null, null,
   '80000000-0000-4000-8000-000000000005',
   'Great depth. Approving.',
   false, ((current_date - 380) + time '10:30:00') at time zone 'UTC')
on conflict (id) do nothing;

-- 13. Metrics — deterministic time-series (§7.1)
-- ---------------------------------------------------------------------------
-- value = round(base + idx * step + (idx % 7) * wobble, 2), idx 0-based from
-- the series start. Windows total 1,073 rows (Acme 789 + Globex 151 +
-- Umbrella 133); the design's "~350" estimate is superseded by the fixed
-- window table, and db-verify pins the exact count. Umbrella series stop at
-- the account pause/suspension points. Initech has no metrics (nothing
-- measured yet). No ids: identity is the natural key
-- (organization_id, coalesce(service_id, 0), metric_key, metric_date).
insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'aaaaaaaa-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000003',
  'CPA', (current_date - 89 + i)::date,
  round(61.5 + i * (-0.05) + (i % 7) * 2.2, 2), 'CURRENCY', 'USD', 'GOOGLE_ADS'
from generate_series(0, 89) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'aaaaaaaa-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000003',
  'CTR', (current_date - 89 + i)::date,
  round(1.9 + i * 0.003 + (i % 7) * 0.04, 2), 'PERCENT', null, 'META_ADS'
from generate_series(0, 89) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'aaaaaaaa-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000003',
  'CAPI_MATCH_RATE', (current_date - 89 + i)::date,
  round(74 + i * 0.02 + (i % 7) * 0.6, 2), 'PERCENT', null, 'INTERNAL'
from generate_series(0, 89) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'aaaaaaaa-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000004',
  'MQL_COUNT', (current_date - 84 + i * 7)::date,
  round(38 + i * 0.4 + (i % 7) * 3, 2), 'COUNT', null, 'CRM'
from generate_series(0, 12) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'aaaaaaaa-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000004',
  'SQL_COUNT', (current_date - 84 + i * 7)::date,
  round(14 + i * 0.2 + (i % 7) * 2, 2), 'COUNT', null, 'CRM'
from generate_series(0, 12) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'aaaaaaaa-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000004',
  'LEAD_RESPONSE_MINUTES', (current_date - 89 + i)::date,
  round(41 + i * (-0.04) + (i % 7) * 2.5, 2), 'MINUTES', null, 'CRM'
from generate_series(0, 89) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'aaaaaaaa-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000004',
  'PIPELINE_ENGINEERED', (current_date - 84 + i * 7)::date,
  round(185000 + i * 2200 + (i % 7) * 15000, 2), 'CURRENCY', 'USD', 'CRM'
from generate_series(0, 12) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'aaaaaaaa-0000-4000-8000-000000000001', null,
  'LTV_CAC_RATIO',
  (date_trunc('month', current_date)::date + make_interval(months => i - 3))::date,
  round(3.1 + i * 0.02 + (i % 7) * 0.04, 2), 'RATIO', null, 'INTERNAL'
from generate_series(0, 3) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'aaaaaaaa-0000-4000-8000-000000000001', null,
  'REVENUE', (current_date - 84 + i * 7)::date,
  round(42000 + i * 380 + (i % 7) * 2100, 2), 'CURRENCY', 'USD', 'CRM'
from generate_series(0, 12) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'bbbbbbbb-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001',
  'P75_LCP_MS', (current_date - 84 + i * 7)::date,
  round(2980 + i * (-38) + (i % 7) * 90, 2), 'MILLISECONDS', null, 'CRUX'
from generate_series(0, 12) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'bbbbbbbb-0000-4000-8000-000000000002', null,
  'SESSIONS', (current_date - 59 + i)::date,
  round(1100 + i * 4 + (i % 7) * 15, 2), 'COUNT', null, 'GA4'
from generate_series(0, 59) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'bbbbbbbb-0000-4000-8000-000000000002', null,
  'REVENUE', (current_date - 56 + i * 7)::date,
  round(9600 + i * 120 + (i % 7) * 700, 2), 'CURRENCY', 'GBP', 'CRM'
from generate_series(0, 8) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'bbbbbbbb-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002',
  'CAPI_MATCH_RATE', (current_date - 59 + i)::date,
  round(68 + i * 0.05 + (i % 7) * 0.8, 2), 'PERCENT', null, 'INTERNAL'
from generate_series(0, 59) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'bbbbbbbb-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000003',
  'BLENDED_ROAS', (current_date - 56 + i * 7)::date,
  round(2.4 + i * 0.01 + (i % 7) * 0.05, 2), 'RATIO', null, 'INTERNAL'
from generate_series(0, 8) as i
on conflict do nothing;

-- Umbrella: series stop at T−60 / T−380 (pause and historical end).
insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'dddddddd-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000001',
  'BLENDED_ROAS', (current_date - 144 + i * 7)::date,
  round(3.9 + i * 0 + (i % 7) * 0.05, 2), 'RATIO', null, 'INTERNAL'
from generate_series(0, 12) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'dddddddd-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000002',
  'PAGES_INDEXED', (current_date - 499 + i)::date,
  round(240 + i * 2 + (i % 7) * 5, 2), 'COUNT', null, 'SEARCH_CONSOLE'
from generate_series(0, 119) as i
on conflict do nothing;

-- ---------------------------------------------------------------------------
insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'aaaaaaaa-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001',
  'PAGES_INDEXED', (current_date - 89 + i)::date,
  round(800 + i * 37 + (i % 7) * 12, 2), 'COUNT', null, 'SEARCH_CONSOLE'
from generate_series(0, 89) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'aaaaaaaa-0000-4000-8000-000000000001', null,
  'SESSIONS', (current_date - 89 + i)::date,
  round(4200 + i * (-8) + (i % 7) * 34, 2), 'COUNT', null, 'GA4'
from generate_series(0, 89) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'aaaaaaaa-0000-4000-8000-000000000001', null,
  'CONVERSION_RATE', (current_date - 89 + i)::date,
  round(2.1 + i * 0.004 + (i % 7) * 0.05, 2), 'PERCENT', null, 'GA4'
from generate_series(0, 89) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'aaaaaaaa-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002',
  'P75_LCP_MS', (current_date - 84 + i * 7)::date,
  round(1740 + i * (-12) + (i % 7) * 60, 2), 'MILLISECONDS', null, 'CRUX'
from generate_series(0, 12) as i
on conflict do nothing;

insert into public.metrics
  (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
select
  'aaaaaaaa-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000003',
  'BLENDED_ROAS', (current_date - 89 + i)::date,
  round(3.6 + i * 0.006 + (i % 7) * 0.08, 2), 'RATIO', null, 'INTERNAL'
from generate_series(0, 89) as i
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 14. Reports — 8 (§7.2) with frozen report_metrics (30) (§7.2)
-- ---------------------------------------------------------------------------
insert into public.reports
  (id, organization_id, engagement_id, title, report_type, period_start,
   period_end, status, currency, summary_md, published_at, published_by,
   client_visible, created_at, created_by)
values
  ('a5000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'Monthly performance — last month',
   'PERFORMANCE',
   date_trunc('month', current_date)::date - interval '1 month',
   (date_trunc('month', current_date)::date - interval '1 day')::date,
   'PUBLISHED', 'USD',
   'Acme performance for the last full month.',
   ((current_date - 5) + time '09:30:00') at time zone 'UTC',
   '22222222-2222-4222-8222-222222222222', true,
   ((current_date - 12) + time '09:00:00') at time zone 'UTC',
   '22222222-2222-4222-8222-222222222222'),
  ('a5000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'Q3 executive snapshot',
   'EXECUTIVE_SUMMARY', current_date - 90, current_date - 1,
   'PUBLISHED', 'USD', 'Executive summary of the quarter to date.',
   ((current_date - 3) + time '09:30:00') at time zone 'UTC',
   '22222222-2222-4222-8222-222222222222', true,
   ((current_date - 9) + time '09:00:00') at time zone 'UTC',
   '22222222-2222-4222-8222-222222222222'),
  ('a5000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'Paid media mid-month',
   'CAMPAIGN', current_date - 15, current_date - 1,
   'DRAFT', 'USD', null, null, null, false,
   ((current_date - 2) + time '09:00:00') at time zone 'UTC',
   '70000000-0000-4000-8000-000000000002'),
  ('a5000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000002', '2025 site authority audit report',
   'TECHNICAL_AUDIT', current_date - 420, current_date - 280,
   'ARCHIVED', 'USD', 'Published-then-archived audit report.',
   ((current_date - 380) + time '09:30:00') at time zone 'UTC',
   '22222222-2222-4222-8222-222222222222', true,
   ((current_date - 405) + time '09:00:00') at time zone 'UTC',
   '22222222-2222-4222-8222-222222222222'),
  ('b5000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b1000000-0000-4000-8000-000000000001', 'Kickoff baseline & CWV audit',
   'TECHNICAL_AUDIT', current_date - 89, current_date - 30,
   'PUBLISHED', 'GBP', 'Baseline audit published at kickoff.',
   ((current_date - 60) + time '09:30:00') at time zone 'UTC',
   '22222222-2222-4222-8222-222222222222', true,
   ((current_date - 80) + time '09:00:00') at time zone 'UTC',
   '22222222-2222-4222-8222-222222222222'),
  ('b5000000-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b1000000-0000-4000-8000-000000000001', 'Rebuild phase one status',
   'PERFORMANCE', current_date - 29, current_date - 1,
   'INTERNAL_REVIEW', 'GBP', null, null, null, false,
   ((current_date - 3) + time '09:00:00') at time zone 'UTC',
   '70000000-0000-4000-8000-000000000001'),
  ('d5000000-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004',
   'd1000000-0000-4000-8000-000000000002', '2024 Q4 final performance',
   'PERFORMANCE', current_date - 390, current_date - 330,
   'PUBLISHED', 'AUD', 'Final Q4 performance report.',
   ((current_date - 350) + time '09:30:00') at time zone 'UTC',
   '22222222-2222-4222-8222-222222222222', true,
   ((current_date - 380) + time '09:00:00') at time zone 'UTC',
   '22222222-2222-4222-8222-222222222222'),
  ('d5000000-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000004',
   'd1000000-0000-4000-8000-000000000001', 'Paid retargeting brief',
   'CAMPAIGN', current_date - 45, current_date - 1,
   'DRAFT', 'AUD', null, null, null, false,
   ((current_date - 10) + time '09:00:00') at time zone 'UTC',
   '70000000-0000-4000-8000-000000000002')
on conflict (id) do nothing;

-- report_metrics: frozen snapshots. Report/key sets keep every enum key
-- reachable and every report to 3–5 rows (30 total).
insert into public.report_metrics
  (organization_id, report_id, metric_key, value, unit, currency,
   comparison_value, comparison_label, sort_order, created_at)
values
  -- a5-001 monthly performance (5)
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001',
   'PIPELINE_ENGINEERED', 185000, 'CURRENCY', 'USD', 172500, 'Previous month', 1,
   ((current_date - 5) + time '09:30:00') at time zone 'UTC'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001',
   'BLENDED_ROAS', 4.20, 'RATIO', null, 3.90, 'Previous month', 2,
   ((current_date - 5) + time '09:30:00') at time zone 'UTC'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001',
   'PAGES_INDEXED', 1892, 'COUNT', null, 1500, 'Previous month', 3,
   ((current_date - 5) + time '09:30:00') at time zone 'UTC'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001',
   'SESSIONS', 124800, 'COUNT', null, 132000, 'Previous month', 4,
   ((current_date - 5) + time '09:30:00') at time zone 'UTC'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001',
   'LEAD_RESPONSE_MINUTES', 38, 'MINUTES', null, 52, 'Previous month', 5,
   ((current_date - 5) + time '09:30:00') at time zone 'UTC'),
  -- a5-002 executive snapshot (4)
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002',
   'REVENUE', 186000, 'CURRENCY', 'USD', 150000, 'Previous period', 1,
   ((current_date - 3) + time '09:30:00') at time zone 'UTC'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002',
   'MQL_COUNT', 160, 'COUNT', null, 138, 'Previous period', 2,
   ((current_date - 3) + time '09:30:00') at time zone 'UTC'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002',
   'CONVERSION_RATE', 2.42, 'PERCENT', null, 2.31, 'Previous period', 3,
   ((current_date - 3) + time '09:30:00') at time zone 'UTC'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002',
   'LTV_CAC_RATIO', 3.16, 'RATIO', null, 3.08, 'Previous period', 4,
   ((current_date - 3) + time '09:30:00') at time zone 'UTC'),
  -- a5-003 paid media mid-month draft (3)
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000003',
   'CPA', 58.2, 'CURRENCY', 'USD', 61.5, 'Prior mid-month', 1,
   ((current_date - 2) + time '09:00:00') at time zone 'UTC'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000003',
   'CTR', 2.05, 'PERCENT', null, 1.9, 'Prior mid-month', 2,
   ((current_date - 2) + time '09:00:00') at time zone 'UTC'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000003',
   'CAPI_MATCH_RATE', 75.5, 'PERCENT', null, 72.0, 'Prior mid-month', 3,
   ((current_date - 2) + time '09:00:00') at time zone 'UTC'),
  -- a5-004 archived audit report (3)
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000004',
   'PAGES_INDEXED', 1500, 'COUNT', null, 1240, 'Pre-audit', 1,
   ((current_date - 380) + time '09:30:00') at time zone 'UTC'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000004',
   'P75_LCP_MS', 2210, 'MILLISECONDS', null, 2650, 'Pre-audit', 2,
   ((current_date - 380) + time '09:30:00') at time zone 'UTC'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000004',
   'SESSIONS', 88000, 'COUNT', null, 94000, 'Pre-audit', 3,
   ((current_date - 380) + time '09:30:00') at time zone 'UTC'),
  -- b5-001 kickoff baseline (5)
  ('bbbbbbbb-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000001',
   'P75_LCP_MS', 2740, 'MILLISECONDS', null, 3100, 'Pre-build', 1,
   ((current_date - 60) + time '09:30:00') at time zone 'UTC'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000001',
   'SESSIONS', 19500, 'COUNT', null, 18300, 'Pre-build', 2,
   ((current_date - 60) + time '09:30:00') at time zone 'UTC'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000001',
   'REVENUE', 13200, 'CURRENCY', 'GBP', 9800, 'Pre-build', 3,
   ((current_date - 60) + time '09:30:00') at time zone 'UTC'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000001',
   'CAPI_MATCH_RATE', 71.0, 'PERCENT', null, 68.0, 'Pre-build', 4,
   ((current_date - 60) + time '09:30:00') at time zone 'UTC'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000001',
   'BLENDED_ROAS', 2.51, 'RATIO', null, 2.40, 'Pre-build', 5,
   ((current_date - 60) + time '09:30:00') at time zone 'UTC'),
  -- b5-002 phase one status (4)
  ('bbbbbbbb-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000002',
   'P75_LCP_MS', 2210, 'MILLISECONDS', null, 2740, 'Kickoff', 1,
   ((current_date - 3) + time '09:00:00') at time zone 'UTC'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000002',
   'SESSIONS', 23400, 'COUNT', null, 19500, 'Kickoff', 2,
   ((current_date - 3) + time '09:00:00') at time zone 'UTC'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000002',
   'REVENUE', 16050, 'CURRENCY', 'GBP', 13200, 'Kickoff', 3,
   ((current_date - 3) + time '09:00:00') at time zone 'UTC'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000002',
   'CAPI_MATCH_RATE', 74.2, 'PERCENT', null, 71.0, 'Kickoff', 4,
   ((current_date - 3) + time '09:00:00') at time zone 'UTC'),
  -- d5-001 Q4 final (4)
  ('dddddddd-0000-4000-8000-000000000004', 'd5000000-0000-4000-8000-000000000001',
   'BLENDED_ROAS', 3.92, 'RATIO', null, 3.60, 'Previous quarter', 1,
   ((current_date - 350) + time '09:30:00') at time zone 'UTC'),
  ('dddddddd-0000-4000-8000-000000000004', 'd5000000-0000-4000-8000-000000000001',
   'PAGES_INDEXED', 340, 'COUNT', null, 300, 'Previous quarter', 2,
   ((current_date - 350) + time '09:30:00') at time zone 'UTC'),
  ('dddddddd-0000-4000-8000-000000000004', 'd5000000-0000-4000-8000-000000000001',
   'SESSIONS', 92000, 'COUNT', null, 84000, 'Previous quarter', 3,
   ((current_date - 350) + time '09:30:00') at time zone 'UTC'),
  ('dddddddd-0000-4000-8000-000000000004', 'd5000000-0000-4000-8000-000000000001',
   'REVENUE', 32000, 'CURRENCY', 'AUD', 28000, 'Previous quarter', 4,
   ((current_date - 350) + time '09:30:00') at time zone 'UTC'),
  -- d5-002 retargeting brief draft (3)
  ('dddddddd-0000-4000-8000-000000000004', 'd5000000-0000-4000-8000-000000000002',
   'BLENDED_ROAS', 3.95, 'RATIO', null, 3.90, 'Pre-pause', 1,
   ((current_date - 10) + time '09:00:00') at time zone 'UTC'),
  ('dddddddd-0000-4000-8000-000000000004', 'd5000000-0000-4000-8000-000000000002',
   'CPA', 42.0, 'CURRENCY', 'AUD', 45.0, 'Pre-pause', 2,
   ((current_date - 10) + time '09:00:00') at time zone 'UTC'),
  ('dddddddd-0000-4000-8000-000000000004', 'd5000000-0000-4000-8000-000000000002',
   'PAGES_INDEXED', 330, 'COUNT', null, 320, 'Pre-pause', 3,
   ((current_date - 10) + time '09:00:00') at time zone 'UTC')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 15. Notifications — 24 rows, all 11 types (§7.3)
-- ---------------------------------------------------------------------------
insert into public.notifications
  (id, recipient_user_id, organization_id, notification_type, severity, title,
   body, subject_entity, subject_id, action_url, read_at, archived_at,
   created_at)
values
  ('e5000000-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444',
   'aaaaaaaa-0000-4000-8000-000000000001', 'DELIVERABLE_SUBMITTED', 'INFO',
   'Category template set v1 submitted',
   'Cara submitted the mobile template set for review.',
   'deliverable', 'a4000000-0000-4000-8000-000000000001',
   '/portal/acme-industrials/deliverable/a4-001',
   ((current_date - 2) + time '16:30:00') at time zone 'UTC', null,
   ((current_date - 2) + time '16:00:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000002', '33333333-3333-4333-8333-333333333333',
   'aaaaaaaa-0000-4000-8000-000000000001', 'DELIVERABLE_APPROVED', 'INFO',
   'Template set v2 approved',
   'Dana approved the mobile variant template set.',
   'deliverable', 'a4000000-0000-4000-8000-000000000003',
   '/portal/acme-industrials/deliverable/a4-003',
   ((current_date - 3) + time '14:30:00') at time zone 'UTC', null,
   ((current_date - 3) + time '14:00:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000003',
   'aaaaaaaa-0000-4000-8000-000000000001', 'REVISION_REQUESTED', 'WARNING',
   'Nurture v1 revision requested',
   'Dana asked to swap emails 3 and 4 in the nurture sequence.',
   'deliverable', 'a4000000-0000-4000-8000-000000000009',
   '/portal/acme-industrials/deliverable/a4-009', null, null,
   ((current_date - 4) + time '10:15:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000004', '44444444-4444-4444-8444-444444444444',
   'aaaaaaaa-0000-4000-8000-000000000001', 'REPORT_PUBLISHED', 'INFO',
   'Monthly performance report published',
   'The latest monthly performance report is ready to read.',
   'report', 'a5000000-0000-4000-8000-000000000001',
   '/portal/acme-industrials/report/a5-001',
   ((current_date - 5) + time '10:00:00') at time zone 'UTC',
   ((current_date - 4) + time '09:00:00') at time zone 'UTC',
   ((current_date - 5) + time '09:30:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000005', '44444444-4444-4444-8444-444444444444',
   'aaaaaaaa-0000-4000-8000-000000000001', 'REPORT_PUBLISHED', 'INFO',
   'Q3 executive snapshot published',
   'Your Q3 executive snapshot is ready to read.', null, null,
   '/portal/acme-industrials/report/a5-002', null, null,
   ((current_date - 3) + time '09:45:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000006', '70000000-0000-4000-8000-000000000002',
   'aaaaaaaa-0000-4000-8000-000000000001', 'TASK_ASSIGNED', 'INFO',
   'Creative testing matrix launch assigned',
   'You are assigned: Launch creative testing matrix v1.',
   'task', 'a7000000-0000-4000-8000-000000000007',
   '/portal/acme-industrials/project/a3-002/task/a7-007',
   ((current_date - 4) + time '09:00:00') at time zone 'UTC', null,
   ((current_date - 4) + time '09:00:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000007', '70000000-0000-4000-8000-000000000002',
   'aaaaaaaa-0000-4000-8000-000000000001', 'TASK_DUE_SOON', 'WARNING',
   'Creative testing matrix due tomorrow',
   'Launch creative testing matrix v1 is due in 1 day.', null, null,
   '/portal/acme-industrials/project/a3-002/task/a7-007', null, null,
   ((current_date - 1) + time '08:00:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000008', '33333333-3333-4333-8333-333333333333',
   'aaaaaaaa-0000-4000-8000-000000000001', 'COMMENT_ADDED', 'INFO',
   'New comment on your deliverable',
   'Eli commented on Category template set v1.', null, null,
   '/portal/acme-industrials/deliverable/a4-001', null, null,
   ((current_date - 1) + time '08:55:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000009', '33333333-3333-4333-8333-333333333333',
   'aaaaaaaa-0000-4000-8000-000000000001', 'MENTION', 'INFO',
   'Priya mentioned you',
   'Priya mentioned you in a comment on the Q3 campaign.', null, null,
   '/portal/acme-industrials/deliverable/a4-005', null, null,
   ((current_date - 1) + time '09:50:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000010', '44444444-4444-4444-8444-444444444444',
   'aaaaaaaa-0000-4000-8000-000000000001', 'INVITATION_SENT', 'INFO',
   'New member invited',
   'Pierre Acme was invited to your organization.', null, null,
   '/portal/acme-industrials/members', ((current_date - 5) + time '11:00:00') at time zone 'UTC',
   null, ((current_date - 5) + time '11:00:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000011', '80000000-0000-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-000000000001', 'MEMBERSHIP_CHANGED', 'INFO',
   'Welcome to Acme Industrials',
   'Nova, you now have access to the Acme workspace.', null, null,
   '/portal/acme-industrials', null, null,
   ((current_date - 120) + time '10:30:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000012', '80000000-0000-4000-8000-000000000003',
   'aaaaaaaa-0000-4000-8000-000000000001', 'MEMBERSHIP_CHANGED', 'WARNING',
   'Acme access suspended',
   'Your Acme Industrials membership was suspended.',
   null, null, '/portal/acme-industrials',
   ((current_date - 3) + time '09:00:00') at time zone 'UTC', null,
   ((current_date - 3) + time '09:00:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000013', '66666666-6666-4666-8666-666666666666',
   'bbbbbbbb-0000-4000-8000-000000000002', 'DELIVERABLE_SUBMITTED', 'INFO',
   'Episode 1 first cut submitted',
   'Marcus submitted the first cut of Founder video episode 1.',
   'deliverable', 'b4000000-0000-4000-8000-000000000004',
   '/portal/globex-health/deliverable/b4-004', null, null,
   ((current_date - 1) + time '15:30:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000014', '70000000-0000-4000-8000-000000000005',
   'bbbbbbbb-0000-4000-8000-000000000002', 'DELIVERABLE_APPROVED', 'INFO',
   'Episode 1 title pack approved',
   'Fay approved the Episode 1 title pack & thumbnails.',
   'deliverable', 'b4000000-0000-4000-8000-000000000005',
   '/portal/globex-health/deliverable/b4-005',
   ((current_date - 2) + time '11:30:00') at time zone 'UTC', null,
   ((current_date - 2) + time '11:00:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000015', '66666666-6666-4666-8666-666666666666',
   'bbbbbbbb-0000-4000-8000-000000000002', 'REPORT_PUBLISHED', 'INFO',
   'Kickoff baseline audit published',
   'Your kickoff baseline & CWV audit is ready to read.',
   'report', 'b5000000-0000-4000-8000-000000000001',
   '/portal/globex-health/report/b5-001',
   ((current_date - 60) + time '10:00:00') at time zone 'UTC', null,
   ((current_date - 60) + time '09:30:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000016', '70000000-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000002', 'TASK_ASSIGNED', 'INFO',
   'CSP header rollout assigned',
   'You are assigned: CSP header rollout.',
   'task', 'b7000000-0000-4000-8000-000000000002',
   '/portal/globex-health/project/b3-001/task/b7-002',
   ((current_date - 6) + time '09:00:00') at time zone 'UTC', null,
   ((current_date - 6) + time '09:00:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000017', '70000000-0000-4000-8000-000000000004',
   'bbbbbbbb-0000-4000-8000-000000000002', 'TASK_ASSIGNED', 'INFO',
   'RAG ingest pipeline assigned',
   'You are assigned: RAG ingest pipeline v1.',
   'task', 'b7000000-0000-4000-8000-000000000006',
   '/portal/globex-health/project/b3-003/task/b7-006',
   ((current_date - 6) + time '09:00:00') at time zone 'UTC', null,
   ((current_date - 6) + time '09:00:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000018', '70000000-0000-4000-8000-000000000005',
   'bbbbbbbb-0000-4000-8000-000000000002', 'COMMENT_ADDED', 'INFO',
   'New comment on your deliverable',
   'Fay commented on Founder video — episode 1.', null, null,
   '/portal/globex-health/deliverable/b4-004', null, null,
   ((current_date - 1) + time '16:25:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000019', '80000000-0000-4000-8000-000000000005',
   'dddddddd-0000-4000-8000-000000000004', 'MEMBERSHIP_CHANGED', 'WARNING',
   'Account suspended',
   'Your Umbrella Labs account was suspended.',
   null, null, '/portal/umbrella-labs', null, null,
   ((current_date - 60) + time '17:00:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000020', '80000000-0000-4000-8000-000000000006',
   'dddddddd-0000-4000-8000-000000000004', 'REPORT_PUBLISHED', 'INFO',
   '2024 Q4 final performance published',
   'The 2024 Q4 final performance report is ready to read.',
   'report', 'd5000000-0000-4000-8000-000000000001',
   '/portal/umbrella-labs/report/d5-001',
   ((current_date - 350) + time '10:00:00') at time zone 'UTC', null,
   ((current_date - 350) + time '09:30:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000021', '70000000-0000-4000-8000-000000000002',
   'dddddddd-0000-4000-8000-000000000004', 'TASK_DUE_SOON', 'WARNING',
   'Overdue: creative refresh calendar',
   'Rebuild creative refresh calendar is overdue.', null, null,
   '/portal/umbrella-labs/project/d3-001/task/d7-001', null, null,
   ((current_date - 1) + time '08:00:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000022', '33333333-3333-4333-8333-333333333333',
   'aaaaaaaa-0000-4000-8000-000000000001', 'REVISION_REQUESTED', 'INFO',
   'Template set v1 revision requested',
   'Dana requested mobile breakpoint variants on the template set.',
   'deliverable', 'a4000000-0000-4000-8000-000000000001',
   '/portal/acme-industrials/deliverable/a4-001',
   ((current_date - 5) + time '09:15:00') at time zone 'UTC', null,
   ((current_date - 5) + time '09:15:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000023', '22222222-2222-4222-8222-222222222222',
   'cccccccc-0000-4000-8000-000000000003', 'INVITATION_SENT', 'INFO',
   'Initech invitations sent',
   'Two Initech Capital invitations were sent.', null, null,
   '/admin/invitations',
   ((current_date - 14) + time '09:30:00') at time zone 'UTC', null,
   ((current_date - 14) + time '09:30:00') at time zone 'UTC'),
  ('e5000000-0000-4000-8000-000000000024', '11111111-1111-4111-8111-111111111111',
   null, 'SYSTEM', 'INFO',
   'Weekly platform digest',
   'Scheduled maintenance window announced for Saturday 04:00 UTC.', null, null,
   '/admin/digest',
   ((current_date - 1) + time '07:00:00') at time zone 'UTC', null,
   ((current_date - 1) + time '07:00:00') at time zone 'UTC')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 16. Invitations — 7 rows, all 4 statuses (§7.4)
-- ---------------------------------------------------------------------------
insert into public.invitations
  (id, email, organization_id, organization_role, platform_role, invited_by,
   token_hash, status, expires_at, accepted_at, accepted_user_id, revoked_at,
   revoked_by, resent_count, last_sent_at, message, created_at)
values
  ('e4000000-0000-4000-8000-000000000001', 'ilana@initech.test',
   'cccccccc-0000-4000-8000-000000000003', 'CLIENT_ADMIN', null,
   '22222222-2222-4222-8222-222222222222',
   encode(extensions.digest('growlith-seed-invite:ilana@initech.test', 'sha256'), 'hex'),
   'PENDING', ((current_date + 7) + time '09:30:00') at time zone 'UTC',
   null, null, null, null, 1,
   ((current_date - 7) + time '09:30:00') at time zone 'UTC',
   'Welcome to Initech Capital.', ((current_date - 14) + time '09:30:00') at time zone 'UTC'),
  ('e4000000-0000-4000-8000-000000000002', 'ivan@initech.test',
   'cccccccc-0000-4000-8000-000000000003', 'CLIENT_MEMBER', null,
   '22222222-2222-4222-8222-222222222222',
   encode(extensions.digest('growlith-seed-invite:ivan@initech.test', 'sha256'), 'hex'),
   'PENDING', ((current_date + 7) + time '09:40:00') at time zone 'UTC',
   null, null, null, null, 0,
   ((current_date - 13) + time '09:40:00') at time zone 'UTC',
   'Reissued after the idris invitation was revoked.',
   ((current_date - 13) + time '09:40:00') at time zone 'UTC'),
  ('e4000000-0000-4000-8000-000000000003', 'idris@initech.test',
   'cccccccc-0000-4000-8000-000000000003', 'CLIENT_MEMBER', null,
   '22222222-2222-4222-8222-222222222222',
   encode(extensions.digest('growlith-seed-invite:idris@initech.test', 'sha256'), 'hex'),
   'REVOKED', ((current_date + 6) + time '09:30:00') at time zone 'UTC',
   null, null,
   ((current_date - 1) + time '09:00:00') at time zone 'UTC',
   '22222222-2222-4222-8222-222222222222', 0,
   ((current_date - 14) + time '09:30:00') at time zone 'UTC',
   'Revoked and reissued to ivan.', ((current_date - 14) + time '09:30:00') at time zone 'UTC'),
  ('e4000000-0000-4000-8000-000000000004', 'gwen@globex.test',
   'bbbbbbbb-0000-4000-8000-000000000002', 'CLIENT_MEMBER', null,
   '66666666-6666-4666-8666-666666666666',
   encode(extensions.digest('growlith-seed-invite:gwen@globex.test', 'sha256'), 'hex'),
   'ACCEPTED', ((current_date + 60) + time '09:30:00') at time zone 'UTC',
   ((current_date - 60) + time '10:00:00') at time zone 'UTC',
   '80000000-0000-4000-8000-000000000004', null, null, 0,
   ((current_date - 60) + time '09:30:00') at time zone 'UTC',
   'Globex workspace invite.', ((current_date - 61) + time '09:30:00') at time zone 'UTC'),
  ('e4000000-0000-4000-8000-000000000005', 'newcomer@acme.test',
   'aaaaaaaa-0000-4000-8000-000000000001', 'CLIENT_MEMBER', null,
   '44444444-4444-4444-8444-444444444444',
   encode(extensions.digest('growlith-seed-invite:newcomer@acme.test', 'sha256'), 'hex'),
   'PENDING', ((current_date + 7) + time '09:30:00') at time zone 'UTC',
   null, null, null, null, 0,
   ((current_date - 200) + time '09:30:00') at time zone 'UTC',
   'Legacy pending invitation (kept).',
   ((current_date - 200) + time '09:30:00') at time zone 'UTC'),
  ('e4000000-0000-4000-8000-000000000006', 'sam@acme.test',
   'aaaaaaaa-0000-4000-8000-000000000001', 'CLIENT_MEMBER', null,
   '44444444-4444-4444-8444-444444444444',
   encode(extensions.digest('growlith-seed-invite:sam@acme.test', 'sha256'), 'hex'),
   'EXPIRED', ((current_date - 30) + time '09:30:00') at time zone 'UTC',
   null, null, null, null, 0,
   ((current_date - 45) + time '09:30:00') at time zone 'UTC',
   'Never accepted before expiry.',
   ((current_date - 45) + time '09:30:00') at time zone 'UTC'),
  ('e4000000-0000-4000-8000-000000000007', 'zoe@growlith.test',
   null, null, 'ADMIN', '11111111-1111-4111-8111-111111111111',
   encode(extensions.digest('growlith-seed-invite:zoe@growlith.test', 'sha256'), 'hex'),
   'ACCEPTED', ((current_date - 400) + time '09:30:00') at time zone 'UTC',
   ((current_date - 420) + time '08:45:00') at time zone 'UTC',
   '70000000-0000-4000-8000-000000000006', null, null, 0,
   ((current_date - 430) + time '09:30:00') at time zone 'UTC',
   'Staff invitation (history).',
   ((current_date - 430) + time '09:30:00') at time zone 'UTC')
on conflict (id) do nothing;
-- ---------------------------------------------------------------------------
-- 17. Files — 14 metadata rows + 14 storage.objects fixtures (§7.5)
-- ---------------------------------------------------------------------------
-- files and storage.objects are written together with the same storage_path;
-- checksums are deterministic digests of the file id, never real bytes.
insert into public.files
  (id, organization_id, storage_bucket, storage_path, file_name, mime_type,
   size_bytes, checksum_sha256, file_kind, client_visible, uploaded_by,
   virus_scan_status, scanned_at, deliverable_id, deliverable_version_id,
   report_id, comment_id, created_at, created_by)
values
  ('a9000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'growlith-private', 'aaaaaaaa-0000-4000-8000-000000000001/seed/brand/acme-logo.png', 'acme-logo.png', 'image/png', 48213,
   encode(extensions.digest('growlith-seed-file:' || 'a9000000-0000-4000-8000-000000000001', 'sha256'), 'hex'), 'BRAND_ASSET', true, '44444444-4444-4444-8444-444444444444', 'CLEAN', ((current_date + -200) + time '10:00:00' + interval '2 minutes') at time zone 'UTC',
   null, null, null, null,
   ((current_date + -200) + time '09:00:00') at time zone 'UTC', '44444444-4444-4444-8444-444444444444'),
  ('a9000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'growlith-private', 'aaaaaaaa-0000-4000-8000-000000000001/seed/contract/acm-2026-r1-msa.pdf', 'acm-2026-r1-msa.pdf', 'application/pdf', 184320,
   encode(extensions.digest('growlith-seed-file:' || 'a9000000-0000-4000-8000-000000000002', 'sha256'), 'hex'), 'CONTRACT', false, '22222222-2222-4222-8222-222222222222', 'CLEAN', ((current_date + -238) + time '10:00:00' + interval '2 minutes') at time zone 'UTC',
   null, null, null, null,
   ((current_date + -238) + time '09:00:00') at time zone 'UTC', '22222222-2222-4222-8222-222222222222'),
  ('a9000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'growlith-private', 'aaaaaaaa-0000-4000-8000-000000000001/seed/deliverable/category-template-v1-preview.pdf', 'category-template-v1-preview.pdf', 'application/pdf', 925471,
   encode(extensions.digest('growlith-seed-file:' || 'a9000000-0000-4000-8000-000000000003', 'sha256'), 'hex'), 'DELIVERABLE_ASSET', true, '33333333-3333-4333-8333-333333333333', 'CLEAN', ((current_date + -2) + time '10:00:00' + interval '2 minutes') at time zone 'UTC',
   null, 'a6000000-0000-4000-8000-000000000001', null, null,
   ((current_date + -2) + time '09:00:00') at time zone 'UTC', '33333333-3333-4333-8333-333333333333'),
  ('a9000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', 'growlith-private', 'aaaaaaaa-0000-4000-8000-000000000001/seed/report/monthly-performance.xlsx', 'monthly-performance.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 44321,
   encode(extensions.digest('growlith-seed-file:' || 'a9000000-0000-4000-8000-000000000004', 'sha256'), 'hex'), 'REPORT_EXPORT', true, '22222222-2222-4222-8222-222222222222', 'CLEAN', ((current_date + -5) + time '10:00:00' + interval '2 minutes') at time zone 'UTC',
   null, null, 'a5000000-0000-4000-8000-000000000001', null,
   ((current_date + -5) + time '09:00:00') at time zone 'UTC', '22222222-2222-4222-8222-222222222222'),
  ('a9000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001', 'growlith-private', 'aaaaaaaa-0000-4000-8000-000000000001/seed/attachment/dana-feedback.docx', 'dana-feedback.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 31209,
   encode(extensions.digest('growlith-seed-file:' || 'a9000000-0000-4000-8000-000000000005', 'sha256'), 'hex'), 'ATTACHMENT', true, '44444444-4444-4444-8444-444444444444', 'CLEAN', ((current_date + -2) + time '10:00:00' + interval '2 minutes') at time zone 'UTC',
   null, null, null, 'a8000000-0000-4000-8000-000000000001',
   ((current_date + -2) + time '09:00:00') at time zone 'UTC', '44444444-4444-4444-8444-444444444444'),
  ('a9000000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001', 'growlith-private', 'aaaaaaaa-0000-4000-8000-000000000001/seed/deliverable/cwv-baseline-raw.csv', 'cwv-baseline-raw.csv', 'text/csv', 84031,
   encode(extensions.digest('growlith-seed-file:' || 'a9000000-0000-4000-8000-000000000006', 'sha256'), 'hex'), 'DELIVERABLE_ASSET', false, '70000000-0000-4000-8000-000000000001', 'PENDING', null,
   'a4000000-0000-4000-8000-000000000008', null, null, null,
   ((current_date + -3) + time '09:00:00') at time zone 'UTC', '70000000-0000-4000-8000-000000000001'),
  ('a9000000-0000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-000000000001', 'growlith-private', 'aaaaaaaa-0000-4000-8000-000000000001/seed/deliverable/nurture-v2-assets.zip', 'nurture-v2-assets.zip', 'application/zip', 2048,
   encode(extensions.digest('growlith-seed-file:' || 'a9000000-0000-4000-8000-000000000007', 'sha256'), 'hex'), 'DELIVERABLE_ASSET', true, '70000000-0000-4000-8000-000000000003', 'CLEAN', ((current_date + -2) + time '10:00:00' + interval '2 minutes') at time zone 'UTC',
   null, 'a6000000-0000-4000-8000-000000000008', null, null,
   ((current_date + -2) + time '09:00:00') at time zone 'UTC', '70000000-0000-4000-8000-000000000003'),
  ('a9000000-0000-4000-8000-000000000008', 'aaaaaaaa-0000-4000-8000-000000000001', 'growlith-private', 'aaaaaaaa-0000-4000-8000-000000000001/seed/avatar/dana-avatar.png', 'dana-avatar.png', 'image/png', 19021,
   encode(extensions.digest('growlith-seed-file:' || 'a9000000-0000-4000-8000-000000000008', 'sha256'), 'hex'), 'AVATAR', true, '44444444-4444-4444-8444-444444444444', 'CLEAN', ((current_date + -240) + time '10:00:00' + interval '2 minutes') at time zone 'UTC',
   null, null, null, null,
   ((current_date + -240) + time '09:00:00') at time zone 'UTC', '44444444-4444-4444-8444-444444444444'),
  ('b9000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', 'growlith-private', 'bbbbbbbb-0000-4000-8000-000000000002/seed/brand/globex-logo.png', 'globex-logo.png', 'image/png', 55107,
   encode(extensions.digest('growlith-seed-file:' || 'b9000000-0000-4000-8000-000000000001', 'sha256'), 'hex'), 'BRAND_ASSET', true, '66666666-6666-4666-8666-666666666666', 'CLEAN', ((current_date + -90) + time '10:00:00' + interval '2 minutes') at time zone 'UTC',
   null, null, null, null,
   ((current_date + -90) + time '09:00:00') at time zone 'UTC', '66666666-6666-4666-8666-666666666666'),
  ('b9000000-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002', 'growlith-private', 'bbbbbbbb-0000-4000-8000-000000000002/seed/deliverable/design-system-foundations.pdf', 'design-system-foundations.pdf', 'application/pdf', 1100002,
   encode(extensions.digest('growlith-seed-file:' || 'b9000000-0000-4000-8000-000000000002', 'sha256'), 'hex'), 'DELIVERABLE_ASSET', false, '70000000-0000-4000-8000-000000000001', 'CLEAN', ((current_date + -12) + time '10:00:00' + interval '2 minutes') at time zone 'UTC',
   'b4000000-0000-4000-8000-000000000001', null, null, null,
   ((current_date + -12) + time '09:00:00') at time zone 'UTC', '70000000-0000-4000-8000-000000000001'),
  ('b9000000-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000002', 'growlith-private', 'bbbbbbbb-0000-4000-8000-000000000002/seed/deliverable/episode-1-master.mp4', 'episode-1-master.mp4', 'video/mp4', 48234496,
   encode(extensions.digest('growlith-seed-file:' || 'b9000000-0000-4000-8000-000000000003', 'sha256'), 'hex'), 'DELIVERABLE_ASSET', true, '70000000-0000-4000-8000-000000000005', 'CLEAN', ((current_date + -1) + time '10:00:00' + interval '2 minutes') at time zone 'UTC',
   'b4000000-0000-4000-8000-000000000004', null, null, null,
   ((current_date + -1) + time '09:00:00') at time zone 'UTC', '70000000-0000-4000-8000-000000000005'),
  ('b9000000-0000-4000-8000-000000000004', 'bbbbbbbb-0000-4000-8000-000000000002', 'growlith-private', 'bbbbbbbb-0000-4000-8000-000000000002/seed/report/glx-kickoff-audit.pdf', 'glx-kickoff-audit.pdf', 'application/pdf', 66422,
   encode(extensions.digest('growlith-seed-file:' || 'b9000000-0000-4000-8000-000000000004', 'sha256'), 'hex'), 'REPORT_EXPORT', true, '22222222-2222-4222-8222-222222222222', 'CLEAN', ((current_date + -60) + time '10:00:00' + interval '2 minutes') at time zone 'UTC',
   null, null, 'b5000000-0000-4000-8000-000000000001', null,
   ((current_date + -60) + time '09:00:00') at time zone 'UTC', '22222222-2222-4222-8222-222222222222'),
  ('d9000000-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004', 'growlith-private', 'dddddddd-0000-4000-8000-000000000004/seed/contract/umb-2025-r1-msa.pdf', 'umb-2025-r1-msa.pdf', 'application/pdf', 143590,
   encode(extensions.digest('growlith-seed-file:' || 'd9000000-0000-4000-8000-000000000001', 'sha256'), 'hex'), 'CONTRACT', false, '22222222-2222-4222-8222-222222222222', 'CLEAN', ((current_date + -400) + time '10:00:00' + interval '2 minutes') at time zone 'UTC',
   null, null, null, null,
   ((current_date + -400) + time '09:00:00') at time zone 'UTC', '22222222-2222-4222-8222-222222222222'),
  ('d9000000-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000004', 'growlith-private', 'dddddddd-0000-4000-8000-000000000004/seed/report/umb-2024-q4.pdf', 'umb-2024-q4.pdf', 'application/pdf', 101117,
   encode(extensions.digest('growlith-seed-file:' || 'd9000000-0000-4000-8000-000000000002', 'sha256'), 'hex'), 'REPORT_EXPORT', true, '22222222-2222-4222-8222-222222222222', 'CLEAN', ((current_date + -350) + time '10:00:00' + interval '2 minutes') at time zone 'UTC',
   null, null, 'd5000000-0000-4000-8000-000000000001', null,
   ((current_date + -350) + time '09:00:00') at time zone 'UTC', '22222222-2222-4222-8222-222222222222')
on conflict do nothing;

insert into storage.objects (bucket_id, name, owner, created_at, updated_at, metadata)
values
  ('growlith-private', 'aaaaaaaa-0000-4000-8000-000000000001/seed/brand/acme-logo.png', '44444444-4444-4444-8444-444444444444',
   ((current_date + -200) + time '09:00:00') at time zone 'UTC',
   ((current_date + -200) + time '09:00:00') at time zone 'UTC',
   jsonb_build_object('mimeType', 'image/png', 'size', 48213, 'seed', true)),
  ('growlith-private', 'aaaaaaaa-0000-4000-8000-000000000001/seed/contract/acm-2026-r1-msa.pdf', '22222222-2222-4222-8222-222222222222',
   ((current_date + -238) + time '09:00:00') at time zone 'UTC',
   ((current_date + -238) + time '09:00:00') at time zone 'UTC',
   jsonb_build_object('mimeType', 'application/pdf', 'size', 184320, 'seed', true)),
  ('growlith-private', 'aaaaaaaa-0000-4000-8000-000000000001/seed/deliverable/category-template-v1-preview.pdf', '33333333-3333-4333-8333-333333333333',
   ((current_date + -2) + time '09:00:00') at time zone 'UTC',
   ((current_date + -2) + time '09:00:00') at time zone 'UTC',
   jsonb_build_object('mimeType', 'application/pdf', 'size', 925471, 'seed', true)),
  ('growlith-private', 'aaaaaaaa-0000-4000-8000-000000000001/seed/report/monthly-performance.xlsx', '22222222-2222-4222-8222-222222222222',
   ((current_date + -5) + time '09:00:00') at time zone 'UTC',
   ((current_date + -5) + time '09:00:00') at time zone 'UTC',
   jsonb_build_object('mimeType', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'size', 44321, 'seed', true)),
  ('growlith-private', 'aaaaaaaa-0000-4000-8000-000000000001/seed/attachment/dana-feedback.docx', '44444444-4444-4444-8444-444444444444',
   ((current_date + -2) + time '09:00:00') at time zone 'UTC',
   ((current_date + -2) + time '09:00:00') at time zone 'UTC',
   jsonb_build_object('mimeType', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'size', 31209, 'seed', true)),
  ('growlith-private', 'aaaaaaaa-0000-4000-8000-000000000001/seed/deliverable/cwv-baseline-raw.csv', '70000000-0000-4000-8000-000000000001',
   ((current_date + -3) + time '09:00:00') at time zone 'UTC',
   ((current_date + -3) + time '09:00:00') at time zone 'UTC',
   jsonb_build_object('mimeType', 'text/csv', 'size', 84031, 'seed', true)),
  ('growlith-private', 'aaaaaaaa-0000-4000-8000-000000000001/seed/deliverable/nurture-v2-assets.zip', '70000000-0000-4000-8000-000000000003',
   ((current_date + -2) + time '09:00:00') at time zone 'UTC',
   ((current_date + -2) + time '09:00:00') at time zone 'UTC',
   jsonb_build_object('mimeType', 'application/zip', 'size', 2048, 'seed', true)),
  ('growlith-private', 'aaaaaaaa-0000-4000-8000-000000000001/seed/avatar/dana-avatar.png', '44444444-4444-4444-8444-444444444444',
   ((current_date + -240) + time '09:00:00') at time zone 'UTC',
   ((current_date + -240) + time '09:00:00') at time zone 'UTC',
   jsonb_build_object('mimeType', 'image/png', 'size', 19021, 'seed', true)),
  ('growlith-private', 'bbbbbbbb-0000-4000-8000-000000000002/seed/brand/globex-logo.png', '66666666-6666-4666-8666-666666666666',
   ((current_date + -90) + time '09:00:00') at time zone 'UTC',
   ((current_date + -90) + time '09:00:00') at time zone 'UTC',
   jsonb_build_object('mimeType', 'image/png', 'size', 55107, 'seed', true)),
  ('growlith-private', 'bbbbbbbb-0000-4000-8000-000000000002/seed/deliverable/design-system-foundations.pdf', '70000000-0000-4000-8000-000000000001',
   ((current_date + -12) + time '09:00:00') at time zone 'UTC',
   ((current_date + -12) + time '09:00:00') at time zone 'UTC',
   jsonb_build_object('mimeType', 'application/pdf', 'size', 1100002, 'seed', true)),
  ('growlith-private', 'bbbbbbbb-0000-4000-8000-000000000002/seed/deliverable/episode-1-master.mp4', '70000000-0000-4000-8000-000000000005',
   ((current_date + -1) + time '09:00:00') at time zone 'UTC',
   ((current_date + -1) + time '09:00:00') at time zone 'UTC',
   jsonb_build_object('mimeType', 'video/mp4', 'size', 48234496, 'seed', true)),
  ('growlith-private', 'bbbbbbbb-0000-4000-8000-000000000002/seed/report/glx-kickoff-audit.pdf', '22222222-2222-4222-8222-222222222222',
   ((current_date + -60) + time '09:00:00') at time zone 'UTC',
   ((current_date + -60) + time '09:00:00') at time zone 'UTC',
   jsonb_build_object('mimeType', 'application/pdf', 'size', 66422, 'seed', true)),
  ('growlith-private', 'dddddddd-0000-4000-8000-000000000004/seed/contract/umb-2025-r1-msa.pdf', '22222222-2222-4222-8222-222222222222',
   ((current_date + -400) + time '09:00:00') at time zone 'UTC',
   ((current_date + -400) + time '09:00:00') at time zone 'UTC',
   jsonb_build_object('mimeType', 'application/pdf', 'size', 143590, 'seed', true)),
  ('growlith-private', 'dddddddd-0000-4000-8000-000000000004/seed/report/umb-2024-q4.pdf', '22222222-2222-4222-8222-222222222222',
   ((current_date + -350) + time '09:00:00') at time zone 'UTC',
   ((current_date + -350) + time '09:00:00') at time zone 'UTC',
   jsonb_build_object('mimeType', 'application/pdf', 'size', 101117, 'seed', true))
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 18. Settings/profile backfill: logos (ACM/GLX) + dana avatar (§7.5)
-- ---------------------------------------------------------------------------
update public.organization_settings set logo_file_id = 'a9000000-0000-4000-8000-000000000001', updated_at = now()
 where organization_id = 'aaaaaaaa-0000-4000-8000-000000000001' and logo_file_id is distinct from 'a9000000-0000-4000-8000-000000000001';
update public.organization_settings set logo_file_id = 'b9000000-0000-4000-8000-000000000001', updated_at = now()
 where organization_id = 'bbbbbbbb-0000-4000-8000-000000000002' and logo_file_id is distinct from 'b9000000-0000-4000-8000-000000000001';
update public.profiles set avatar_path = 'aaaaaaaa-0000-4000-8000-000000000001/seed/avatar/dana-avatar.png'
 where id = '44444444-4444-4444-8444-444444444444' and avatar_path is distinct from 'aaaaaaaa-0000-4000-8000-000000000001/seed/avatar/dana-avatar.png';

-- ---------------------------------------------------------------------------
-- 19. Activity history — curated 72-event trail (§8)
-- ---------------------------------------------------------------------------
-- audit_events is append-only and partitioned monthly. Migration 21 created
-- the current month + 12 ahead only, so every back-dated month is created
-- first via the existing idempotent helper. Rows are inserted with explicit
-- occurred_at/actor/request_id and an existence guard (§8.3), so a re-run is
-- a no-op and the append-only trigger stays untouched.
do $$
declare
  i int;
begin
  for i in 0..18 loop
    perform growlith.ensure_audit_partition(
      (date_trunc('month', current_date) - make_interval(months => i))::date
    );
  end loop;
end
$$;

insert into public.audit_events
  (occurred_at, organization_id, actor_user_id, actor_role, actor_ip, request_id,
   entity_kind, entity_id, action, severity, changed_fields, before, after, reason)
select v.occurred_at, v.organization_id::uuid, v.actor_user_id::uuid, v.actor_role, v.actor_ip::inet,
       v.request_id, v.entity_kind::public.entity_kind, v.entity_id::uuid, v.action::public.audit_action,
       v.severity::public.audit_severity, v.changed_fields, v.before, v.after, v.reason
from (values
  (((current_date - 240) + time '09:05') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGER', '10.0.0.180', 'seed-0001', 'engagement', 'a1000000-0000-4000-8000-000000000001', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Engagement created'),
  (((current_date - 240) + time '09:07') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGER', '10.0.0.180', 'seed-0002', 'engagement', 'a1000000-0000-4000-8000-000000000001', 'UPDATE', 'INFO', array['contract_value','signed_at'], '{}'::jsonb, '{}'::jsonb, 'Contract value confirmed'),
  (((current_date - 238) + time '10:12') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGER', '10.0.0.166', 'seed-0003', 'engagement', 'a1000000-0000-4000-8000-000000000001', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'DRAFT to ACTIVE after signature'),
  (((current_date - 235) + time '09:10') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.145', 'seed-0004', 'service', 'a2000000-0000-4000-8000-000000000001', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Service scoped'),
  (((current_date - 220) + time '11:20') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.40', 'seed-0005', 'service', 'a2000000-0000-4000-8000-000000000001', 'UPDATE', 'INFO', array['scope_summary'], '{}'::jsonb, '{}'::jsonb, 'Scope clarified'),
  (((current_date - 200) + time '09:15') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.150', 'seed-0006', 'project', 'a3000000-0000-4000-8000-000000000001', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Project kickoff'),
  (((current_date - 90) + time '09:30') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.130', 'seed-0007', 'project', 'a3000000-0000-4000-8000-000000000001', 'UPDATE', 'INFO', array['health','priority'], '{}'::jsonb, '{}'::jsonb, 'Health reviewed'),
  (((current_date - 60) + time '10:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.170', 'seed-0008', 'deliverable', 'a4000000-0000-4000-8000-000000000001', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Deliverable created'),
  (((current_date - 30) + time '10:05') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.210', 'seed-0009', 'deliverable', 'a4000000-0000-4000-8000-000000000001', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'IN_PROGRESS'),
  (((current_date - 2) + time '16:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.14', 'seed-0010', 'deliverable', 'a4000000-0000-4000-8000-000000000001', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'SUBMITTED to CLIENT_REVIEW'),
  (((current_date - 16) + time '09:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.112', 'seed-0011', 'deliverable', 'a4000000-0000-4000-8000-000000000003', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'status → CREATE'),
  (((current_date - 15) + time '09:10') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.105', 'seed-0012', 'deliverable', 'a4000000-0000-4000-8000-000000000003', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'status → IN_PROGRESS'),
  (((current_date - 9) + time '09:20') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.63', 'seed-0013', 'deliverable', 'a4000000-0000-4000-8000-000000000003', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'status → INTERNAL_REVIEW'),
  (((current_date - 6) + time '14:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.42', 'seed-0014', 'deliverable', 'a4000000-0000-4000-8000-000000000003', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'status → SUBMITTED'),
  (((current_date - 6) + time '14:05') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.42', 'seed-0015', 'deliverable', 'a4000000-0000-4000-8000-000000000003', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'status → CLIENT_REVIEW'),
  (((current_date - 5) + time '09:30') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.35', 'seed-0016', 'deliverable', 'a4000000-0000-4000-8000-000000000003', 'STATUS_CHANGE', 'WARNING', array['status'], '{}'::jsonb, '{}'::jsonb, 'status → REVISION_REQUESTED'),
  (((current_date - 5) + time '09:35') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.35', 'seed-0017', 'deliverable', 'a4000000-0000-4000-8000-000000000003', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'status → IN_PROGRESS'),
  (((current_date - 4) + time '10:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.28', 'seed-0018', 'deliverable', 'a4000000-0000-4000-8000-000000000003', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'status → INTERNAL_REVIEW'),
  (((current_date - 3) + time '12:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.21', 'seed-0019', 'deliverable', 'a4000000-0000-4000-8000-000000000003', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'status → SUBMITTED'),
  (((current_date - 3) + time '12:05') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.21', 'seed-0020', 'deliverable', 'a4000000-0000-4000-8000-000000000003', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'status → CLIENT_REVIEW'),
  (((current_date - 3) + time '14:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.21', 'seed-0021', 'deliverable', 'a4000000-0000-4000-8000-000000000003', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'status → APPROVED'),
  (((current_date - 418) + time '09:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.1.176', 'seed-0022', 'deliverable', 'a4000000-0000-4000-8000-000000000011', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Audit deliverable'),
  (((current_date - 405) + time '13:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.1.85', 'seed-0023', 'deliverable', 'a4000000-0000-4000-8000-000000000011', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'submitted'),
  (((current_date - 404) + time '10:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.1.78', 'seed-0024', 'deliverable', 'a4000000-0000-4000-8000-000000000011', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'approved'),
  (((current_date - 400) + time '11:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.1.50', 'seed-0025', 'deliverable', 'a4000000-0000-4000-8000-000000000011', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'published'),
  (((current_date - 12) + time '13:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.84', 'seed-0026', 'deliverable', 'a4000000-0000-4000-8000-000000000004', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'submitted playbook'),
  (((current_date - 10) + time '09:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.0.70', 'seed-0027', 'deliverable', 'a4000000-0000-4000-8000-000000000004', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'published'),
  (((current_date - 3) + time '14:15') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'CLIENT_ADMIN', '10.0.0.21', 'seed-0028', 'deliverable', 'a4000000-0000-4000-8000-000000000003', 'UPDATE', 'INFO', array['approved_by'], '{}'::jsonb, '{}'::jsonb, 'Approval recorded'),
  (((current_date - 12) + time '09:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGER', '10.0.0.84', 'seed-0029', 'report', 'a5000000-0000-4000-8000-000000000001', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Report drafted'),
  (((current_date - 5) + time '09:30') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGER', '10.0.0.35', 'seed-0030', 'report', 'a5000000-0000-4000-8000-000000000001', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'published'),
  (((current_date - 2) + time '10:30') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'CLIENT_ADMIN', '10.0.0.14', 'seed-0031', 'comment', 'a8000000-0000-4000-8000-000000000001', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Client comment'),
  (((current_date - 2) + time '11:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'CLIENT_ADMIN', '10.0.0.14', 'seed-0032', 'attachment', 'a9000000-0000-4000-8000-000000000003', 'FILE_DOWNLOAD', 'NOTICE', null, '{}'::jsonb, '{}'::jsonb, 'Deliverable preview downloaded'),
  (((current_date - 5) + time '09:35') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'CLIENT_ADMIN', '10.0.0.35', 'seed-0033', 'report', 'a5000000-0000-4000-8000-000000000001', 'EXPORT', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Report exported by client'),
  (((current_date - 90) + time '09:00') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGER', '10.0.0.130', 'seed-0034', 'engagement', 'b1000000-0000-4000-8000-000000000001', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Engagement kickoff'),
  (((current_date - 90) + time '09:05') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', 'WEB_LEAD', '10.0.0.130', 'seed-0035', 'service', 'b2000000-0000-4000-8000-000000000001', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Build service'),
  (((current_date - 88) + time '10:00') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', 'WEB_LEAD', '10.0.0.116', 'seed-0036', 'project', 'b3000000-0000-4000-8000-000000000001', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Rebuild project'),
  (((current_date - 45) + time '09:30') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', 'WEB_LEAD', '10.0.0.65', 'seed-0037', 'project', 'b3000000-0000-4000-8000-000000000001', 'UPDATE', 'INFO', array['health'], '{}'::jsonb, '{}'::jsonb, 'Status review'),
  (((current_date - 30) + time '10:00') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', 'WEB_LEAD', '10.0.0.210', 'seed-0038', 'deliverable', 'b4000000-0000-4000-8000-000000000001', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Design system deliverable'),
  (((current_date - 15) + time '09:00') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', 'WEB_LEAD', '10.0.0.105', 'seed-0039', 'deliverable', 'b4000000-0000-4000-8000-000000000001', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'IN_PROGRESS'),
  (((current_date - 45) + time '11:00') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000005', 'VIDEO_LEAD', '10.0.0.65', 'seed-0040', 'service', 'b2000000-0000-4000-8000-000000000003', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Video service'),
  (((current_date - 40) + time '11:10') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000005', 'VIDEO_LEAD', '10.0.0.30', 'seed-0041', 'project', 'b3000000-0000-4000-8000-000000000004', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Video project'),
  (((current_date - 12) + time '09:00') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000005', 'VIDEO_LEAD', '10.0.0.84', 'seed-0042', 'deliverable', 'b4000000-0000-4000-8000-000000000005', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Title pack'),
  (((current_date - 5) + time '15:00') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000005', 'VIDEO_LEAD', '10.0.0.35', 'seed-0043', 'deliverable', 'b4000000-0000-4000-8000-000000000005', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'SUBMITTED'),
  (((current_date - 2) + time '11:00') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000005', 'VIDEO_LEAD', '10.0.0.14', 'seed-0044', 'deliverable', 'b4000000-0000-4000-8000-000000000005', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'APPROVED'),
  (((current_date - 12) + time '09:15') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000005', 'VIDEO_LEAD', '10.0.0.84', 'seed-0045', 'deliverable', 'b4000000-0000-4000-8000-000000000004', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Episode 1 deliverable'),
  (((current_date - 1) + time '15:00') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000005', 'VIDEO_LEAD', '10.0.0.7', 'seed-0046', 'deliverable', 'b4000000-0000-4000-8000-000000000004', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'SUBMITTED/CLIENT_REVIEW'),
  (((current_date - 1) + time '16:20') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '66666666-6666-4666-8666-666666666666', 'CLIENT_MEMBER', '10.0.0.7', 'seed-0047', 'comment', 'b8000000-0000-4000-8000-000000000001', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Client feedback'),
  (((current_date - 80) + time '09:00') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGER', '10.0.0.60', 'seed-0048', 'report', 'b5000000-0000-4000-8000-000000000001', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Baseline report drafted'),
  (((current_date - 60) + time '09:30') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGER', '10.0.0.170', 'seed-0049', 'report', 'b5000000-0000-4000-8000-000000000001', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'PUBLISHED'),
  (((current_date - 400) + time '09:00') at time zone 'UTC', 'dddddddd-0000-4000-8000-000000000004', '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGER', '10.0.1.50', 'seed-0050', 'engagement', 'd1000000-0000-4000-8000-000000000001', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Retainer created'),
  (((current_date - 395) + time '10:00') at time zone 'UTC', 'dddddddd-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000002', 'PAID_LEAD', '10.0.1.15', 'seed-0051', 'service', 'd2000000-0000-4000-8000-000000000001', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Paid service'),
  (((current_date - 380) + time '10:10') at time zone 'UTC', 'dddddddd-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000002', 'PAID_LEAD', '10.0.1.160', 'seed-0052', 'project', 'd3000000-0000-4000-8000-000000000001', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Paid project'),
  (((current_date - 520) + time '09:00') at time zone 'UTC', 'dddddddd-0000-4000-8000-000000000004', '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGER', '10.0.2.140', 'seed-0053', 'engagement', 'd1000000-0000-4000-8000-000000000002', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, '2024 sprint created'),
  (((current_date - 500) + time '09:05') at time zone 'UTC', 'dddddddd-0000-4000-8000-000000000004', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.2.0', 'seed-0054', 'project', 'd3000000-0000-4000-8000-000000000002', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'SEO project'),
  (((current_date - 395) + time '09:00') at time zone 'UTC', 'dddddddd-0000-4000-8000-000000000004', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.1.15', 'seed-0055', 'deliverable', 'd4000000-0000-4000-8000-000000000002', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'SEO audit deliverable'),
  (((current_date - 382) + time '13:00') at time zone 'UTC', 'dddddddd-0000-4000-8000-000000000004', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.1.174', 'seed-0056', 'deliverable', 'd4000000-0000-4000-8000-000000000002', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'submitted'),
  (((current_date - 380) + time '10:00') at time zone 'UTC', 'dddddddd-0000-4000-8000-000000000004', '33333333-3333-4333-8333-333333333333', 'SEO_LEAD', '10.0.1.160', 'seed-0057', 'deliverable', 'd4000000-0000-4000-8000-000000000002', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'approved/published'),
  (((current_date - 60) + time '17:00') at time zone 'UTC', 'dddddddd-0000-4000-8000-000000000004', '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGER', '10.0.0.170', 'seed-0058', 'engagement', 'd1000000-0000-4000-8000-000000000001', 'STATUS_CHANGE', 'WARNING', array['status'], '{}'::jsonb, '{}'::jsonb, 'ACTIVE to PAUSED — account suspended'),
  (((current_date - 360) + time '12:00') at time zone 'UTC', 'dddddddd-0000-4000-8000-000000000004', '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGER', '10.0.1.20', 'seed-0059', 'engagement', 'd1000000-0000-4000-8000-000000000002', 'STATUS_CHANGE', 'INFO', array['status'], '{}'::jsonb, '{}'::jsonb, 'COMPLETED'),
  (((current_date - 20) + time '09:00') at time zone 'UTC', 'cccccccc-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGER', '10.0.0.140', 'seed-0060', 'organization', 'cccccccc-0000-4000-8000-000000000003', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Organization created'),
  (((current_date - 14) + time '09:30') at time zone 'UTC', 'cccccccc-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGER', '10.0.0.98', 'seed-0061', 'engagement', 'c1000000-0000-4000-8000-000000000001', 'CREATE', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Engagement drafted'),
  (((current_date - 14) + time '09:31') at time zone 'UTC', 'cccccccc-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGER', '10.0.0.98', 'seed-0062', 'organization', 'cccccccc-0000-4000-8000-000000000003', 'INVITE_SENT', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Client invites sent'),
  (((current_date - 14) + time '09:35') at time zone 'UTC', 'cccccccc-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGER', '10.0.0.98', 'seed-0063', 'organization', 'cccccccc-0000-4000-8000-000000000003', 'LOGIN', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Admin login to onboard'),
  (((current_date - 3) + time '08:00') at time zone 'UTC', null, '11111111-1111-4111-8111-111111111111', 'PLATFORM_ADMIN', '10.0.0.21', 'seed-0064', 'organization', 'aaaaaaaa-0000-4000-8000-000000000001', 'LOGIN', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Platform login'),
  (((current_date - 20) + time '09:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'CLIENT_ADMIN', '10.0.0.140', 'seed-0065', 'organization', 'aaaaaaaa-0000-4000-8000-000000000001', 'LOGIN_FAILED', 'WARNING', null, '{}'::jsonb, '{}'::jsonb, 'Failed login (wrong password)'),
  (((current_date - 60) + time '10:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'PLATFORM_ADMIN', '10.0.0.170', 'seed-0066', 'organization', 'aaaaaaaa-0000-4000-8000-000000000001', 'ROLE_GRANT', 'NOTICE', array['platform_role'], '{}'::jsonb, '{}'::jsonb, 'ADMIN granted'),
  (((current_date - 45) + time '08:30') at time zone 'UTC', null, '70000000-0000-4000-8000-000000000006', 'PLATFORM_ADMIN', '10.0.0.65', 'seed-0067', 'organization', 'bbbbbbbb-0000-4000-8000-000000000002', 'LOGIN', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Platform login before revocation'),
  (((current_date - 30) + time '11:00') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'PLATFORM_ADMIN', '10.0.0.210', 'seed-0068', 'organization', 'bbbbbbbb-0000-4000-8000-000000000002', 'ROLE_REVOKE', 'CRITICAL', array['platform_role'], '{}'::jsonb, '{}'::jsonb, 'zoe ADMIN revoked'),
  (((current_date - 1) + time '08:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'PLATFORM_ADMIN', '10.0.0.7', 'seed-0069', 'organization', 'aaaaaaaa-0000-4000-8000-000000000001', 'LOGIN', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'Platform login'),
  (((current_date - 10) + time '14:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '66666666-6666-4666-8666-666666666666', 'CLIENT_MEMBER', '10.0.0.70', 'seed-0070', 'deliverable', 'a4000000-0000-4000-8000-000000000002', 'PERMISSION_DENIED', 'WARNING', null, '{}'::jsonb, '{}'::jsonb, 'Cross-tenant probe blocked by RLS'),
  (((current_date - 60) + time '10:00') at time zone 'UTC', 'bbbbbbbb-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000004', 'CLIENT_MEMBER', '10.0.0.170', 'seed-0071', 'organization', 'bbbbbbbb-0000-4000-8000-000000000002', 'INVITE_ACCEPTED', 'INFO', null, '{}'::jsonb, '{}'::jsonb, 'gwen accepted invite'),
  (((current_date - 90) + time '09:00') at time zone 'UTC', 'aaaaaaaa-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000006', 'PLATFORM_ADMIN', '10.0.0.130', 'seed-0072', 'organization', 'aaaaaaaa-0000-4000-8000-000000000001', 'SOFT_DELETE', 'NOTICE', array['deleted_at'], '{}'::jsonb, '{}'::jsonb, 'zoe team membership soft-deleted')
) as v(occurred_at, organization_id, actor_user_id, actor_role, actor_ip,
     request_id, entity_kind, entity_id, action, severity, changed_fields, before, after, reason)
where not exists (
  select 1 from public.audit_events a
  where a.organization_id is not distinct from v.organization_id::uuid
    and a.entity_kind = v.entity_kind::public.entity_kind
    and a.entity_id = v.entity_id::uuid
    and a.action = v.action::public.audit_action
    and a.occurred_at = v.occurred_at
);

-- ---------------------------------------------------------------------------
-- 20. Re-enable the audit projection BEFORE commit (design §8.1)
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select * from (values
    ('organizations',            'organization'),
    ('engagements',              'engagement'),
    ('services',                 'service'),
    ('projects',                 'project'),
    ('deliverables',             'deliverable'),
    ('tasks',                    'task'),
    ('comments',                 'comment'),
    ('files',                    'attachment'),
    ('reports',                  'organization'),
    ('organization_memberships', 'organization'),
    ('platform_role_grants',     'organization'),
    ('project_memberships',      'project')
  ) as t(table_name, entity_kind)
  loop
    execute format('drop trigger if exists %I on public.%I',
                   r.table_name || '_audit', r.table_name);
    execute format(
      'create trigger %I after insert or update or delete on public.%I
         for each row execute function growlith.record_audit_event(%L)',
      r.table_name || '_audit', r.table_name, r.entity_kind
    );
  end loop;
end
$$;

commit;
