import { z } from 'zod';

import { INTERNAL_TEAMS } from '@/lib/domain/teams';
import { SERVICE_LINES } from '@/lib/domain/service-lines';
import { ORGANIZATION_ROLES, PLATFORM_ROLES, PROJECT_MEMBER_ROLES } from '@/lib/domain/roles';
import {
  CURRENCY_CODES,
  DELIVERABLE_STATUSES,
  DELIVERABLE_TYPES,
  ENGAGEMENT_STATUSES,
  ENGAGEMENT_TYPES,
  FEE_MODELS,
  FILE_KINDS,
  METRIC_KEYS,
  METRIC_SOURCES,
  METRIC_UNITS,
  ORG_STATUSES,
  PRIORITIES,
  PROJECT_HEALTHS,
  PROJECT_STATUSES,
  REGION_CODES,
  REPORT_CADENCES,
  REPORT_STATUSES,
  REPORT_TYPES,
  REVIEW_OUTCOMES,
  SERVICE_STATUSES,
  TASK_STATUSES,
} from '@/lib/domain/enums';
import {
  csvField,
  dateField,
  enumField,
  hexColorField,
  httpUrlField,
  moneyField,
  optionalTextField,
  organizationSlugField,
  textField,
  uuidField,
} from '@/lib/validation/common';
import { paginationQuerySchema } from '@/lib/validation/pagination';

export const idParamSchema = z.object({ id: uuidField('id') }).strict();
export const userIdParamSchema = z.object({ userId: uuidField('userId') }).strict();
export const organizationIdParamSchema = z
  .object({ organizationId: uuidField('organizationId') })
  .strict();
export const membershipIdParamSchema = z
  .object({
    organizationId: uuidField('organizationId'),
    membershipId: uuidField('membershipId'),
  })
  .strict();
export const projectMemberParamSchema = z
  .object({
    id: uuidField('id'),
    membershipId: uuidField('membershipId'),
  })
  .strict();
export const grantIdParamSchema = z.object({ grantId: uuidField('grantId') }).strict();

export const orgListQuerySchema = paginationQuerySchema.extend({
  q: z.string().min(1).max(200).optional(),
  status: csvField(enumField('status', ORG_STATUSES)).optional(),
  region: csvField(enumField('region', REGION_CODES)).optional(),
});

export const createOrganizationBodySchema = z
  .object({
    slug: organizationSlugField(),
    legalName: textField('legalName', 200),
    displayName: textField('displayName', 200),
    region: enumField('region', REGION_CODES),
    industry: optionalTextField('industry', 200),
    websiteUrl: httpUrlField('websiteUrl').optional(),
    primaryCurrency: enumField('primaryCurrency', CURRENCY_CODES),
    accountManagerUserId: uuidField('accountManagerUserId').optional(),
  })
  .strict();

export const patchOrganizationBodySchema = z
  .object({
    legalName: textField('legalName', 200).optional(),
    displayName: textField('displayName', 200).optional(),
    region: enumField('region', REGION_CODES).optional(),
    industry: optionalTextField('industry', 200),
    websiteUrl: httpUrlField('websiteUrl').optional(),
    primaryCurrency: enumField('primaryCurrency', CURRENCY_CODES).optional(),
  })
  .strict();

export const archiveOrganizationBodySchema = z
  .object({
    reason: textField('reason', 500),
    confirmSlug: organizationSlugField(),
  })
  .strict();

export const assignManagerBodySchema = z
  .object({ accountManagerUserId: uuidField('accountManagerUserId').nullable() })
  .strict();

export const patchOrganizationSettingsBodySchema = z
  .object({
    brandPrimaryColor: hexColorField('brandPrimaryColor').optional(),
    logoFileId: uuidField('logoFileId').nullable().optional(),
    defaultReportCadence: enumField('defaultReportCadence', REPORT_CADENCES).optional(),
    notifyOnDeliverableReady: z.boolean().optional(),
    notifyOnReportPublished: z.boolean().optional(),
    requireApprovalForPublish: z.boolean().optional(),
    timezone: textField('timezone', 64).optional(),
  })
  .strict();

export const putOrganizationSettingsBodySchema = z
  .object({
    brandPrimaryColor: hexColorField('brandPrimaryColor').nullable(),
    logoFileId: uuidField('logoFileId').nullable(),
    defaultReportCadence: enumField('defaultReportCadence', REPORT_CADENCES),
    notifyOnDeliverableReady: z.boolean(),
    notifyOnReportPublished: z.boolean(),
    requireApprovalForPublish: z.boolean(),
    timezone: textField('timezone', 64),
  })
  .strict();

export const teamMembersParamSchema = z
  .object({ team: enumField('team', INTERNAL_TEAMS) })
  .strict();

export const teamMembersQuerySchema = paginationQuerySchema.extend({
  isLead: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});

export const membershipOnlyParamSchema = z
  .object({ membershipId: uuidField('membershipId') })
  .strict();

export const patchMeBodySchema = z
  .object({
    fullName: textField('fullName', 200).optional(),
    displayName: optionalTextField('displayName', 200),
    timezone: textField('timezone', 64).optional(),
    locale: textField('locale', 16).optional(),
    avatarPath: optionalTextField('avatarPath', 500),
  })
  .strict();

export const usersListQuerySchema = paginationQuerySchema.extend({
  q: z.string().min(1).max(200).optional(),
  organizationId: uuidField('organizationId').optional(),
  status: csvField(enumField('status', ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'])).optional(),
  userType: enumField('userType', ['INTERNAL', 'CLIENT']).optional(),
  team: csvField(enumField('team', INTERNAL_TEAMS)).optional(),
});

export const membersListQuerySchema = paginationQuerySchema.extend({
  status: csvField(enumField('status', ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'])).optional(),
  role: csvField(enumField('role', ORGANIZATION_ROLES)).optional(),
});

export const addMemberBodySchema = z
  .object({
    userId: uuidField('userId'),
    role: enumField('role', ORGANIZATION_ROLES),
    jobTitle: optionalTextField('jobTitle', 200),
  })
  .strict();

export const patchMemberBodySchema = z
  .object({
    role: enumField('role', ORGANIZATION_ROLES).optional(),
    status: enumField('status', ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
    isPrimaryContact: z.boolean().optional(),
    newPrimaryMembershipId: uuidField('newPrimaryMembershipId').optional(),
    jobTitle: optionalTextField('jobTitle', 200),
  })
  .strict();

export const deleteMemberBodySchema = z
  .object({ reason: optionalTextField('reason', 500) })
  .strict();

export const deleteMemberQuerySchema = z
  .object({ newPrimaryMembershipId: uuidField('newPrimaryMembershipId').optional() })
  .strict();

export const grantsListQuerySchema = paginationQuerySchema.extend({
  userId: uuidField('userId').optional(),
  role: enumField('role', PLATFORM_ROLES).optional(),
});

export const createGrantBodySchema = z
  .object({
    userId: uuidField('userId'),
    role: enumField('role', PLATFORM_ROLES),
    reason: textField('reason', 1024),
    expiresAt: z.iso.datetime().optional(),
  })
  .strict();

export const revokeGrantBodySchema = z.object({ reason: textField('reason', 1024) }).strict();

export const invitationsListQuerySchema = paginationQuerySchema.extend({
  organizationId: uuidField('organizationId').optional(),
  status: csvField(enumField('status', ['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED'])).optional(),
  email: z.string().min(1).max(320).optional(),
});

export const teamMembershipsListQuerySchema = paginationQuerySchema.extend({
  userId: uuidField('userId').optional(),
  team: csvField(enumField('team', INTERNAL_TEAMS)).optional(),
});

export const createTeamMembershipBodySchema = z
  .object({
    userId: uuidField('userId'),
    team: enumField('team', INTERNAL_TEAMS),
    isLead: z.boolean().optional(),
    allocationPct: z.number().int().min(0).max(100).optional(),
  })
  .strict();

export const patchTeamMembershipBodySchema = z
  .object({
    isLead: z.boolean().optional(),
    allocationPct: z.number().int().min(0).max(100).nullable().optional(),
  })
  .strict();

export const engagementListQuerySchema = paginationQuerySchema.extend({
  organizationId: uuidField('organizationId').optional(),
  status: csvField(enumField('status', ENGAGEMENT_STATUSES)).optional(),
  engagementType: csvField(enumField('engagementType', ENGAGEMENT_TYPES)).optional(),
});

export const createEngagementBodySchema = z
  .object({
    organizationId: uuidField('organizationId').optional(),
    code: textField('code', 32),
    name: textField('name', 200),
    engagementType: enumField('engagementType', ENGAGEMENT_TYPES),
    currency: enumField('currency', CURRENCY_CODES),
    startDate: dateField('startDate'),
    endDate: dateField('endDate').optional(),
    renewalDate: dateField('renewalDate').optional(),
    contractValue: moneyField('contractValue').optional(),
    monthlyRetainer: moneyField('monthlyRetainer').optional(),
    notesInternal: optionalTextField('notesInternal', 5000),
    accountManagerUserId: uuidField('accountManagerUserId').optional(),
  })
  .strict();

export const patchEngagementBodySchema = z
  .object({
    name: textField('name', 200).optional(),
    engagementType: enumField('engagementType', ENGAGEMENT_TYPES).optional(),
    currency: enumField('currency', CURRENCY_CODES).optional(),
    startDate: dateField('startDate').optional(),
    endDate: dateField('endDate').nullable().optional(),
    renewalDate: dateField('renewalDate').nullable().optional(),
    contractValue: moneyField('contractValue').nullable().optional(),
    monthlyRetainer: moneyField('monthlyRetainer').nullable().optional(),
    notesInternal: optionalTextField('notesInternal', 5000),
  })
  .strict();

export const statusChangeBodySchema = z
  .object({
    status: textField('status', 64),
    reason: optionalTextField('reason', 500),
  })
  .strict();

export const serviceListQuerySchema = paginationQuerySchema.extend({
  organizationId: uuidField('organizationId').optional(),
  engagementId: uuidField('engagementId').optional(),
  status: csvField(enumField('status', SERVICE_STATUSES)).optional(),
  serviceLine: csvField(enumField('serviceLine', SERVICE_LINES)).optional(),
});

export const createServiceBodySchema = z
  .object({
    engagementId: uuidField('engagementId').optional(),
    serviceLine: enumField('serviceLine', SERVICE_LINES),
    deliveringTeam: enumField('deliveringTeam', INTERNAL_TEAMS),
    name: textField('name', 200),
    scopeSummary: optionalTextField('scopeSummary', 5000),
    currency: enumField('currency', CURRENCY_CODES),
    startDate: dateField('startDate'),
    endDate: dateField('endDate').optional(),
    fee: moneyField('fee').optional(),
    feeModel: enumField('feeModel', FEE_MODELS).optional(),
    leadUserId: uuidField('leadUserId').optional(),
  })
  .strict();

export const patchServiceBodySchema = z
  .object({
    name: textField('name', 200).optional(),
    scopeSummary: optionalTextField('scopeSummary', 5000),
    deliveringTeam: enumField('deliveringTeam', INTERNAL_TEAMS).optional(),
    currency: enumField('currency', CURRENCY_CODES).optional(),
    startDate: dateField('startDate').optional(),
    endDate: dateField('endDate').nullable().optional(),
    fee: moneyField('fee').nullable().optional(),
    feeModel: enumField('feeModel', FEE_MODELS).optional(),
  })
  .strict();

export const assignLeadBodySchema = z
  .object({
    leadUserId: uuidField('leadUserId').nullable().optional(),
    deliveringTeam: enumField('deliveringTeam', INTERNAL_TEAMS).optional(),
  })
  .strict();

export const projectListQuerySchema = paginationQuerySchema.extend({
  organizationId: uuidField('organizationId').optional(),
  serviceId: uuidField('serviceId').optional(),
  status: csvField(enumField('status', PROJECT_STATUSES)).optional(),
  owningTeam: csvField(enumField('owningTeam', INTERNAL_TEAMS)).optional(),
});

export const createProjectBodySchema = z
  .object({
    serviceId: uuidField('serviceId').optional(),
    code: textField('code', 32),
    name: textField('name', 200),
    description: optionalTextField('description', 5000),
    priority: enumField('priority', PRIORITIES).optional(),
    health: enumField('health', PROJECT_HEALTHS).optional(),
    owningTeam: enumField('owningTeam', INTERNAL_TEAMS),
    leadUserId: uuidField('leadUserId').optional(),
    startDate: dateField('startDate').optional(),
    targetDate: dateField('targetDate').optional(),
    clientVisible: z.boolean().optional(),
  })
  .strict();

export const patchProjectBodySchema = z
  .object({
    name: textField('name', 200).optional(),
    description: optionalTextField('description', 5000),
    priority: enumField('priority', PRIORITIES).optional(),
    health: enumField('health', PROJECT_HEALTHS).optional(),
    startDate: dateField('startDate').nullable().optional(),
    targetDate: dateField('targetDate').nullable().optional(),
    clientVisible: z.boolean().optional(),
  })
  .strict();

export const assignProjectBodySchema = z
  .object({
    leadUserId: uuidField('leadUserId').nullable().optional(),
    owningTeam: enumField('owningTeam', INTERNAL_TEAMS).optional(),
  })
  .strict();

export const createProjectMemberBodySchema = z
  .object({
    userId: uuidField('userId'),
    projectRole: enumField('projectRole', PROJECT_MEMBER_ROLES),
    allocationPct: z.number().int().min(0).max(100).optional(),
  })
  .strict();

export const patchProjectMemberBodySchema = z
  .object({
    projectRole: enumField('projectRole', PROJECT_MEMBER_ROLES).optional(),
    allocationPct: z.number().int().min(0).max(100).nullable().optional(),
  })
  .strict();

export const taskListQuerySchema = paginationQuerySchema.extend({
  organizationId: uuidField('organizationId').optional(),
  projectId: uuidField('projectId').optional(),
  deliverableId: uuidField('deliverableId').optional(),
  status: csvField(enumField('status', TASK_STATUSES)).optional(),
  assigneeUserId: uuidField('assigneeUserId').optional(),
});

export const createTaskBodySchema = z
  .object({
    projectId: uuidField('projectId').optional(),
    deliverableId: uuidField('deliverableId').optional(),
    title: textField('title', 200),
    description: optionalTextField('description', 5000),
    priority: enumField('priority', PRIORITIES).optional(),
    assigneeUserId: uuidField('assigneeUserId').optional(),
    assignedTeam: enumField('assignedTeam', INTERNAL_TEAMS).optional(),
    dueDate: dateField('dueDate').optional(),
    estimatedHours: z.number().min(0).max(10_000).optional(),
  })
  .strict();

export const patchTaskBodySchema = z
  .object({
    title: textField('title', 200).optional(),
    description: optionalTextField('description', 5000),
    priority: enumField('priority', PRIORITIES).optional(),
    assignedTeam: enumField('assignedTeam', INTERNAL_TEAMS).nullable().optional(),
    dueDate: dateField('dueDate').nullable().optional(),
    estimatedHours: z.number().min(0).max(10_000).nullable().optional(),
    actualHours: z.number().min(0).max(10_000).nullable().optional(),
    blockedReason: optionalTextField('blockedReason', 500),
    position: z.number().int().min(0).optional(),
  })
  .strict();

export const assignTaskBodySchema = z
  .object({ assigneeUserId: uuidField('assigneeUserId').nullable() })
  .strict();

export const deliverableListQuerySchema = paginationQuerySchema.extend({
  organizationId: uuidField('organizationId').optional(),
  projectId: uuidField('projectId').optional(),
  status: csvField(enumField('status', DELIVERABLE_STATUSES)).optional(),
});

export const createDeliverableBodySchema = z
  .object({
    projectId: uuidField('projectId').optional(),
    title: textField('title', 200),
    description: optionalTextField('description', 5000),
    deliverableType: enumField('deliverableType', DELIVERABLE_TYPES),
    dueDate: dateField('dueDate').optional(),
    ownerUserId: uuidField('ownerUserId').optional(),
    clientVisible: z.boolean().optional(),
  })
  .strict();

export const patchDeliverableBodySchema = z
  .object({
    title: textField('title', 200).optional(),
    description: optionalTextField('description', 5000),
    deliverableType: enumField('deliverableType', DELIVERABLE_TYPES).optional(),
    dueDate: dateField('dueDate').nullable().optional(),
    clientVisible: z.boolean().optional(),
  })
  .strict();

export const assignOwnerBodySchema = z
  .object({ ownerUserId: uuidField('ownerUserId').nullable() })
  .strict();

export const reviewBodySchema = z
  .object({
    outcome: enumField('outcome', REVIEW_OUTCOMES),
    notes: optionalTextField('notes', 4096),
    summary: optionalTextField('summary', 2000),
  })
  .strict();

export const reportListQuerySchema = paginationQuerySchema.extend({
  organizationId: uuidField('organizationId').optional(),
  engagementId: uuidField('engagementId').optional(),
  serviceId: uuidField('serviceId').optional(),
  status: csvField(enumField('status', REPORT_STATUSES)).optional(),
});

export const createReportBodySchema = z
  .object({
    organizationId: uuidField('organizationId').optional(),
    engagementId: uuidField('engagementId').optional(),
    serviceId: uuidField('serviceId').optional(),
    title: textField('title', 200),
    reportType: enumField('reportType', REPORT_TYPES),
    periodStart: dateField('periodStart'),
    periodEnd: dateField('periodEnd'),
    currency: enumField('currency', CURRENCY_CODES).optional(),
    summaryMd: optionalTextField('summaryMd', 20_000),
  })
  .strict();

export const patchReportBodySchema = z
  .object({
    title: textField('title', 200).optional(),
    reportType: enumField('reportType', REPORT_TYPES).optional(),
    periodStart: dateField('periodStart').optional(),
    periodEnd: dateField('periodEnd').optional(),
    currency: enumField('currency', CURRENCY_CODES).nullable().optional(),
    summaryMd: optionalTextField('summaryMd', 20_000),
  })
  .strict();

export const publishReportBodySchema = z
  .object({ clientVisible: z.boolean().optional() })
  .strict();

export const metricListQuerySchema = paginationQuerySchema.extend({
  organizationId: uuidField('organizationId').optional(),
  serviceId: uuidField('serviceId').optional(),
  metricKey: csvField(enumField('metricKey', METRIC_KEYS)).optional(),
  from: dateField('from').optional(),
  to: dateField('to').optional(),
});

export const createMetricBodySchema = z
  .object({
    organizationId: uuidField('organizationId'),
    serviceId: uuidField('serviceId').optional(),
    serviceLine: enumField('serviceLine', SERVICE_LINES).optional(),
    metricKey: enumField('metricKey', METRIC_KEYS),
    metricDate: dateField('metricDate'),
    value: z.number().finite(),
    unit: enumField('unit', METRIC_UNITS),
    currency: enumField('currency', CURRENCY_CODES).optional(),
    source: enumField('source', METRIC_SOURCES).optional(),
    sourceRef: optionalTextField('sourceRef', 200),
  })
  .strict();

export const fileListQuerySchema = paginationQuerySchema.extend({
  organizationId: uuidField('organizationId').optional(),
  projectId: uuidField('projectId').optional(),
  deliverableId: uuidField('deliverableId').optional(),
  taskId: uuidField('taskId').optional(),
  reportId: uuidField('reportId').optional(),
});

export const uploadUrlBodySchema = z
  .object({
    organizationId: uuidField('organizationId').optional(),
    fileName: textField('fileName', 255),
    mimeType: textField('mimeType', 127),
    sizeBytes: z.number().int().positive().max(500 * 1024 * 1024),
    fileKind: enumField('fileKind', FILE_KINDS).optional(),
    projectId: uuidField('projectId').optional(),
    deliverableId: uuidField('deliverableId').optional(),
    taskId: uuidField('taskId').optional(),
    reportId: uuidField('reportId').optional(),
    commentId: uuidField('commentId').optional(),
    clientVisible: z.boolean().optional(),
  })
  .strict();

export const registerFileBodySchema = uploadUrlBodySchema
  .extend({
    storagePath: textField('storagePath', 1024),
  })
  .strict();

export const patchFileBodySchema = z
  .object({
    fileName: textField('fileName', 255).optional(),
    fileKind: enumField('fileKind', FILE_KINDS).optional(),
    clientVisible: z.boolean().optional(),
  })
  .strict();

export const notificationListQuerySchema = paginationQuerySchema.extend({
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  archived: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});

export const patchNotificationBodySchema = z
  .object({
    read: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .strict();

export const commentListQuerySchema = paginationQuerySchema.extend({
  organizationId: uuidField('organizationId').optional(),
  projectId: uuidField('projectId').optional(),
  deliverableId: uuidField('deliverableId').optional(),
  taskId: uuidField('taskId').optional(),
});

export const createCommentBodySchema = z
  .object({
    projectId: uuidField('projectId').optional(),
    deliverableId: uuidField('deliverableId').optional(),
    taskId: uuidField('taskId').optional(),
    parentCommentId: uuidField('parentCommentId').optional(),
    body: textField('body', 10_000),
    isInternal: z.boolean().optional(),
  })
  .strict();

export const clientCreateCommentBodySchema = z
  .object({
    projectId: uuidField('projectId').optional(),
    deliverableId: uuidField('deliverableId').optional(),
    parentCommentId: uuidField('parentCommentId').optional(),
    body: textField('body', 10_000),
  })
  .strict();

export const patchCommentBodySchema = z.object({ body: textField('body', 10_000) }).strict();

export const activityListQuerySchema = paginationQuerySchema.extend({
  organizationId: uuidField('organizationId').optional(),
  entityKind: z.string().min(1).max(32).optional(),
});

export const orgActivityQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    before: z.iso.datetime().optional(),
  })
  .strict();

export const statusTransitionsQuerySchema = z
  .object({
    entityKind: z.string().min(1).max(32).optional(),
  })
  .strict();

export const eraseUserBodySchema = z.object({ reason: textField('reason', 500) }).strict();
