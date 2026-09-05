-- Local development seed — SYNTHETIC DATA ONLY.
--
-- Never production data, never a production export, never a real client name or
-- email (Rule 13). Every organization here is fictional and every address is on
-- a `.test` domain, which is reserved by RFC 2606 and cannot be routed.
--
-- Two organizations exist deliberately: tenant isolation cannot be demonstrated
-- with one. Every pgTAP assertion in Phase 4 is of the form "actor from Acme
-- cannot see Globex", and that sentence needs both halves.
--
-- Reference data (the seven teams, the seven service lines, the status
-- transition table) is NOT here — it ships inside the migrations, because the
-- schema depends on it. This file holds only what a developer needs to see a
-- populated screen.
--
-- Idempotent: safe to run repeatedly against a local database.

begin;

-- ---------------------------------------------------------------------------
-- Identities
-- ---------------------------------------------------------------------------
-- Inserting into auth.users fires growlith.handle_new_auth_user(), which
-- creates the matching profile. That is deliberate: the seed exercises the same
-- path a real sign-up takes, so a broken trigger fails here rather than in
-- production.
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
values
  ('11111111-1111-4111-8111-111111111111', 'super@growlith.test',
   '{"full_name":"Ada Superuser","user_type":"INTERNAL"}'::jsonb, now()),
  ('22222222-2222-4222-8222-222222222222', 'admin@growlith.test',
   '{"full_name":"Ben Operator","user_type":"INTERNAL"}'::jsonb, now()),
  ('33333333-3333-4333-8333-333333333333', 'seo@growlith.test',
   '{"full_name":"Cara Search","user_type":"INTERNAL"}'::jsonb, now()),
  ('44444444-4444-4444-8444-444444444444', 'owner@acme.test',
   '{"full_name":"Dana Acme","user_type":"CLIENT"}'::jsonb, now()),
  ('55555555-5555-4555-8555-555555555555', 'analyst@acme.test',
   '{"full_name":"Eli Acme","user_type":"CLIENT"}'::jsonb, now()),
  ('66666666-6666-4666-8666-666666666666', 'owner@globex.test',
   '{"full_name":"Fay Globex","user_type":"CLIENT"}'::jsonb, now())
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Platform roles
-- ---------------------------------------------------------------------------
insert into public.platform_role_grants (user_id, role, granted_by, reason)
values
  ('11111111-1111-4111-8111-111111111111', 'SUPER_ADMIN',
   '11111111-1111-4111-8111-111111111111', 'Founding platform owner (seed).'),
  ('22222222-2222-4222-8222-222222222222', 'ADMIN',
   '11111111-1111-4111-8111-111111111111', 'Delivery operations (seed).'),
  -- RISK R-1 made visible: Cara is an SEO specialist who needs no cross-tenant
  -- access, yet ADMIN is the only internal role that lets her work. This row is
  -- the least-privilege violation the register describes, sitting in the seed
  -- where it can be seen rather than argued about.
  ('33333333-3333-4333-8333-333333333333', 'ADMIN',
   '11111111-1111-4111-8111-111111111111',
   'SEO specialist. Requires ADMIN only because no TEAM_MEMBER role exists — risk R-1.')
on conflict do nothing;

insert into public.staff_team_memberships (user_id, team, is_lead, allocation_pct)
values
  ('22222222-2222-4222-8222-222222222222', 'ACCOUNT_MANAGEMENT', true, 100),
  ('33333333-3333-4333-8333-333333333333', 'SEO', false, 80),
  ('33333333-3333-4333-8333-333333333333', 'AI_AUTOMATION', false, 20)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Two tenants
-- ---------------------------------------------------------------------------
insert into public.organizations
  (id, slug, legal_name, display_name, region, industry, status, primary_currency,
   account_manager_user_id, onboarded_at)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'acme-industrials',
   'Acme Industrials Inc.', 'Acme Industrials', 'NYC', 'Manufacturing',
   'ACTIVE', 'USD', '22222222-2222-4222-8222-222222222222', now() - interval '8 months'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'globex-health',
   'Globex Health Ltd.', 'Globex Health', 'LDN', 'Healthcare',
   'ACTIVE', 'GBP', '22222222-2222-4222-8222-222222222222', now() - interval '3 months')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Memberships — note the deliberate NON-overlap
-- ---------------------------------------------------------------------------
-- Nobody belongs to both organizations. Every isolation test depends on that:
-- if Dana could see Globex legitimately, a leak would be indistinguishable from
-- correct behaviour.
insert into public.organization_memberships
  (organization_id, user_id, role, status, is_primary_contact, job_title, joined_at)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444',
   'CLIENT_ADMIN', 'ACTIVE', true, 'VP Growth', now() - interval '8 months'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '55555555-5555-4555-8555-555555555555',
   'CLIENT_MEMBER', 'ACTIVE', false, 'Marketing Analyst', now() - interval '6 months'),
  ('bbbbbbbb-0000-4000-8000-000000000002', '66666666-6666-4666-8666-666666666666',
   'CLIENT_ADMIN', 'ACTIVE', true, 'Head of Digital', now() - interval '3 months')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Acme: engagement -> service -> project -> deliverable -> task
-- ---------------------------------------------------------------------------
insert into public.engagements
  (id, organization_id, code, name, engagement_type, status, currency,
   contract_value, monthly_retainer, start_date, renewal_date,
   account_manager_user_id, signed_at, notes_internal)
values
  ('a1000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'ACM-2026-R1', 'Acme growth retainer 2026', 'RETAINER', 'ACTIVE', 'USD',
   240000.00, 20000.00, current_date - 240, current_date + 120,
   '22222222-2222-4222-8222-222222222222', now() - interval '8 months',
   'Margin thin in Q1; revisit scope at renewal.')
on conflict (id) do nothing;

insert into public.services
  (id, organization_id, engagement_id, service_line, delivering_team, name,
   scope_summary, status, currency, fee, fee_model, start_date, lead_user_id)
values
  ('a2000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'PROGRAMMATIC_SEO', 'SEO',
   'Programmatic SEO — category pages',
   'Template system for 4,000 category pages plus indexation monitoring.',
   'ACTIVE', 'USD', 12000.00, 'RETAINER', current_date - 240,
   '33333333-3333-4333-8333-333333333333'),
  ('a2000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'WEB_CORE', 'WEB_DEVELOPMENT',
   'Sub-second web core', 'Core Web Vitals programme targeting P75 LCP < 1.8s.',
   'ACTIVE', 'USD', 8000.00, 'RETAINER', current_date - 180, null)
on conflict (id) do nothing;

insert into public.projects
  (id, organization_id, service_id, code, name, description, status, priority,
   health, owning_team, lead_user_id, start_date, target_date)
values
  ('a3000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000001', 'ACM-SEO-Q1',
   'Category template rollout', 'Ship and index the first 1,200 category pages.',
   'IN_PROGRESS', 'HIGH', 'ON_TRACK', 'SEO',
   '33333333-3333-4333-8333-333333333333', current_date - 60, current_date + 30)
on conflict (id) do nothing;

insert into public.project_memberships
  (organization_id, project_id, user_id, project_role, allocation_pct)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001',
   '33333333-3333-4333-8333-333333333333', 'LEAD', 60),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001',
   '22222222-2222-4222-8222-222222222222', 'REVIEWER', 10)
on conflict do nothing;

-- Two deliverables in different states, so the portal has something to show and
-- the review workflow has something to exercise.
insert into public.deliverables
  (id, organization_id, project_id, title, description, deliverable_type,
   status, client_visible, due_date, owner_user_id, submitted_at)
values
  ('a4000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', 'Category template set v1',
   'Twelve page templates covering the top category tree.',
   'PAGE_TEMPLATE_SET', 'CLIENT_REVIEW', true, current_date + 7,
   '33333333-3333-4333-8333-333333333333', now() - interval '2 days'),
  ('a4000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', 'Indexation audit',
   'Coverage and crawl-budget analysis. Internal until reviewed.',
   'AUDIT', 'IN_PROGRESS', false, current_date + 21,
   '33333333-3333-4333-8333-333333333333', null)
on conflict (id) do nothing;

insert into public.deliverable_versions
  (organization_id, deliverable_id, version_number, summary, status, submitted_by, submitted_at)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001',
   1, 'First submission for client review.', 'SUBMITTED',
   '33333333-3333-4333-8333-333333333333', now() - interval '2 days')
on conflict do nothing;

-- One task attached to a deliverable, one not — the ADR-0005 edge, visible in
-- the seed so anyone browsing the data sees both shapes.
insert into public.tasks
  (organization_id, project_id, deliverable_id, title, status, priority,
   assignee_user_id, assigned_team, due_date, estimated_hours, position)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000001', 'Build the PDP template variant',
   'IN_PROGRESS', 'HIGH', '33333333-3333-4333-8333-333333333333', 'SEO',
   current_date + 3, 12.00, 1),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001',
   null, 'Investigate crawl budget anomaly',
   'TODO', 'MEDIUM', '33333333-3333-4333-8333-333333333333', 'SEO',
   current_date + 10, 4.00, 2)
on conflict do nothing;

insert into public.comments
  (organization_id, deliverable_id, author_user_id, body, is_internal)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001',
   '44444444-4444-4444-8444-444444444444',
   'Looks strong. Can we see the mobile breakpoint before we approve?', false),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001',
   '33333333-3333-4333-8333-333333333333',
   'Mobile variant is behind a flag; margin is tight on this one.', true)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Acme: metrics and a published report
-- ---------------------------------------------------------------------------
insert into public.metrics
  (organization_id, service_id, service_line, metric_key, metric_date, value, unit, currency, source)
select
  'aaaaaaaa-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001',
  'PROGRAMMATIC_SEO',
  'PAGES_INDEXED',
  d::date,
  800 + (extract(day from d)::int * 37),
  'COUNT',
  null,
  'SEARCH_CONSOLE'
from generate_series(current_date - 29, current_date, interval '1 day') as d
on conflict do nothing;

insert into public.metrics
  (organization_id, metric_key, metric_date, value, unit, currency, source)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'BLENDED_ROAS', current_date, 4.2, 'RATIO', null, 'INTERNAL'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'P75_LCP_MS', current_date, 1740, 'MILLISECONDS', null, 'CRUX'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'PIPELINE_ENGINEERED', current_date, 1850000.00, 'CURRENCY', 'USD', 'CRM')
on conflict do nothing;

insert into public.reports
  (id, organization_id, engagement_id, title, report_type, period_start, period_end,
   status, currency, summary_md, client_visible, published_at, published_by)
values
  ('a5000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'Monthly performance — last month',
   'PERFORMANCE', date_trunc('month', current_date - interval '1 month')::date,
   (date_trunc('month', current_date) - interval '1 day')::date,
   'PUBLISHED', 'USD',
   E'Indexation continued to compound and Core Web Vitals held below target.\n\nPaid efficiency improved as the CAPI match rate stabilised.',
   true, now() - interval '5 days', '22222222-2222-4222-8222-222222222222')
on conflict (id) do nothing;

insert into public.report_metrics
  (organization_id, report_id, metric_key, value, unit, currency,
   comparison_value, comparison_label, sort_order)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001',
   'PIPELINE_ENGINEERED', 1850000.00, 'CURRENCY', 'USD', 1420000.00, 'Previous month', 1),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001',
   'BLENDED_ROAS', 4.2, 'RATIO', null, 3.6, 'Previous month', 2),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001',
   'PAGES_INDEXED', 1892, 'COUNT', null, 1204, 'Previous month', 3)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Globex: the second tenant
-- ---------------------------------------------------------------------------
-- Smaller, but complete enough that "can an Acme user reach any of this?" is a
-- question with rows behind it.
insert into public.engagements
  (id, organization_id, code, name, engagement_type, status, currency,
   contract_value, start_date, signed_at, account_manager_user_id)
values
  ('b1000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
   'GLX-2026-P1', 'Globex site rebuild', 'PROJECT', 'ACTIVE', 'GBP',
   85000.00, current_date - 90, now() - interval '3 months',
   '22222222-2222-4222-8222-222222222222')
on conflict (id) do nothing;

insert into public.services
  (id, organization_id, engagement_id, service_line, delivering_team, name,
   status, currency, fee, fee_model, start_date)
values
  ('b2000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b1000000-0000-4000-8000-000000000001', 'WEB_CORE', 'WEB_DEVELOPMENT',
   'Platform rebuild', 'ACTIVE', 'GBP', 85000.00, 'FIXED', current_date - 90)
on conflict (id) do nothing;

insert into public.projects
  (id, organization_id, service_id, code, name, status, priority, owning_team, start_date, target_date)
values
  ('b3000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b2000000-0000-4000-8000-000000000001', 'GLX-WEB-1', 'Rebuild phase one',
   'IN_PROGRESS', 'URGENT', 'WEB_DEVELOPMENT', current_date - 90, current_date + 60)
on conflict (id) do nothing;

insert into public.deliverables
  (id, organization_id, project_id, title, deliverable_type, status, client_visible, due_date)
values
  ('b4000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
   'b3000000-0000-4000-8000-000000000001', 'Design system foundations',
   'DESIGN', 'IN_PROGRESS', false, current_date + 14)
on conflict (id) do nothing;

insert into public.metrics
  (organization_id, metric_key, metric_date, value, unit, currency, source)
values
  ('bbbbbbbb-0000-4000-8000-000000000002', 'P75_LCP_MS', current_date, 2980, 'MILLISECONDS', null, 'CRUX'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'REVENUE', current_date, 48000.00, 'CURRENCY', 'GBP', 'CRM')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- A pending invitation
-- ---------------------------------------------------------------------------
-- token_hash is the SHA-256 of a known development token so the acceptance flow
-- can be driven locally. Never do this outside a local database.
insert into public.invitations
  (email, organization_id, organization_role, invited_by, token_hash, expires_at, message)
values
  ('newcomer@acme.test', 'aaaaaaaa-0000-4000-8000-000000000001', 'CLIENT_MEMBER',
   '44444444-4444-4444-8444-444444444444',
   encode(extensions.digest('dev-invitation-token', 'sha256'), 'hex'),
   now() + interval '7 days',
   'Joining the growth team.')
on conflict do nothing;

commit;
