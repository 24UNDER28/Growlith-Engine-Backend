import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import type { PageResult } from '@/lib/types/pagination';
import { toMeDto, toProfileDto, type MeDto, type ProfileDto } from '@/lib/dto/mappers';
import { ApiError } from '@/server/api/errors';
import { recordMutation } from '@/server/audit/mutation';
import { throwIfError } from '@/server/db/errors';
import { callRpcVoid } from '@/server/db/rpc';
import { listLive, loadLive, updateLive } from '@/server/services/crud';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import { getSupabaseServiceClient } from '@/server/supabase/client-service';
import type { Database } from '@/types/database';
import type { PaginationQuery } from '@/lib/validation/pagination';

type ProfileRow = Database['public']['Tables']['profiles']['Row'];

export async function getMe(auth: AuthContext): Promise<MeDto> {
  const row = await loadLive<ProfileRow>('profiles', auth.userId);
  return toMeDto(auth, toProfileDto(row));
}

export async function patchMe(input: {
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly fullName?: string | undefined;
    readonly displayName?: string | undefined;
    readonly timezone?: string | undefined;
    readonly locale?: string | undefined;
    readonly avatarPath?: string | undefined;
  };
}): Promise<MeDto> {
  const patch: Record<string, unknown> = { updated_by: input.auth.userId };
  if (input.body.fullName !== undefined) patch.full_name = input.body.fullName;
  if (input.body.displayName !== undefined) patch.display_name = input.body.displayName;
  if (input.body.timezone !== undefined) patch.timezone = input.body.timezone;
  if (input.body.locale !== undefined) patch.locale = input.body.locale;
  if (input.body.avatarPath !== undefined) patch.avatar_path = input.body.avatarPath;
  const updated = await updateLive<ProfileRow>('profiles', input.auth.userId, patch);
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'profile',
    entityId: input.auth.userId,
    changedFields: Object.keys(patch).filter((key) => key !== 'updated_by'),
  });
  return toMeDto(input.auth, toProfileDto(updated));
}

export async function listUsers(input: {
  readonly auth: AuthContext;
  readonly query: PaginationQuery & {
    readonly q?: string | undefined;
    readonly organizationId?: string | undefined;
    readonly status?: readonly string[] | undefined;
    readonly userType?: string | undefined;
    readonly team?: readonly string[] | undefined;
    readonly ids?: readonly string[] | undefined;
  };
}): Promise<PageResult<ProfileDto>> {
  // B-3: a client's directory is its organization's co-members plus staff
  // identities on its work — and the client may not filter that directory by
  // staff-only axes (account status, userType, team, free-text search) any
  // more than it may see those columns. Such a filter on a client call would
  // be an enumeration oracle for staff presence and staff account states,
  // which the client audience shape (§F.1) exists to hide. Answer 422, the
  // same as any field the client's contract does not carry.
  if (input.auth.userType === 'CLIENT') {
    const staffOnly = [
      { key: 'q', value: input.query.q },
      { key: 'status', value: input.query.status },
      { key: 'userType', value: input.query.userType },
      { key: 'team', value: input.query.team },
    ].find((entry) => entry.value !== undefined);
    if (staffOnly !== undefined) {
      throw ApiError.validation(
        [
          {
            path: staffOnly.key,
            code: 'custom',
            message: 'This filter is available to staff directory reads only.',
          },
        ],
        'The query string is invalid.',
      );
    }
  }
  let idFilter: string[] | null = null;
  const supabase = await createSupabaseServerClient();

  if (input.query.ids !== undefined && input.query.ids.length > 0) {
    // By-id directory lookup (`?ids=…`): the caller names the profiles, RLS
    // decides which of them are visible. Deliberately NOT intersected with
    // the organization roster below — a client resolving the staff identities
    // attached to its own work (account managers, leads) names ids that are
    // visible through RLS but have no organization_memberships row.
    idFilter = [...new Set(input.query.ids)];
  } else if (input.query.organizationId !== undefined) {
    const { data, error } = await supabase
      .from('organization_memberships')
      .select('user_id')
      .eq('organization_id', input.query.organizationId)
      .is('deleted_at', null);
    throwIfError(error, 'read');
    idFilter = [...new Set((data ?? []).map((row) => row.user_id))];
    if (idFilter.length === 0) {
      return emptyPage(input.query);
    }
  }
  if (input.query.team !== undefined && input.query.team.length > 0) {
    const { data, error } = await supabase
      .from('staff_team_memberships')
      .select('user_id')
      .in('team', [...input.query.team] as Database['public']['Enums']['team'][])
      .is('deleted_at', null);
    throwIfError(error, 'read');
    const teamIds = new Set((data ?? []).map((row) => row.user_id));
    idFilter = idFilter === null ? [...teamIds] : idFilter.filter((id) => teamIds.has(id));
    if (idFilter.length === 0) {
      return emptyPage(input.query);
    }
  }

  const page = await listLive<ProfileRow>({
    table: 'profiles',
    query: input.query,
    allowedSorts: ['createdAt'],
    apply: (q) => {
      let next = q;
      if (idFilter !== null) {
        next = next.in('id', idFilter);
      }
      if (input.query.status !== undefined && input.query.status.length > 0) {
        next = next.in('account_status', [...input.query.status]);
      }
      if (input.query.userType !== undefined) {
        next = next.eq('user_type', input.query.userType);
      }
      if (input.query.q !== undefined) {
        next = next.or(
          `full_name.ilike.%${input.query.q}%,email.ilike.%${input.query.q}%`,
        );
      }
      return next;
    },
  });
  return { data: page.data.map(toProfileDto), pagination: page.pagination };
}

export async function getUser(userId: string): Promise<ProfileDto> {
  const row = await loadLive<ProfileRow>('profiles', userId);
  return toProfileDto(row);
}

export async function patchUser(input: {
  readonly userId: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly fullName?: string | undefined;
    readonly displayName?: string | undefined;
    readonly timezone?: string | undefined;
    readonly locale?: string | undefined;
    readonly avatarPath?: string | undefined;
  };
}): Promise<ProfileDto> {
  if (input.auth.platformRole === 'ADMIN') {
    // ADMIN may not alter a SUPER_ADMIN's account ([R] on user:update).
    const target = await loadLive<ProfileRow>('profiles', input.userId);
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase
      .from('platform_role_grants')
      .select('role')
      .eq('user_id', target.id)
      .is('revoked_at', null)
      .maybeSingle();
    if (data?.role === 'SUPER_ADMIN') {
      throw ApiError.forbidden();
    }
  }
  const patch: Record<string, unknown> = { updated_by: input.auth.userId };
  if (input.body.fullName !== undefined) patch.full_name = input.body.fullName;
  if (input.body.displayName !== undefined) patch.display_name = input.body.displayName;
  if (input.body.timezone !== undefined) patch.timezone = input.body.timezone;
  if (input.body.locale !== undefined) patch.locale = input.body.locale;
  if (input.body.avatarPath !== undefined) patch.avatar_path = input.body.avatarPath;
  const updated = await updateLive<ProfileRow>('profiles', input.userId, patch);
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'profile',
    entityId: input.userId,
    changedFields: Object.keys(patch).filter((key) => key !== 'updated_by'),
  });
  return toProfileDto(updated);
}

export async function eraseUser(input: { readonly userId: string; readonly reason: string }): Promise<void> {
  // Last-SUPER_ADMIN lockout: the RPC tombstones grants without this floor.
  // JUSTIFIED: ADMIN cannot SELECT the grant roster; the check must see every
  // live SUPER_ADMIN row.
  const service = getSupabaseServiceClient();
  const { data: grants, error } = await service
    .from('platform_role_grants')
    .select('user_id, role')
    .eq('role', 'SUPER_ADMIN')
    .is('revoked_at', null);
  throwIfError(error, 'read');
  const live = (grants ?? []).map((row) => row.user_id);
  if (live.length === 1 && live[0] === input.userId) {
    throw ApiError.conflict('Erasing the last SUPER_ADMIN would lock the platform.');
  }
  await callRpcVoid('erase_user', { p_user_id: input.userId, p_reason: input.reason });
}

function emptyPage(query: PaginationQuery): PageResult<ProfileDto> {
  return {
    data: [],
    pagination: {
      limit: query.limit ?? 25,
      hasMore: false,
      nextCursor: null,
    },
  };
}
