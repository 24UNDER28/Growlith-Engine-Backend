/**
 * Explicit DTO mappers. Never a raw row, never a spread of the request
 * (mass assignment is a 422 at the schema; this is the other half: the
 * response cannot leak a column the GRANT layer withheld).
 *
 * Commercial fields (`contract_value`, `monthly_retainer`, `notes_internal`,
 * `fee`, `fee_model`, `allocation_pct`) are optional and only populated when
 * the service layer enriched the row through `service_role` after a user-JWT
 * visibility check.
 */

import type { AuthContext } from '@/lib/auth/context';

export function iso(value: string | null | undefined): string | null {
  return value ?? null;
}

export interface OrganizationDto {
  readonly id: string;
  readonly slug: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly region: string;
  readonly industry: string | null;
  readonly websiteUrl: string | null;
  readonly status: string;
  readonly primaryCurrency: string;
  readonly accountManagerUserId: string | null;
  readonly onboardedAt: string | null;
  readonly churnedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toOrganizationDto(row: {
  readonly id: string;
  readonly slug: string;
  readonly legal_name: string;
  readonly display_name: string;
  readonly region: string;
  readonly industry: string | null;
  readonly website_url: string | null;
  readonly status: string;
  readonly primary_currency: string;
  readonly account_manager_user_id: string | null;
  readonly onboarded_at: string | null;
  readonly churned_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}): OrganizationDto {
  return {
    id: row.id,
    slug: row.slug,
    legalName: row.legal_name,
    displayName: row.display_name,
    region: row.region,
    industry: row.industry,
    websiteUrl: row.website_url,
    status: row.status,
    primaryCurrency: row.primary_currency,
    accountManagerUserId: row.account_manager_user_id,
    onboardedAt: row.onboarded_at,
    churnedAt: row.churned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface OrganizationSettingsDto {
  readonly organizationId: string;
  readonly brandPrimaryColor: string | null;
  readonly logoFileId: string | null;
  readonly defaultReportCadence: string;
  readonly notifyOnDeliverableReady: boolean;
  readonly notifyOnReportPublished: boolean;
  readonly requireApprovalForPublish: boolean;
  readonly timezone: string;
  readonly updatedAt: string;
}

export function toOrganizationSettingsDto(row: {
  readonly organization_id: string;
  readonly brand_primary_color: string | null;
  readonly logo_file_id: string | null;
  readonly default_report_cadence: string;
  readonly notify_on_deliverable_ready: boolean;
  readonly notify_on_report_published: boolean;
  readonly require_approval_for_publish: boolean;
  readonly timezone: string;
  readonly updated_at: string;
}): OrganizationSettingsDto {
  return {
    organizationId: row.organization_id,
    brandPrimaryColor: row.brand_primary_color,
    logoFileId: row.logo_file_id,
    defaultReportCadence: row.default_report_cadence,
    notifyOnDeliverableReady: row.notify_on_deliverable_ready,
    notifyOnReportPublished: row.notify_on_report_published,
    requireApprovalForPublish: row.require_approval_for_publish,
    timezone: row.timezone,
    updatedAt: row.updated_at,
  };
}

export interface ProfileDto {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly displayName: string | null;
  readonly avatarPath: string | null;
  readonly timezone: string;
  readonly locale: string;
  readonly userType: string;
  readonly accountStatus: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toProfileDto(row: {
  readonly id: string;
  readonly email: string;
  readonly full_name: string;
  readonly display_name: string | null;
  readonly avatar_path: string | null;
  readonly timezone: string;
  readonly locale: string;
  readonly user_type: string;
  readonly account_status: string;
  readonly created_at: string;
  readonly updated_at: string;
}): ProfileDto {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    displayName: row.display_name,
    avatarPath: row.avatar_path,
    timezone: row.timezone,
    locale: row.locale,
    userType: row.user_type,
    accountStatus: row.account_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface MeDto {
  readonly profile: ProfileDto;
  readonly memberships: readonly {
    readonly organizationId: string;
    readonly role: string;
    readonly status: string;
    readonly isPrimaryContact: boolean;
  }[];
  readonly platformRole: string | null;
  readonly teams: readonly string[];
  readonly aal: 'aal1' | 'aal2';
  readonly mfaEnrolled: boolean;
}

export function toMeDto(auth: AuthContext, profile: ProfileDto): MeDto {
  return {
    profile,
    memberships: auth.memberships.map((membership) => ({
      organizationId: membership.organizationId,
      role: membership.role,
      status: membership.status,
      isPrimaryContact: membership.isPrimaryContact,
    })),
    platformRole: auth.platformRole,
    teams: [...auth.teams],
    aal: auth.aal,
    mfaEnrolled: auth.mfaEnrolled,
  };
}

export interface MembershipDto {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  readonly isPrimaryContact: boolean;
  readonly jobTitle: string | null;
  readonly joinedAt: string | null;
  readonly createdAt: string;
}

export function toMembershipDto(row: {
  readonly id: string;
  readonly organization_id: string;
  readonly user_id: string;
  readonly role: string;
  readonly status: string;
  readonly is_primary_contact: boolean;
  readonly job_title: string | null;
  readonly joined_at: string | null;
  readonly created_at: string;
}): MembershipDto {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    isPrimaryContact: row.is_primary_contact,
    jobTitle: row.job_title,
    joinedAt: row.joined_at,
    createdAt: row.created_at,
  };
}

export interface PlatformGrantDto {
  readonly id: string;
  readonly userId: string;
  readonly role: string;
  readonly grantedAt: string;
  readonly expiresAt: string | null;
  readonly reason: string;
}

export function toPlatformGrantDto(row: {
  readonly id: string;
  readonly user_id: string;
  readonly role: string;
  readonly granted_at: string;
  readonly expires_at: string | null;
  readonly reason: string;
}): PlatformGrantDto {
  return {
    id: row.id,
    userId: row.user_id,
    role: row.role,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    reason: row.reason,
  };
}

export interface TeamMembershipDto {
  readonly id: string;
  readonly userId: string;
  readonly team: string;
  readonly isLead: boolean;
  readonly allocationPct: number | null;
  readonly createdAt: string;
}

export function toTeamMembershipDto(row: {
  readonly id: string;
  readonly user_id: string;
  readonly team: string;
  readonly is_lead: boolean;
  readonly allocation_pct: number | null;
  readonly created_at: string;
}): TeamMembershipDto {
  return {
    id: row.id,
    userId: row.user_id,
    team: row.team,
    isLead: row.is_lead,
    allocationPct: row.allocation_pct,
    createdAt: row.created_at,
  };
}

export interface EngagementDto {
  readonly id: string;
  readonly organizationId: string;
  readonly code: string;
  readonly name: string;
  readonly engagementType: string;
  readonly status: string;
  readonly currency: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly renewalDate: string | null;
  readonly accountManagerUserId: string | null;
  readonly signedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly contractValue?: number | null;
  readonly monthlyRetainer?: number | null;
  readonly notesInternal?: string | null;
}

export function toEngagementDto(
  row: {
    readonly id: string;
    readonly organization_id: string;
    readonly code: string;
    readonly name: string;
    readonly engagement_type: string;
    readonly status: string;
    readonly currency: string;
    readonly start_date: string;
    readonly end_date: string | null;
    readonly renewal_date: string | null;
    readonly account_manager_user_id: string | null;
    readonly signed_at: string | null;
    readonly created_at: string;
    readonly updated_at: string;
    readonly contract_value?: number | null;
    readonly monthly_retainer?: number | null;
    readonly notes_internal?: string | null;
  },
  commercial: boolean,
): EngagementDto {
  const dto: EngagementDto = {
    id: row.id,
    organizationId: row.organization_id,
    code: row.code,
    name: row.name,
    engagementType: row.engagement_type,
    status: row.status,
    currency: row.currency,
    startDate: row.start_date,
    endDate: row.end_date,
    renewalDate: row.renewal_date,
    accountManagerUserId: row.account_manager_user_id,
    signedAt: row.signed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (!commercial) {
    return dto;
  }
  return {
    ...dto,
    contractValue: row.contract_value ?? null,
    monthlyRetainer: row.monthly_retainer ?? null,
    notesInternal: row.notes_internal ?? null,
  };
}

export interface ServiceDto {
  readonly id: string;
  readonly organizationId: string;
  readonly engagementId: string;
  readonly serviceLine: string;
  readonly deliveringTeam: string;
  readonly name: string;
  readonly scopeSummary: string | null;
  readonly status: string;
  readonly currency: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly leadUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly fee?: number | null;
  readonly feeModel?: string | null;
}

export function toServiceDto(
  row: {
    readonly id: string;
    readonly organization_id: string;
    readonly engagement_id: string;
    readonly service_line: string;
    readonly delivering_team: string;
    readonly name: string;
    readonly scope_summary: string | null;
    readonly status: string;
    readonly currency: string;
    readonly start_date: string;
    readonly end_date: string | null;
    readonly lead_user_id: string | null;
    readonly created_at: string;
    readonly updated_at: string;
    readonly fee?: number | null;
    readonly fee_model?: string | null;
  },
  commercial: boolean,
): ServiceDto {
  const dto: ServiceDto = {
    id: row.id,
    organizationId: row.organization_id,
    engagementId: row.engagement_id,
    serviceLine: row.service_line,
    deliveringTeam: row.delivering_team,
    name: row.name,
    scopeSummary: row.scope_summary,
    status: row.status,
    currency: row.currency,
    startDate: row.start_date,
    endDate: row.end_date,
    leadUserId: row.lead_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (!commercial) {
    return dto;
  }
  return { ...dto, fee: row.fee ?? null, feeModel: row.fee_model ?? null };
}

export interface ProjectDto {
  readonly id: string;
  readonly organizationId: string;
  readonly serviceId: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly priority: string;
  readonly health: string;
  readonly leadUserId: string | null;
  readonly owningTeam: string;
  readonly startDate: string | null;
  readonly targetDate: string | null;
  readonly completedAt: string | null;
  readonly clientVisible: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toProjectDto(row: {
  readonly id: string;
  readonly organization_id: string;
  readonly service_id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly priority: string;
  readonly health: string;
  readonly lead_user_id: string | null;
  readonly owning_team: string;
  readonly start_date: string | null;
  readonly target_date: string | null;
  readonly completed_at: string | null;
  readonly client_visible: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}): ProjectDto {
  return {
    id: row.id,
    organizationId: row.organization_id,
    serviceId: row.service_id,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    priority: row.priority,
    health: row.health,
    leadUserId: row.lead_user_id,
    owningTeam: row.owning_team,
    startDate: row.start_date,
    targetDate: row.target_date,
    completedAt: row.completed_at,
    clientVisible: row.client_visible,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ProjectMembershipDto {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly projectRole: string;
  readonly createdAt: string;
  readonly allocationPct?: number | null;
}

export function toProjectMembershipDto(
  row: {
    readonly id: string;
    readonly organization_id: string;
    readonly project_id: string;
    readonly user_id: string;
    readonly project_role: string;
    readonly created_at: string;
    readonly allocation_pct?: number | null;
  },
  commercial: boolean,
): ProjectMembershipDto {
  const dto: ProjectMembershipDto = {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    userId: row.user_id,
    projectRole: row.project_role,
    createdAt: row.created_at,
  };
  if (!commercial) {
    return dto;
  }
  return { ...dto, allocationPct: row.allocation_pct ?? null };
}

export interface TaskDto {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly deliverableId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly priority: string;
  readonly assigneeUserId: string | null;
  readonly assignedTeam: string | null;
  readonly dueDate: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly estimatedHours: number | null;
  readonly actualHours: number | null;
  readonly blockedReason: string | null;
  readonly position: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toTaskDto(row: {
  readonly id: string;
  readonly organization_id: string;
  readonly project_id: string;
  readonly deliverable_id: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly priority: string;
  readonly assignee_user_id: string | null;
  readonly assigned_team: string | null;
  readonly due_date: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly estimated_hours: number | null;
  readonly actual_hours: number | null;
  readonly blocked_reason: string | null;
  readonly position: number;
  readonly created_at: string;
  readonly updated_at: string;
}): TaskDto {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    deliverableId: row.deliverable_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeUserId: row.assignee_user_id,
    assignedTeam: row.assigned_team,
    dueDate: row.due_date,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    estimatedHours: row.estimated_hours,
    actualHours: row.actual_hours,
    blockedReason: row.blocked_reason,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface DeliverableDto {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string | null;
  readonly deliverableType: string;
  readonly status: string;
  readonly clientVisible: boolean;
  readonly currentVersion: number;
  readonly revisionCount: number;
  readonly dueDate: string | null;
  readonly submittedAt: string | null;
  readonly approvedAt: string | null;
  readonly approvedBy: string | null;
  readonly ownerUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toDeliverableDto(row: {
  readonly id: string;
  readonly organization_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly description: string | null;
  readonly deliverable_type: string;
  readonly status: string;
  readonly client_visible: boolean;
  readonly current_version: number;
  readonly revision_count: number;
  readonly due_date: string | null;
  readonly submitted_at: string | null;
  readonly approved_at: string | null;
  readonly approved_by: string | null;
  readonly owner_user_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}): DeliverableDto {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    deliverableType: row.deliverable_type,
    status: row.status,
    clientVisible: row.client_visible,
    currentVersion: row.current_version,
    revisionCount: row.revision_count,
    dueDate: row.due_date,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ReportDto {
  readonly id: string;
  readonly organizationId: string;
  readonly engagementId: string | null;
  readonly serviceId: string | null;
  readonly title: string;
  readonly reportType: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: string;
  readonly currency: string | null;
  readonly summaryMd: string | null;
  readonly publishedAt: string | null;
  readonly publishedBy: string | null;
  readonly clientVisible: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toReportDto(row: {
  readonly id: string;
  readonly organization_id: string;
  readonly engagement_id: string | null;
  readonly service_id: string | null;
  readonly title: string;
  readonly report_type: string;
  readonly period_start: string;
  readonly period_end: string;
  readonly status: string;
  readonly currency: string | null;
  readonly summary_md: string | null;
  readonly published_at: string | null;
  readonly published_by: string | null;
  readonly client_visible: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}): ReportDto {
  return {
    id: row.id,
    organizationId: row.organization_id,
    engagementId: row.engagement_id,
    serviceId: row.service_id,
    title: row.title,
    reportType: row.report_type,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    currency: row.currency,
    summaryMd: row.summary_md,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    clientVisible: row.client_visible,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface MetricDto {
  readonly id: string;
  readonly organizationId: string;
  readonly serviceId: string | null;
  readonly serviceLine: string | null;
  readonly metricKey: string;
  readonly metricDate: string;
  readonly value: number;
  readonly unit: string;
  readonly currency: string | null;
  readonly source: string;
  readonly ingestedAt: string;
}

export function toMetricDto(row: {
  readonly id: string;
  readonly organization_id: string;
  readonly service_id: string | null;
  readonly service_line: string | null;
  readonly metric_key: string;
  readonly metric_date: string;
  readonly value: number;
  readonly unit: string;
  readonly currency: string | null;
  readonly source: string;
  readonly ingested_at: string;
}): MetricDto {
  return {
    id: row.id,
    organizationId: row.organization_id,
    serviceId: row.service_id,
    serviceLine: row.service_line,
    metricKey: row.metric_key,
    metricDate: row.metric_date,
    value: row.value,
    unit: row.unit,
    currency: row.currency,
    source: row.source,
    ingestedAt: row.ingested_at,
  };
}

export interface FileDto {
  readonly id: string;
  readonly organizationId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly fileKind: string;
  readonly clientVisible: boolean;
  readonly uploadedBy: string;
  readonly virusScanStatus: string;
  readonly projectId: string | null;
  readonly deliverableId: string | null;
  readonly taskId: string | null;
  readonly reportId: string | null;
  readonly commentId: string | null;
  readonly createdAt: string;
}

export function toFileDto(row: {
  readonly id: string;
  readonly organization_id: string;
  readonly file_name: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly file_kind: string;
  readonly client_visible: boolean;
  readonly uploaded_by: string;
  readonly virus_scan_status: string;
  readonly project_id: string | null;
  readonly deliverable_id: string | null;
  readonly task_id: string | null;
  readonly report_id: string | null;
  readonly comment_id: string | null;
  readonly created_at: string;
}): FileDto {
  return {
    id: row.id,
    organizationId: row.organization_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    fileKind: row.file_kind,
    clientVisible: row.client_visible,
    uploadedBy: row.uploaded_by,
    virusScanStatus: row.virus_scan_status,
    projectId: row.project_id,
    deliverableId: row.deliverable_id,
    taskId: row.task_id,
    reportId: row.report_id,
    commentId: row.comment_id,
    createdAt: row.created_at,
  };
}

export interface NotificationDto {
  readonly id: string;
  readonly organizationId: string | null;
  readonly notificationType: string;
  readonly severity: string;
  readonly title: string;
  readonly body: string | null;
  readonly subjectEntity: string | null;
  readonly subjectId: string | null;
  readonly actionUrl: string | null;
  readonly readAt: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
}

export function toNotificationDto(row: {
  readonly id: string;
  readonly organization_id: string | null;
  readonly notification_type: string;
  readonly severity: string;
  readonly title: string;
  readonly body: string | null;
  readonly subject_entity: string | null;
  readonly subject_id: string | null;
  readonly action_url: string | null;
  readonly read_at: string | null;
  readonly archived_at: string | null;
  readonly created_at: string;
}): NotificationDto {
  return {
    id: row.id,
    organizationId: row.organization_id,
    notificationType: row.notification_type,
    severity: row.severity,
    title: row.title,
    body: row.body,
    subjectEntity: row.subject_entity,
    subjectId: row.subject_id,
    actionUrl: row.action_url,
    readAt: row.read_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  };
}

export interface CommentDto {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly deliverableId: string | null;
  readonly taskId: string | null;
  readonly parentCommentId: string | null;
  readonly authorUserId: string;
  readonly body: string;
  readonly isInternal: boolean;
  readonly editedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toCommentDto(row: {
  readonly id: string;
  readonly organization_id: string;
  readonly project_id: string | null;
  readonly deliverable_id: string | null;
  readonly task_id: string | null;
  readonly parent_comment_id: string | null;
  readonly author_user_id: string;
  readonly body: string;
  readonly is_internal: boolean;
  readonly edited_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}): CommentDto {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    deliverableId: row.deliverable_id,
    taskId: row.task_id,
    parentCommentId: row.parent_comment_id,
    authorUserId: row.author_user_id,
    body: row.body,
    isInternal: row.is_internal,
    editedAt: row.edited_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ActivityDto {
  readonly occurredAt: string;
  readonly entityKind: string;
  readonly entityId: string;
  readonly action: string;
  readonly displayTitle?: string;
}

export interface StatusTransitionDto {
  readonly entityKind: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly allowedRoles: readonly string[];
  readonly requiresReason: boolean;
  readonly isTerminal: boolean;
  readonly description: string | null;
}

export function toStatusTransitionDto(row: {
  readonly entity_kind: string;
  readonly from_status: string;
  readonly to_status: string;
  readonly allowed_roles: string[];
  readonly requires_reason: boolean;
  readonly is_terminal: boolean;
  readonly description: string | null;
}): StatusTransitionDto {
  return {
    entityKind: row.entity_kind,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    allowedRoles: row.allowed_roles,
    requiresReason: row.requires_reason,
    isTerminal: row.is_terminal,
    description: row.description,
  };
}
