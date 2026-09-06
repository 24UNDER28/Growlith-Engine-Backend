import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import type { PageResult } from '@/lib/types/pagination';
import { commentEditWindowOpen } from '@/lib/domain/state-machines';
import { toCommentDto, type CommentDto } from '@/lib/dto/mappers';
import { ApiError } from '@/server/api/errors';
import { recordMutation } from '@/server/audit/mutation';
import { throwIfError } from '@/server/db/errors';
import { actorStamp, listLive, loadLive, softDeleteLive, updateLive } from '@/server/services/crud';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import { toValidationIssues } from '@/lib/validation/format';
import { clientCreateCommentBodySchema } from '@/lib/validation/resources';
import type { Database } from '@/types/database';
import type { PaginationQuery } from '@/lib/validation/pagination';

type Row = Database['public']['Tables']['comments']['Row'];

export async function resolveCommentSubjectTenant(input: {
  readonly projectId?: string | undefined;
  readonly deliverableId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly organizationId?: string | undefined;
}): Promise<string | null> {
  const subjects: Array<readonly ['projects' | 'deliverables' | 'tasks', string]> = [];
  if (input.projectId !== undefined) subjects.push(['projects', input.projectId]);
  if (input.deliverableId !== undefined) subjects.push(['deliverables', input.deliverableId]);
  if (input.taskId !== undefined) subjects.push(['tasks', input.taskId]);
  if (subjects.length !== 1) {
    throw ApiError.validation(
      [
        {
          path: '(root)',
          code: 'subject_required',
          message: 'Exactly one of projectId, deliverableId or taskId is required.',
        },
      ],
      'The query string is invalid.',
    );
  }
  const [table, id] = subjects[0]!;
  const parent = await loadLive<{ organization_id: string }>(table, id);
  return parent.organization_id;
}

export async function listComments(input: {
  readonly query: PaginationQuery & {
    readonly organizationId?: string | undefined;
    readonly projectId?: string | undefined;
    readonly deliverableId?: string | undefined;
    readonly taskId?: string | undefined;
  };
}): Promise<PageResult<CommentDto>> {
  const page = await listLive<Row>({
    table: 'comments',
    query: input.query,
    allowedSorts: ['createdAt'],
    apply: (q) => {
      let next = q;
      if (input.query.organizationId !== undefined) next = next.eq('organization_id', input.query.organizationId);
      if (input.query.projectId !== undefined) next = next.eq('project_id', input.query.projectId);
      if (input.query.deliverableId !== undefined) next = next.eq('deliverable_id', input.query.deliverableId);
      if (input.query.taskId !== undefined) next = next.eq('task_id', input.query.taskId);
      return next;
    },
  });
  return { data: page.data.map(toCommentDto), pagination: page.pagination };
}

export async function getComment(id: string): Promise<CommentDto> {
  return toCommentDto(await loadLive<Row>('comments', id));
}

export async function createComment(input: {
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly projectId?: string | undefined;
    readonly deliverableId?: string | undefined;
    readonly taskId?: string | undefined;
    readonly parentCommentId?: string | undefined;
    readonly body: string;
    readonly isInternal?: boolean | undefined;
  };
}): Promise<CommentDto> {
  if (input.auth.userType === 'CLIENT') {
    const parsed = clientCreateCommentBodySchema.safeParse(input.body);
    if (!parsed.success) {
      throw ApiError.validation(toValidationIssues(parsed.error.issues));
    }
  }
  const subjects = [input.body.projectId, input.body.deliverableId, input.body.taskId].filter(
    (value) => value !== undefined,
  );
  if (subjects.length !== 1) {
    throw ApiError.validation([
      { path: '(root)', code: 'custom', message: 'Exactly one of projectId, deliverableId or taskId is required.' },
    ]);
  }
  const table = input.body.projectId
    ? 'projects'
    : input.body.deliverableId
      ? 'deliverables'
      : 'tasks';
  const subjectId = (input.body.projectId ?? input.body.deliverableId ?? input.body.taskId) as string;
  const parent = await loadLive<{ organization_id: string }>(table, subjectId);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('comments')
    .insert({
      organization_id: parent.organization_id,
      project_id: input.body.projectId ?? null,
      deliverable_id: input.body.deliverableId ?? null,
      task_id: input.body.taskId ?? null,
      parent_comment_id: input.body.parentCommentId ?? null,
      author_user_id: input.auth.userId,
      body: input.body.body,
      is_internal: input.auth.userType === 'CLIENT' ? false : (input.body.isInternal ?? false),
      ...actorStamp(input.auth),
    })
    .select('*')
    .single();
  throwIfError(error, 'write');
  if (data === null) throw ApiError.serviceUnavailable('The comment could not be created.');
  await recordMutation({
    action: 'CREATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'comment',
    entityId: data.id,
    organizationId: data.organization_id,
  });
  return toCommentDto(data);
}

export async function patchComment(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: string;
}): Promise<CommentDto> {
  const existing = await loadLive<Row>('comments', input.id);
  const isAuthor = existing.author_user_id === input.auth.userId;
  const isSuper = input.auth.platformRole === 'SUPER_ADMIN';
  if (!isAuthor && !isSuper) {
    throw ApiError.forbidden();
  }
  if (isAuthor && !isSuper && !commentEditWindowOpen(existing.created_at)) {
    throw ApiError.forbidden();
  }
  const updated = await updateLive<Row>('comments', input.id, {
    body: input.body,
    edited_at: new Date().toISOString(),
    updated_by: input.auth.userId,
  });
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'comment',
    entityId: input.id,
    organizationId: updated.organization_id,
    changedFields: ['body'],
  });
  return toCommentDto(updated);
}

export async function deleteComment(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<void> {
  const existing = await loadLive<Row>('comments', input.id);
  const isAuthor = existing.author_user_id === input.auth.userId;
  const isStaffActor = input.auth.platformRole !== null;
  if (!isAuthor && !isStaffActor) {
    throw ApiError.forbidden();
  }
  await softDeleteLive('comments', input.id, input.auth.userId);
  await recordMutation({
    action: 'SOFT_DELETE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'comment',
    entityId: input.id,
    organizationId: existing.organization_id,
  });
}

export async function commentAuthorForGuard(id: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('comments')
    .select('author_user_id')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error !== null) {
    throw ApiError.serviceUnavailable('The comment could not be inspected.');
  }
  return data?.author_user_id ?? null;
}
