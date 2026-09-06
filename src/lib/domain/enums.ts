/**
 * Closed vocabularies that the API accepts on the wire.
 *
 * These arrays are the TypeScript twin of the PostgreSQL enums in
 * `supabase/migrations/20260905120200_enums.sql`. They exist so a route schema
 * can name the allowed values without importing generated database types
 * (which live behind the server wall) and so a 422 can list them.
 *
 * Drift against the database is a schema-contract concern
 * (`tests/unit/schema.spec.ts` already locks the SQL enums to
 * `src/lib/domain/{roles,teams,service-lines,entities}.ts`). This module is
 * the remaining axis: statuses, currencies, kinds.
 */

export const ORG_STATUSES = [
  'PROSPECT',
  'ONBOARDING',
  'ACTIVE',
  'PAUSED',
  'CHURNED',
  'ARCHIVED',
] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const REGION_CODES = ['NYC', 'LDN', 'SYD', 'DIFC'] as const;
export type RegionCode = (typeof REGION_CODES)[number];

export const CURRENCY_CODES = ['USD', 'GBP', 'EUR', 'AED', 'AUD'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export const ENGAGEMENT_TYPES = ['RETAINER', 'PROJECT', 'ADVISORY'] as const;
export type EngagementType = (typeof ENGAGEMENT_TYPES)[number];

export const ENGAGEMENT_STATUSES = [
  'DRAFT',
  'PENDING_SIGNATURE',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

export const FEE_MODELS = ['RETAINER', 'FIXED', 'HOURLY', 'PERFORMANCE'] as const;
export type FeeModel = (typeof FEE_MODELS)[number];

export const SERVICE_STATUSES = [
  'PLANNED',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const PROJECT_STATUSES = [
  'PLANNED',
  'IN_PROGRESS',
  'BLOCKED',
  'IN_REVIEW',
  'COMPLETED',
  'CANCELLED',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_HEALTHS = ['ON_TRACK', 'AT_RISK', 'OFF_TRACK'] as const;
export type ProjectHealth = (typeof PROJECT_HEALTHS)[number];

export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const DELIVERABLE_TYPES = [
  'REPORT',
  'PAGE_TEMPLATE_SET',
  'CAMPAIGN',
  'VIDEO',
  'AUTOMATION',
  'AUDIT',
  'DESIGN',
  'DOCUMENT',
  'OTHER',
] as const;
export type DeliverableType = (typeof DELIVERABLE_TYPES)[number];

export const DELIVERABLE_STATUSES = [
  'DRAFT',
  'IN_PROGRESS',
  'INTERNAL_REVIEW',
  'SUBMITTED',
  'CLIENT_REVIEW',
  'REVISION_REQUESTED',
  'APPROVED',
  'PUBLISHED',
  'CANCELLED',
] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

export const REVIEW_OUTCOMES = ['APPROVED', 'REVISION_REQUESTED', 'REJECTED'] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

export const TASK_STATUSES = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'IN_REVIEW',
  'DONE',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const REPORT_TYPES = [
  'PERFORMANCE',
  'EXECUTIVE_SUMMARY',
  'CAMPAIGN',
  'SEO',
  'TECHNICAL_AUDIT',
  'QBR',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_STATUSES = ['DRAFT', 'INTERNAL_REVIEW', 'PUBLISHED', 'ARCHIVED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_CADENCES = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'AD_HOC'] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];

export const METRIC_KEYS = [
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
  'REVENUE',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export const METRIC_UNITS = [
  'CURRENCY',
  'COUNT',
  'RATIO',
  'PERCENT',
  'MILLISECONDS',
  'MINUTES',
] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

export const METRIC_SOURCES = [
  'MANUAL',
  'GA4',
  'GOOGLE_ADS',
  'META_ADS',
  'SEARCH_CONSOLE',
  'CRM',
  'CRUX',
  'INTERNAL',
] as const;
export type MetricSource = (typeof METRIC_SOURCES)[number];

export const FILE_KINDS = [
  'ATTACHMENT',
  'DELIVERABLE_ASSET',
  'REPORT_EXPORT',
  'BRAND_ASSET',
  'CONTRACT',
  'AVATAR',
  'OTHER',
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const SCAN_STATUSES = ['PENDING', 'CLEAN', 'INFECTED', 'FAILED'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const INVITATION_STATUSES = ['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const NOTIFICATION_TYPES = [
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
  'SYSTEM',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const ACCOUNT_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export type AccountStatusWire = (typeof ACCOUNT_STATUSES)[number];

export const MEMBERSHIP_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export type MembershipStatusWire = (typeof MEMBERSHIP_STATUSES)[number];

export const USER_TYPES = ['INTERNAL', 'CLIENT'] as const;
export type UserTypeWire = (typeof USER_TYPES)[number];
