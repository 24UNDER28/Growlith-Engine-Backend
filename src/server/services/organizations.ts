import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import type { PageResult } from '@/lib/types/pagination';
import {
  toOrganizationDto,
  toOrganizationSettingsDto,
  type OrganizationDto,
  type OrganizationSettingsDto,
} from '@/lib/dto/mappers';
import { ApiError } from '@/server/api/errors';
import { recordMutation } from '@/server/audit/mutation';
import { throwIfError } from '@/server/db/errors';
import { callRpcVoid } from '@/server/db/rpc';
import { actorStamp, listLive, loadLive, updateLive } from '@/server/services/crud';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import type { Database } from '@/types/database';
import type { PaginationQuery } from '@/lib/validation/pagination';

type OrgRow = Database['public']['Tables']['organizations']['Row'];
type SettingsRow = Database['public']['Tables']['organization_settings']['Row'];

export async function listOrganizations(input: {
  readonly query: PaginationQuery & {
    readonly q?: string | undefined;
    readonly status?: readonly string[] | undefined;
    readonly region?: readonly string[] | undefined;
  };
}): Promise<PageResult<OrganizationDto>> {
  const page = await listLive<OrgRow>({
    table: 'organizations',
    query: input.query,
    allowedSorts: ['createdAt'],
    apply: (q) => {
      let next = q;
      if (input.query.status !== undefined && input.query.status.length > 0) {
        next = next.in('status', [...input.query.status]);
      }
      if (input.query.region !== undefined && input.query.region.length > 0) {
        next = next.in('region', [...input.query.region]);
      }
      if (input.query.q !== undefined) {
        next = next.or(
          `legal_name.ilike.%${input.query.q}%,display_name.ilike.%${input.query.q}%,slug.ilike.%${input.query.q}%`,
        );
      }
      return next;
    },
  });
  return { data: page.data.map(toOrganizationDto), pagination: page.pagination };
}

export async function getOrganization(id: string): Promise<OrganizationDto> {
  const row = await loadLive<OrgRow>('organizations', id);
  return toOrganizationDto(row);
}

export async function createOrganization(input: {
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly slug: string;
    readonly legalName: string;
    readonly displayName: string;
    readonly region: OrgRow['region'];
    readonly industry?: string | undefined;
    readonly websiteUrl?: string | undefined;
    readonly primaryCurrency: OrgRow['primary_currency'];
    readonly accountManagerUserId?: string | undefined;
  };
}): Promise<OrganizationDto> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('organizations')
    .insert({
      slug: input.body.slug,
      legal_name: input.body.legalName,
      display_name: input.body.displayName,
      region: input.body.region,
      industry: input.body.industry ?? null,
      website_url: input.body.websiteUrl ?? null,
      primary_currency: input.body.primaryCurrency,
      account_manager_user_id: input.body.accountManagerUserId ?? null,
      ...actorStamp(input.auth),
    })
    .select('*')
    .single();
  throwIfError(error, 'write');
  if (data === null) {
    throw ApiError.serviceUnavailable('The organization could not be created.');
  }
  await recordMutation({
    action: 'CREATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'organization',
    entityId: data.id,
    organizationId: data.id,
    after: { slug: data.slug, legalName: data.legal_name },
  });
  return toOrganizationDto(data);
}

export async function patchOrganization(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly legalName?: string | undefined;
    readonly displayName?: string | undefined;
    readonly region?: OrgRow['region'] | undefined;
    readonly industry?: string | undefined;
    readonly websiteUrl?: string | undefined;
    readonly primaryCurrency?: OrgRow['primary_currency'] | undefined;
  };
}): Promise<OrganizationDto> {
  const before = await loadLive<OrgRow>('organizations', input.id);
  const patch: Record<string, unknown> = { updated_by: input.auth.userId };
  if (input.body.legalName !== undefined) patch.legal_name = input.body.legalName;
  if (input.body.displayName !== undefined) patch.display_name = input.body.displayName;
  if (input.body.region !== undefined) patch.region = input.body.region;
  if (input.body.industry !== undefined) patch.industry = input.body.industry;
  if (input.body.websiteUrl !== undefined) patch.website_url = input.body.websiteUrl;
  if (input.body.primaryCurrency !== undefined) patch.primary_currency = input.body.primaryCurrency;
  const updated = await updateLive<OrgRow>('organizations', input.id, patch);
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'organization',
    entityId: input.id,
    organizationId: input.id,
    changedFields: Object.keys(patch).filter((key) => key !== 'updated_by'),
    before: { legalName: before.legal_name, displayName: before.display_name },
    after: { legalName: updated.legal_name, displayName: updated.display_name },
  });
  return toOrganizationDto(updated);
}

export async function archiveOrganization(input: {
  readonly id: string;
  readonly reason: string;
  readonly confirmSlug: string;
}): Promise<void> {
  const row = await loadLive<OrgRow>('organizations', input.id);
  if (row.slug !== input.confirmSlug) {
    throw ApiError.conflict('confirmSlug does not match the organization slug.');
  }
  await callRpcVoid('archive_organization', {
    p_organization_id: input.id,
    p_reason: input.reason,
  });
}

const ORGANIZATION_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  PROSPECT: ['ONBOARDING'],
  ONBOARDING: ['ACTIVE'],
  ACTIVE: ['PAUSED', 'CHURNED'],
  PAUSED: ['ACTIVE', 'CHURNED'],
  CHURNED: ['ARCHIVED'],
};

export async function changeOrganizationStatus(input: {
  readonly id: string;
  readonly status: string;
  readonly reason?: string | undefined;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<OrganizationDto> {
  const row = await loadLive<OrgRow>('organizations', input.id);
  const allowed = ORGANIZATION_TRANSITIONS[row.status] ?? [];
  if (!allowed.includes(input.status)) {
    throw ApiError.conflict(`Cannot move organization from ${row.status} to ${input.status}.`);
  }
  if (
    (input.status === 'CHURNED' || input.status === 'ARCHIVED') &&
    (input.reason === undefined || input.reason.trim() === '')
  ) {
    throw ApiError.validation(
      [{ path: 'reason', code: 'required', message: 'reason is required for this transition.' }],
      'The request failed validation.',
    );
  }
  const extra: Record<string, unknown> = { updated_by: input.auth.userId, status: input.status };
  if (input.status === 'ACTIVE' && row.onboarded_at === null) {
    extra.onboarded_at = new Date().toISOString();
  }
  if (input.status === 'CHURNED') {
    extra.churned_at = new Date().toISOString();
  }
  const updated = await updateLive<OrgRow>('organizations', input.id, extra);
  await recordMutation({
    action: 'STATUS_CHANGE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'organization',
    entityId: input.id,
    organizationId: input.id,
    changedFields: ['status'],
    before: { status: row.status },
    after: { status: input.status },
    reason: input.reason,
  });
  return toOrganizationDto(updated);
}

export async function assignOrganizationManager(input: {
  readonly id: string;
  readonly accountManagerUserId: string | null;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<OrganizationDto> {
  const updated = await updateLive<OrgRow>('organizations', input.id, {
    account_manager_user_id: input.accountManagerUserId,
    updated_by: input.auth.userId,
  });
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'organization',
    entityId: input.id,
    organizationId: input.id,
    changedFields: ['account_manager_user_id'],
    after: { accountManagerUserId: input.accountManagerUserId },
  });
  return toOrganizationDto(updated);
}

export async function getOrganizationSettings(
  organizationId: string,
): Promise<OrganizationSettingsDto> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('organization_settings')
    .select('*')
    .eq('organization_id', organizationId)
    .maybeSingle();
  throwIfError(error, 'read');
  if (data === null) {
    throw ApiError.notFound();
  }
  return toOrganizationSettingsDto(data);
}

export async function putOrganizationSettings(input: {
  readonly organizationId: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly brandPrimaryColor: string | null;
    readonly logoFileId: string | null;
    readonly defaultReportCadence: SettingsRow['default_report_cadence'];
    readonly notifyOnDeliverableReady: boolean;
    readonly notifyOnReportPublished: boolean;
    readonly requireApprovalForPublish: boolean;
    readonly timezone: string;
  };
}): Promise<OrganizationSettingsDto> {
  const patch: Record<string, unknown> = {
    updated_by: input.auth.userId,
    brand_primary_color: input.body.brandPrimaryColor,
    logo_file_id: input.body.logoFileId,
    default_report_cadence: input.body.defaultReportCadence,
    notify_on_deliverable_ready: input.body.notifyOnDeliverableReady,
    notify_on_report_published: input.body.notifyOnReportPublished,
    require_approval_for_publish: input.body.requireApprovalForPublish,
    timezone: input.body.timezone,
  };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('organization_settings')
    .update(patch as never)
    .eq('organization_id', input.organizationId)
    .select('*')
    .maybeSingle();
  throwIfError(error, 'write');
  if (data === null) {
    throw ApiError.notFound();
  }
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'organization',
    entityId: input.organizationId,
    organizationId: input.organizationId,
    changedFields: [
      'brand_primary_color',
      'logo_file_id',
      'default_report_cadence',
      'notify_on_deliverable_ready',
      'notify_on_report_published',
      'require_approval_for_publish',
      'timezone',
    ],
  });
  return toOrganizationSettingsDto(data);
}

export async function patchOrganizationSettings(input: {
  readonly organizationId: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly brandPrimaryColor?: string | undefined;
    readonly logoFileId?: string | null | undefined;
    readonly defaultReportCadence?: SettingsRow['default_report_cadence'] | undefined;
    readonly notifyOnDeliverableReady?: boolean | undefined;
    readonly notifyOnReportPublished?: boolean | undefined;
    readonly requireApprovalForPublish?: boolean | undefined;
    readonly timezone?: string | undefined;
  };
}): Promise<OrganizationSettingsDto> {
  const patch: Record<string, unknown> = { updated_by: input.auth.userId };
  if (input.body.brandPrimaryColor !== undefined) {
    patch.brand_primary_color = input.body.brandPrimaryColor;
  }
  if (input.body.logoFileId !== undefined) patch.logo_file_id = input.body.logoFileId;
  if (input.body.defaultReportCadence !== undefined) {
    patch.default_report_cadence = input.body.defaultReportCadence;
  }
  if (input.body.notifyOnDeliverableReady !== undefined) {
    patch.notify_on_deliverable_ready = input.body.notifyOnDeliverableReady;
  }
  if (input.body.notifyOnReportPublished !== undefined) {
    patch.notify_on_report_published = input.body.notifyOnReportPublished;
  }
  if (input.body.requireApprovalForPublish !== undefined) {
    patch.require_approval_for_publish = input.body.requireApprovalForPublish;
  }
  if (input.body.timezone !== undefined) patch.timezone = input.body.timezone;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('organization_settings')
    .update(patch as never)
    .eq('organization_id', input.organizationId)
    .select('*')
    .maybeSingle();
  throwIfError(error, 'write');
  if (data === null) {
    throw ApiError.notFound();
  }
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'organization',
    entityId: input.organizationId,
    organizationId: input.organizationId,
    changedFields: Object.keys(patch).filter((key) => key !== 'updated_by'),
  });
  return toOrganizationSettingsDto(data);
}
