import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import type { PageResult } from '@/lib/types/pagination';
import { toMetricDto, toReportDto, type MetricDto, type ReportDto } from '@/lib/dto/mappers';
import { ApiError } from '@/server/api/errors';
import { recordMutation } from '@/server/audit/mutation';
import { throwIfError } from '@/server/db/errors';
import { callRpcVoid } from '@/server/db/rpc';
import {
  actorStamp,
  listLive,
  loadLive,
  requireParentId,
  softDeleteLive,
  updateLive,
} from '@/server/services/crud';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import type { Database } from '@/types/database';
import type { PaginationQuery } from '@/lib/validation/pagination';

type Row = Database['public']['Tables']['reports']['Row'];
type ReportMetricRow = Database['public']['Tables']['report_metrics']['Row'];

export async function listReports(input: {
  readonly query: PaginationQuery & {
    readonly organizationId?: string | undefined;
    readonly engagementId?: string | undefined;
    readonly serviceId?: string | undefined;
    readonly status?: readonly string[] | undefined;
  };
}): Promise<PageResult<ReportDto>> {
  const page = await listLive<Row>({
    table: 'reports',
    query: input.query,
    allowedSorts: ['createdAt'],
    apply: (q) => {
      let next = q;
      if (input.query.organizationId !== undefined) next = next.eq('organization_id', input.query.organizationId);
      if (input.query.engagementId !== undefined) next = next.eq('engagement_id', input.query.engagementId);
      if (input.query.serviceId !== undefined) next = next.eq('service_id', input.query.serviceId);
      if (input.query.status !== undefined && input.query.status.length > 0) {
        next = next.in('status', [...input.query.status]);
      }
      return next;
    },
    keyOf: (row) => row.created_at,
  });
  return { data: page.data.map(toReportDto), pagination: page.pagination };
}

export async function getReport(id: string): Promise<ReportDto> {
  return toReportDto(await loadLive<Row>('reports', id));
}

export async function getReportWithMetrics(id: string): Promise<
  ReportDto & {
    readonly metrics: readonly {
      readonly metricKey: string;
      readonly value: number;
      readonly unit: string;
      readonly currency: string | null;
      readonly comparisonValue: number | null;
      readonly comparisonLabel: string | null;
      readonly sortOrder: number;
    }[];
  }
> {
  const report = await getReport(id);
  const rows = report.status === 'PUBLISHED' ? await listReportMetrics(id) : [];
  return {
    ...report,
    metrics: rows.map((row) => ({
      metricKey: row.metric_key,
      value: row.value,
      unit: row.unit,
      currency: row.currency,
      comparisonValue: row.comparison_value,
      comparisonLabel: row.comparison_label,
      sortOrder: row.sort_order,
    })),
  };
}

export async function downloadReportExport(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<{ readonly downloadUrl: string; readonly expiresAt: string }> {
  const report = await loadLive<Row>('reports', input.id);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('files')
    .select('id, storage_path, storage_bucket')
    .eq('report_id', input.id)
    .eq('file_kind', 'REPORT_EXPORT')
    .is('deleted_at', null)
    .maybeSingle();
  throwIfError(error, 'read');
  if (data === null) {
    throw ApiError.notFound();
  }
  const signed = await supabase.storage.from(data.storage_bucket).createSignedUrl(data.storage_path, 60);
  if (signed.error !== null || signed.data === null) {
    throw ApiError.serviceUnavailable('A signed download URL could not be minted.');
  }
  await recordMutation({
    action: 'EXPORT',
    severity: 'NOTICE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'report',
    entityId: input.id,
    organizationId: report.organization_id,
  });
  return {
    downloadUrl: signed.data.signedUrl,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

export async function createReport(input: {
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly organizationId?: string | undefined;
    readonly engagementId?: string | undefined;
    readonly serviceId?: string | undefined;
    readonly title: string;
    readonly reportType: Row['report_type'];
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly currency?: Row['currency'] | undefined;
    readonly summaryMd?: string | undefined;
  };
}): Promise<ReportDto> {
  const organizationId = requireParentId(input.body.organizationId, 'organizationId');
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('reports')
    .insert({
      organization_id: organizationId,
      engagement_id: input.body.engagementId ?? null,
      service_id: input.body.serviceId ?? null,
      title: input.body.title,
      report_type: input.body.reportType,
      period_start: input.body.periodStart,
      period_end: input.body.periodEnd,
      currency: input.body.currency ?? null,
      summary_md: input.body.summaryMd ?? null,
      ...actorStamp(input.auth),
    })
    .select('*')
    .single();
  throwIfError(error, 'write');
  if (data === null) throw ApiError.serviceUnavailable('The report could not be created.');
  await recordMutation({
    action: 'CREATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'report',
    entityId: data.id,
    organizationId: data.organization_id,
    after: { title: data.title },
  });
  return toReportDto(data);
}

export async function patchReport(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: Record<string, unknown>;
}): Promise<ReportDto> {
  const existing = await loadLive<Row>('reports', input.id);
  if (existing.status === 'PUBLISHED') {
    throw ApiError.conflict('A published report cannot be edited.');
  }
  const map: Record<string, string> = {
    title: 'title',
    reportType: 'report_type',
    periodStart: 'period_start',
    periodEnd: 'period_end',
    currency: 'currency',
    summaryMd: 'summary_md',
  };
  const patch: Record<string, unknown> = { updated_by: input.auth.userId };
  for (const [from, to] of Object.entries(map)) {
    if (input.body[from] !== undefined) patch[to] = input.body[from];
  }
  const updated = await updateLive<Row>('reports', input.id, patch);
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'report',
    entityId: input.id,
    organizationId: updated.organization_id,
    changedFields: Object.keys(patch).filter((key) => key !== 'updated_by'),
  });
  return toReportDto(updated);
}

export async function deleteReport(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<void> {
  const row = await loadLive<Row>('reports', input.id);
  await softDeleteLive('reports', input.id, input.auth.userId);
  await recordMutation({
    action: 'SOFT_DELETE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'report',
    entityId: input.id,
    organizationId: row.organization_id,
  });
}

export async function publishReport(input: {
  readonly id: string;
  readonly clientVisible?: boolean | undefined;
}): Promise<ReportDto> {
  await callRpcVoid('publish_report', {
    p_report_id: input.id,
    p_client_visible: input.clientVisible ?? true,
  });
  return getReport(input.id);
}

export async function listReportMetrics(id: string): Promise<readonly ReportMetricRow[]> {
  await loadLive<Row>('reports', id);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('report_metrics')
    .select('*')
    .eq('report_id', id)
    .order('sort_order');
  throwIfError(error, 'read');
  return data ?? [];
}

export async function exportReport(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<{ readonly report: ReportDto; readonly metrics: readonly ReportMetricRow[] }> {
  const report = await getReport(input.id);
  const metrics = await listReportMetrics(input.id);
  await recordMutation({
    action: 'EXPORT',
    severity: 'NOTICE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'report',
    entityId: input.id,
    organizationId: report.organizationId,
  });
  return { report, metrics };
}

export async function listMetrics(input: {
  readonly query: PaginationQuery & {
    readonly organizationId?: string | undefined;
    readonly serviceId?: string | undefined;
    readonly metricKey?: readonly string[] | undefined;
    readonly from?: string | undefined;
    readonly to?: string | undefined;
  };
}): Promise<PageResult<MetricDto>> {
  const page = await listLive<{
    id: string;
    organization_id: string;
    service_id: string | null;
    service_line: string | null;
    metric_key: string;
    metric_date: string;
    value: number;
    unit: string;
    currency: string | null;
    source: string;
    ingested_at: string;
    created_at: string;
  }>({
    table: 'metrics',
    query: input.query,
    live: false,
    allowedSorts: ['createdAt', 'metricDate'],
    apply: (q) => {
      let next = q;
      if (input.query.organizationId !== undefined) next = next.eq('organization_id', input.query.organizationId);
      if (input.query.serviceId !== undefined) next = next.eq('service_id', input.query.serviceId);
      if (input.query.metricKey !== undefined && input.query.metricKey.length > 0) {
        next = next.in('metric_key', [...input.query.metricKey]);
      }
      if (input.query.from !== undefined) next = next.gte('metric_date', input.query.from);
      if (input.query.to !== undefined) next = next.lte('metric_date', input.query.to);
      return next;
    },
    keyOf: (row) => row.created_at,
  });
  return { data: page.data.map(toMetricDto), pagination: page.pagination };
}

export async function getMetric(id: string): Promise<MetricDto> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from('metrics').select('*').eq('id', id).maybeSingle();
  throwIfError(error, 'read');
  if (data === null) throw ApiError.notFound();
  return toMetricDto(data);
}

export async function createMetric(input: {
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly organizationId: string;
    readonly serviceId?: string | undefined;
    readonly serviceLine?: Database['public']['Enums']['service_line'] | undefined;
    readonly metricKey: Database['public']['Enums']['metric_key'];
    readonly metricDate: string;
    readonly value: number;
    readonly unit: Database['public']['Enums']['metric_unit'];
    readonly currency?: Database['public']['Enums']['currency_code'] | undefined;
    readonly source?: Database['public']['Enums']['metric_source'] | undefined;
    readonly sourceRef?: string | undefined;
  };
}): Promise<MetricDto> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('metrics')
    .insert({
      organization_id: input.body.organizationId,
      service_id: input.body.serviceId ?? null,
      service_line: input.body.serviceLine ?? null,
      metric_key: input.body.metricKey,
      metric_date: input.body.metricDate,
      value: input.body.value,
      unit: input.body.unit,
      currency: input.body.currency ?? null,
      source: input.body.source ?? 'MANUAL',
      source_ref: input.body.sourceRef ?? null,
      created_by: input.auth.userId,
    })
    .select('*')
    .single();
  throwIfError(error, 'write');
  if (data === null) throw ApiError.serviceUnavailable('The metric could not be created.');
  await recordMutation({
    action: 'CREATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'metric',
    entityId: data.id,
    organizationId: data.organization_id,
    after: { metricKey: data.metric_key, value: data.value },
  });
  return toMetricDto(data);
}
