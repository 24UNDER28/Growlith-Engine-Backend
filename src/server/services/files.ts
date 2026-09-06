import 'server-only';

import { randomUUID } from 'node:crypto';

import type { AuthContext } from '@/lib/auth/context';
import type { PageResult } from '@/lib/types/pagination';
import { toFileDto, type FileDto } from '@/lib/dto/mappers';
import { ApiError } from '@/server/api/errors';
import { recordMutation } from '@/server/audit/mutation';
import { throwIfError } from '@/server/db/errors';
import { actorStamp, listLive, loadLive, softDeleteLive, updateLive } from '@/server/services/crud';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import type { Database } from '@/types/database';
import type { PaginationQuery } from '@/lib/validation/pagination';

type Row = Database['public']['Tables']['files']['Row'];

const BUCKET = 'growlith-private';

function sanitizeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 180);
}

export async function listFiles(input: {
  readonly query: PaginationQuery & {
    readonly organizationId?: string | undefined;
    readonly projectId?: string | undefined;
    readonly deliverableId?: string | undefined;
    readonly taskId?: string | undefined;
    readonly reportId?: string | undefined;
  };
}): Promise<PageResult<FileDto>> {
  const page = await listLive<Row>({
    table: 'files',
    query: input.query,
    allowedSorts: ['createdAt'],
    apply: (q) => {
      let next = q;
      if (input.query.organizationId !== undefined) next = next.eq('organization_id', input.query.organizationId);
      if (input.query.projectId !== undefined) next = next.eq('project_id', input.query.projectId);
      if (input.query.deliverableId !== undefined) next = next.eq('deliverable_id', input.query.deliverableId);
      if (input.query.taskId !== undefined) next = next.eq('task_id', input.query.taskId);
      if (input.query.reportId !== undefined) next = next.eq('report_id', input.query.reportId);
      return next;
    },
  });
  return { data: page.data.map(toFileDto), pagination: page.pagination };
}

export async function getFile(id: string): Promise<FileDto> {
  return toFileDto(await loadLive<Row>('files', id));
}

export type FileParentInput = {
  readonly organizationId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly deliverableId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly reportId?: string | undefined;
  readonly commentId?: string | undefined;
};

export async function resolveFileParentTenant(body: FileParentInput): Promise<string | null> {
  const parents: Array<readonly ['projects' | 'deliverables' | 'tasks' | 'reports' | 'comments', string]> =
    [];
  if (body.projectId !== undefined) parents.push(['projects', body.projectId]);
  if (body.deliverableId !== undefined) parents.push(['deliverables', body.deliverableId]);
  if (body.taskId !== undefined) parents.push(['tasks', body.taskId]);
  if (body.reportId !== undefined) parents.push(['reports', body.reportId]);
  if (body.commentId !== undefined) parents.push(['comments', body.commentId]);
  if (parents.length > 1) {
    throw ApiError.validation([
      { path: '(root)', code: 'custom', message: 'A file may have at most one parent.' },
    ]);
  }
  if (parents.length === 1) {
    const [table, id] = parents[0]!;
    const parent = await loadLive<{ organization_id: string }>(table, id);
    return parent.organization_id;
  }
  return body.organizationId ?? null;
}

export async function mintUploadUrl(input: FileParentInput & {
  readonly fileName: string;
  readonly mimeType: string;
}): Promise<{
  readonly storagePath: string;
  readonly uploadUrl: string;
  readonly token: string;
  readonly expiresAt: string;
}> {
  const organizationId = await resolveFileParentTenant(input);
  if (organizationId === null) {
    throw ApiError.validation([
      { path: 'organizationId', code: 'required', message: 'A parent or organizationId is required.' },
    ]);
  }
  const storagePath = `${organizationId}/attachment/${randomUUID()}/${sanitizeFileName(input.fileName)}`;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(storagePath);
  if (error !== null || data === null) {
    throw ApiError.serviceUnavailable('A signed upload URL could not be minted.');
  }
  return {
    storagePath,
    uploadUrl: data.signedUrl,
    token: data.token,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

export async function registerFile(input: {
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly organizationId?: string | undefined;
    readonly fileName: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly storagePath: string;
    readonly fileKind?: Row['file_kind'] | undefined;
    readonly projectId?: string | undefined;
    readonly deliverableId?: string | undefined;
    readonly taskId?: string | undefined;
    readonly reportId?: string | undefined;
    readonly commentId?: string | undefined;
    readonly clientVisible?: boolean | undefined;
  };
}): Promise<FileDto> {
  const organizationId = await resolveFileParentTenant(input.body);
  if (organizationId === null) {
    throw ApiError.validation([
      { path: 'organizationId', code: 'required', message: 'A parent or organizationId is required.' },
    ]);
  }
  if (!input.body.storagePath.startsWith(`${organizationId}/`)) {
    throw ApiError.validation(
      [
        {
          path: 'storagePath',
          code: 'custom',
          message: 'storagePath must begin with the organization id.',
        },
      ],
    );
  }
  const owners = [
    input.body.projectId,
    input.body.deliverableId,
    input.body.taskId,
    input.body.reportId,
    input.body.commentId,
  ].filter((value) => value !== undefined);
  if (owners.length > 1) {
    throw ApiError.validation([
      { path: '(root)', code: 'custom', message: 'A file may have at most one owner.' },
    ]);
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('files')
    .insert({
      organization_id: organizationId,
      storage_bucket: BUCKET,
      storage_path: input.body.storagePath,
      file_name: input.body.fileName,
      mime_type: input.body.mimeType,
      size_bytes: input.body.sizeBytes,
      file_kind: input.body.fileKind ?? 'ATTACHMENT',
      client_visible: input.body.clientVisible ?? false,
      uploaded_by: input.auth.userId,
      project_id: input.body.projectId ?? null,
      deliverable_id: input.body.deliverableId ?? null,
      task_id: input.body.taskId ?? null,
      report_id: input.body.reportId ?? null,
      comment_id: input.body.commentId ?? null,
      ...actorStamp(input.auth),
    })
    .select('*')
    .single();
  throwIfError(error, 'write');
  if (data === null) throw ApiError.serviceUnavailable('The file could not be registered.');
  await recordMutation({
    action: 'CREATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'attachment',
    entityId: data.id,
    organizationId: data.organization_id,
    after: { fileName: data.file_name },
  });
  return toFileDto(data);
}

export async function patchFile(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: { readonly fileName?: string | undefined; readonly fileKind?: Row['file_kind'] | undefined; readonly clientVisible?: boolean | undefined };
}): Promise<FileDto> {
  const existing = await loadLive<Row>('files', input.id);
  if (input.auth.platformRole === null && existing.uploaded_by !== input.auth.userId) {
    throw ApiError.forbidden();
  }
  // L-6: `clientVisible` is not a field of the CLIENT PATCH contract. A
  // client flipping its own upload to client-visible after its parent became
  // visible would publish an internal-attachment to the whole client audience
  // — the very flag the staff-only PATCH field exists to gate.
  if (input.auth.platformRole === null && input.body.clientVisible !== undefined) {
    throw ApiError.validation(
      [
        {
          path: 'clientVisible',
          code: 'custom',
          message: 'clientVisible is not available in this request.',
        },
      ],
      'The request failed validation.',
    );
  }
  const patch: Record<string, unknown> = { updated_by: input.auth.userId };
  if (input.body.fileName !== undefined) patch.file_name = input.body.fileName;
  if (input.body.fileKind !== undefined) patch.file_kind = input.body.fileKind;
  if (input.body.clientVisible !== undefined) patch.client_visible = input.body.clientVisible;
  const updated = await updateLive<Row>('files', input.id, patch);
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'attachment',
    entityId: input.id,
    organizationId: updated.organization_id,
    changedFields: Object.keys(patch).filter((key) => key !== 'updated_by'),
  });
  return toFileDto(updated);
}

export async function deleteFile(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<void> {
  const existing = await loadLive<Row>('files', input.id);
  if (input.auth.platformRole === null && existing.uploaded_by !== input.auth.userId) {
    throw ApiError.forbidden();
  }
  await softDeleteLive('files', input.id, input.auth.userId);
  await recordMutation({
    action: 'SOFT_DELETE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'attachment',
    entityId: input.id,
    organizationId: existing.organization_id,
  });
}

export async function downloadFile(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<{ readonly url: string; readonly expiresIn: number }> {
  const row = await loadLive<Row>('files', input.id);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(row.storage_path, 60);
  if (error !== null || data === null) {
    throw ApiError.serviceUnavailable('A signed download URL could not be minted.');
  }
  await recordMutation({
    action: 'FILE_DOWNLOAD',
    severity: 'NOTICE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'attachment',
    entityId: input.id,
    organizationId: row.organization_id,
  });
  return { url: data.signedUrl, expiresIn: 60 };
}
