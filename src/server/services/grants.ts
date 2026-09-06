import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import type { PageResult } from '@/lib/types/pagination';
import { toPlatformGrantDto, type PlatformGrantDto } from '@/lib/dto/mappers';
import { ApiError } from '@/server/api/errors';
import { throwIfError } from '@/server/db/errors';
import { callRpc, callRpcVoid } from '@/server/db/rpc';
import { pageFromQuery, paginationMeta } from '@/server/api/page';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import type { Database } from '@/types/database';
import type { PaginationQuery } from '@/lib/validation/pagination';

type GrantRow = Database['public']['Tables']['platform_role_grants']['Row'];

export async function listGrants(input: {
  readonly query: PaginationQuery & { readonly userId?: string | undefined; readonly role?: string | undefined };
  readonly auth: AuthContext;
}): Promise<PageResult<PlatformGrantDto>> {
  if (input.auth.platformRole === 'ADMIN') {
    if (input.query.userId !== undefined && input.query.userId !== input.auth.userId) {
      throw ApiError.validation(
        [{ path: 'userId', code: 'forbidden', message: 'ADMIN may only read their own grant.' }],
        'The query string is invalid.',
      );
    }
    input = { ...input, query: { ...input.query, userId: input.auth.userId } };
  }
  const page = pageFromQuery(input.query, 'createdAt');
  const supabase = await createSupabaseServerClient();
  let q = supabase
    .from('platform_role_grants')
    .select('*')
    .is('revoked_at', null)
    .order('granted_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(page.limit + 1);
  if (input.query.userId !== undefined) {
    q = q.eq('user_id', input.query.userId);
  }
  if (input.query.role !== undefined) {
    q = q.eq('role', input.query.role as GrantRow['role']);
  }
  if (page.cursor !== null && page.cursor.key !== null) {
    q = q.or(
      `granted_at.lt.${page.cursor.key},and(granted_at.eq.${page.cursor.key},id.lt.${page.cursor.id})`,
    );
  }
  const { data, error } = await q;
  throwIfError(error, 'read');
  const rows = data ?? [];
  const hasMore = rows.length > page.limit;
  const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    data: pageRows.map(toPlatformGrantDto),
    pagination: paginationMeta({
      limit: page.limit,
      hasMore,
      sort: page.sort,
      next: hasMore && last !== undefined ? { key: last.granted_at, id: last.id } : null,
    }),
  };
}

export async function createGrant(input: {
  readonly userId: string;
  readonly role: GrantRow['role'];
  readonly reason: string;
  readonly expiresAt?: string | undefined;
}): Promise<PlatformGrantDto> {
  const id = await callRpc<string>('grant_platform_role', {
    p_user_id: input.userId,
    p_role: input.role,
    p_reason: input.reason,
    p_expires_at: input.expiresAt ?? null,
  });
  if (typeof id !== 'string') {
    throw ApiError.serviceUnavailable('The grant could not be created.');
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('platform_role_grants')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  throwIfError(error, 'read');
  if (data === null) {
    throw ApiError.notFound();
  }
  return toPlatformGrantDto(data);
}

export async function revokeGrant(input: {
  readonly userId: string;
  readonly reason: string;
}): Promise<void> {
  await callRpcVoid('revoke_platform_role', {
    p_user_id: input.userId,
    p_reason: input.reason,
  });
}
