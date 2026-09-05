-- Migration 02 — enum types
--
-- Every closed vocabulary in the system, created before any table that uses
-- one. Native enums (not lookup tables) are used wherever the value set is
-- closed and the values carry no attributes: they are type-safe, index-friendly
-- and additive (`alter type ... add value`).
--
-- Where a vocabulary DOES carry attributes — teams have leads, service lines
-- have labels and a default team — migration 03 adds a lookup table KEYED BY
-- the enum. That gives both compile-time safety and editable display data,
-- with one source of truth rather than two.
--
-- CONTRACT: `entity_kind` must stay byte-identical to `ENTITY_KINDS` in
-- `src/lib/domain/entities.ts`, and the role/team/service-line enums to their
-- counterparts in `src/lib/domain/`. A unit test reads this file and asserts
-- that equality, so drift fails CI rather than surfacing in production.

-- Idempotent guard: `create type` has no `if not exists`, so each type is
-- wrapped. Re-running the migration locally is harmless.
do $$
begin

-- ---------------------------------------------------------------------------
-- Identity, roles and account state
-- ---------------------------------------------------------------------------

-- Internal Growlith staff. Cross-tenant by nature.
-- RISK R-1 (open, owner decision required): this vocabulary cannot express a
-- non-privileged internal actor, so every specialist must hold cross-tenant
-- ADMIN. The recommended fifth value, TEAM_MEMBER, is deliberately NOT added
-- here — `src/lib/domain/roles.ts` and a tripwire test in
-- `tests/unit/domain.spec.ts` keep the gap visible until Phase 4 decides.
-- Adding it later is `alter type platform_role add value 'TEAM_MEMBER'` plus
-- policy predicates; the schema is already shaped for it via
-- `staff_team_memberships` and `services.delivering_team`.
if to_regtype('public.platform_role') is null then
  create type public.platform_role as enum ('SUPER_ADMIN', 'ADMIN');
end if;

-- Client-side users. Always scoped to exactly one organization.
if to_regtype('public.organization_role') is null then
  create type public.organization_role as enum ('CLIENT_ADMIN', 'CLIENT_MEMBER');
end if;

-- Lifecycle of a login identity, platform-wide.
if to_regtype('public.account_status') is null then
  create type public.account_status as enum
    ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');
end if;

-- Lifecycle of one person's relationship with one organization. Same four
-- values as account_status but a genuinely different axis: a globally ACTIVE
-- user may be SUSPENDED in one organization and ACTIVE in another. Sharing one
-- type would invite predicates that conflate the two.
if to_regtype('public.membership_status') is null then
  create type public.membership_status as enum
    ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');
end if;

-- Which side of the wall a profile sits on. Drives default policy shape and
-- makes "is this a client?" a column lookup rather than a role join.
if to_regtype('public.user_type') is null then
  create type public.user_type as enum ('INTERNAL', 'CLIENT');
end if;

-- ---------------------------------------------------------------------------
-- Delivery organisation
-- ---------------------------------------------------------------------------

-- The seven internal delivery teams. Mirrors `src/lib/domain/teams.ts`.
if to_regtype('public.team') is null then
  create type public.team as enum (
    'ACCOUNT_MANAGEMENT',
    'SEO',
    'PAID_MEDIA',
    'WEB_DEVELOPMENT',
    'CRM_LIFECYCLE',
    'AI_AUTOMATION',
    'VIDEO_MULTIMEDIA'
  );
end if;

-- The seven published service lines — the catalogue of what is sold.
-- Mirrors `src/lib/domain/service-lines.ts`. Kept separate from `team`
-- (ADR-0006): the 1:1 correspondence today is a default, not an identity.
if to_regtype('public.service_line') is null then
  create type public.service_line as enum (
    'PROGRAMMATIC_SEO',
    'PRECISION_PAID_MEDIA',
    'WEB_CORE',
    'LIFECYCLE_CRM',
    'AI_AUTOMATIONS',
    'VIDEO_MULTIMEDIA',
    'ACCOUNT_MANAGEMENT'
  );
end if;

-- ---------------------------------------------------------------------------
-- Organization
-- ---------------------------------------------------------------------------

if to_regtype('public.org_status') is null then
  create type public.org_status as enum
    ('PROSPECT', 'ONBOARDING', 'ACTIVE', 'PAUSED', 'CHURNED', 'ARCHIVED');
end if;

-- The four bureaus.
if to_regtype('public.region_code') is null then
  create type public.region_code as enum ('NYC', 'LDN', 'SYD', 'DIFC');
end if;

-- Clients span four currency zones. FX conversion is out of scope (risk R-13):
-- reporting aggregates per currency only, so no rate table exists.
if to_regtype('public.currency_code') is null then
  create type public.currency_code as enum ('USD', 'GBP', 'EUR', 'AED', 'AUD');
end if;

-- ---------------------------------------------------------------------------
-- Commercial hierarchy
-- ---------------------------------------------------------------------------

if to_regtype('public.engagement_type') is null then
  create type public.engagement_type as enum ('RETAINER', 'PROJECT', 'ADVISORY');
end if;

if to_regtype('public.engagement_status') is null then
  create type public.engagement_status as enum
    ('DRAFT', 'PENDING_SIGNATURE', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');
end if;

if to_regtype('public.fee_model') is null then
  create type public.fee_model as enum
    ('RETAINER', 'FIXED', 'HOURLY', 'PERFORMANCE');
end if;

if to_regtype('public.service_status') is null then
  create type public.service_status as enum
    ('PLANNED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');
end if;

if to_regtype('public.project_status') is null then
  create type public.project_status as enum
    ('PLANNED', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED');
end if;

if to_regtype('public.project_health') is null then
  create type public.project_health as enum ('ON_TRACK', 'AT_RISK', 'OFF_TRACK');
end if;

if to_regtype('public.project_member_role') is null then
  create type public.project_member_role as enum
    ('LEAD', 'CONTRIBUTOR', 'REVIEWER', 'OBSERVER');
end if;

if to_regtype('public.priority') is null then
  create type public.priority as enum ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
end if;

-- ---------------------------------------------------------------------------
-- Deliverables and tasks
-- ---------------------------------------------------------------------------

if to_regtype('public.deliverable_type') is null then
  create type public.deliverable_type as enum (
    'REPORT',
    'PAGE_TEMPLATE_SET',
    'CAMPAIGN',
    'VIDEO',
    'AUTOMATION',
    'AUDIT',
    'DESIGN',
    'DOCUMENT',
    'OTHER'
  );
end if;

-- The review/approval workflow. Legal transitions between these values are
-- data, not code: migration 20 seeds `status_transitions` and a trigger
-- enforces it, so the API and the database cannot disagree.
if to_regtype('public.deliverable_status') is null then
  create type public.deliverable_status as enum (
    'DRAFT',
    'IN_PROGRESS',
    'INTERNAL_REVIEW',
    'SUBMITTED',
    'CLIENT_REVIEW',
    'REVISION_REQUESTED',
    'APPROVED',
    'PUBLISHED',
    'CANCELLED'
  );
end if;

if to_regtype('public.review_outcome') is null then
  create type public.review_outcome as enum
    ('APPROVED', 'REVISION_REQUESTED', 'REJECTED');
end if;

if to_regtype('public.task_status') is null then
  create type public.task_status as enum
    ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'DONE', 'CANCELLED');
end if;

-- ---------------------------------------------------------------------------
-- Reporting and metrics
-- ---------------------------------------------------------------------------

if to_regtype('public.report_type') is null then
  create type public.report_type as enum (
    'PERFORMANCE',
    'EXECUTIVE_SUMMARY',
    'CAMPAIGN',
    'SEO',
    'TECHNICAL_AUDIT',
    'QBR'
  );
end if;

if to_regtype('public.report_status') is null then
  create type public.report_status as enum
    ('DRAFT', 'INTERNAL_REVIEW', 'PUBLISHED', 'ARCHIVED');
end if;

if to_regtype('public.report_cadence') is null then
  create type public.report_cadence as enum
    ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'AD_HOC');
end if;

-- The proof points the public site advertises, plus the funnel basics. An enum
-- rather than free text because a metric key that varies by spelling cannot be
-- charted, compared across clients, or trusted.
if to_regtype('public.metric_key') is null then
  create type public.metric_key as enum (
    'PIPELINE_ENGINEERED',
    'BLENDED_ROAS',
    'P75_LCP_MS',
    'LTV_CAC_RATIO',
    'PAGES_INDEXED',
    'CAPI_MATCH_RATE',
    'LEAD_RESPONSE_MINUTES',
    'MQL_COUNT',
    'SQL_COUNT',
    'CPA',
    'CTR',
    'CONVERSION_RATE',
    'SESSIONS',
    'REVENUE'
  );
end if;

if to_regtype('public.metric_unit') is null then
  create type public.metric_unit as enum
    ('CURRENCY', 'COUNT', 'RATIO', 'PERCENT', 'MILLISECONDS', 'MINUTES');
end if;

if to_regtype('public.metric_source') is null then
  create type public.metric_source as enum (
    'MANUAL',
    'GA4',
    'GOOGLE_ADS',
    'META_ADS',
    'SEARCH_CONSOLE',
    'CRM',
    'CRUX',
    'INTERNAL'
  );
end if;

-- ---------------------------------------------------------------------------
-- Files
-- ---------------------------------------------------------------------------

if to_regtype('public.file_kind') is null then
  create type public.file_kind as enum (
    'ATTACHMENT',
    'DELIVERABLE_ASSET',
    'REPORT_EXPORT',
    'BRAND_ASSET',
    'CONTRACT',
    'AVATAR',
    'OTHER'
  );
end if;

if to_regtype('public.scan_status') is null then
  create type public.scan_status as enum ('PENDING', 'CLEAN', 'INFECTED', 'FAILED');
end if;

-- ---------------------------------------------------------------------------
-- Access lifecycle
-- ---------------------------------------------------------------------------

if to_regtype('public.invitation_status') is null then
  create type public.invitation_status as enum
    ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');
end if;

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------

if to_regtype('public.notification_type') is null then
  create type public.notification_type as enum (
    'DELIVERABLE_SUBMITTED',
    'DELIVERABLE_APPROVED',
    'REVISION_REQUESTED',
    'REPORT_PUBLISHED',
    'TASK_ASSIGNED',
    'TASK_DUE_SOON',
    'COMMENT_ADDED',
    'MENTION',
    'INVITATION_SENT',
    'MEMBERSHIP_CHANGED',
    'SYSTEM'
  );
end if;

if to_regtype('public.notification_severity') is null then
  create type public.notification_severity as enum ('INFO', 'WARNING', 'CRITICAL');
end if;

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

if to_regtype('public.audit_action') is null then
  create type public.audit_action as enum (
    'CREATE',
    'UPDATE',
    'SOFT_DELETE',
    'RESTORE',
    'HARD_DELETE',
    'STATUS_CHANGE',
    'ROLE_GRANT',
    'ROLE_REVOKE',
    'LOGIN',
    'LOGIN_FAILED',
    'INVITE_SENT',
    'INVITE_ACCEPTED',
    'PERMISSION_DENIED',
    'EXPORT',
    'FILE_DOWNLOAD'
  );
end if;

if to_regtype('public.audit_severity') is null then
  create type public.audit_severity as enum
    ('INFO', 'NOTICE', 'WARNING', 'CRITICAL');
end if;

-- The entity vocabulary shared with the application layer. MUST equal
-- ENTITY_KINDS in `src/lib/domain/entities.ts` — hierarchy entities first, then
-- supporting entities, in the same order.
if to_regtype('public.entity_kind') is null then
  create type public.entity_kind as enum (
    'organization',
    'engagement',
    'service',
    'project',
    'deliverable',
    'task',
    'comment',
    'attachment',
    'metric',
    'notification'
  );
end if;

end
$$;
