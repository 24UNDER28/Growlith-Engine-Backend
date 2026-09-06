import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import type { PageResult } from '@/lib/types/pagination';
import { toTeamMembershipDto, type TeamMembershipDto } from '@/lib/dto/mappers';
import { ApiError } from '@/server/api/errors';
import { recordMutation } from '@/server/audit/mutation';
import { throwIfError } from '@/server/db/errors';
import { actorStamp, listLive, loadLive, softDeleteLive, updateLive } from '@/server/services/crud';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import type { Database } from '@/types/database';
import type { PaginationQuery } from '@/lib/validation/pagination';

type TeamRow = Database['public']['Tables']['teams']['Row'];
type TeamMembershipRow = Database['public']['Tables']['staff_team_memberships']['Row'];

export async function listTeams(): Promise<
  readonly {
    readonly team: string;
    readonly label: string;
    readonly isActive: boolean;
    readonly memberCount: number;
    readonly leads: readonly string[];
  }[]
> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('teams')
    .select('code, label, is_active')
    .order('sort_order');
  throwIfError(error, 'read');
  const { data: members, error: memberError } = await supabase
    .from('staff_team_memberships')
    .select('user_id, team, is_lead')
    .is('deleted_at', null);
  throwIfError(memberError, 'read');
  const byTeam = new Map<string, { count: number; leads: string[] }>();
  for (const row of members ?? []) {
    const current = byTeam.get(row.team) ?? { count: 0, leads: [] };
    current.count += 1;
    if (row.is_lead) current.leads.push(row.user_id);
    byTeam.set(row.team, current);
  }
  return (data ?? []).map((row) => {
    const stats = byTeam.get(row.code) ?? { count: 0, leads: [] };
    return {
      team: row.code,
      label: row.label,
      isActive: row.is_active,
      memberCount: stats.count,
      leads: stats.leads,
    };
  });
}

export async function listTeamMemberships(input: {
  readonly query: PaginationQuery & {
    readonly userId?: string | undefined;
    readonly team?: readonly string[] | undefined;
  };
}): Promise<PageResult<TeamMembershipDto>> {
  const page = await listLive<TeamMembershipRow>({
    table: 'staff_team_memberships',
    query: input.query,
    allowedSorts: ['createdAt'],
    // C-14: join order, earliest first.
    ascendingKeys: ['createdAt'],
    apply: (q) => {
      let next = q;
      if (input.query.userId !== undefined) {
        next = next.eq('user_id', input.query.userId);
      }
      if (input.query.team !== undefined && input.query.team.length > 0) {
        next = next.in('team', [...input.query.team]);
      }
      return next;
    },
  });
  return { data: page.data.map(toTeamMembershipDto), pagination: page.pagination };
}

export async function createTeamMembership(input: {
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly userId: string;
    readonly team: TeamMembershipRow['team'];
    readonly isLead?: boolean | undefined;
    readonly allocationPct?: number | undefined;
  };
}): Promise<TeamMembershipDto> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('staff_team_memberships')
    .insert({
      user_id: input.body.userId,
      team: input.body.team,
      is_lead: input.body.isLead ?? false,
      allocation_pct: input.body.allocationPct ?? null,
      ...actorStamp(input.auth),
    })
    .select('*')
    .single();
  throwIfError(error, 'write');
  if (data === null) {
    throw ApiError.serviceUnavailable('The team membership could not be created.');
  }
  await recordMutation({
    action: 'CREATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'profile',
    entityId: input.body.userId,
    after: { team: data.team, isLead: data.is_lead },
  });
  return toTeamMembershipDto(data);
}

export async function patchTeamMembership(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly isLead?: boolean | undefined;
    readonly allocationPct?: number | null | undefined;
  };
}): Promise<TeamMembershipDto> {
  const patch: Record<string, unknown> = { updated_by: input.auth.userId };
  if (input.body.isLead !== undefined) patch.is_lead = input.body.isLead;
  if (input.body.allocationPct !== undefined) patch.allocation_pct = input.body.allocationPct;
  const updated = await updateLive<TeamMembershipRow>('staff_team_memberships', input.id, patch);
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'profile',
    entityId: updated.user_id,
    changedFields: Object.keys(patch).filter((key) => key !== 'updated_by'),
  });
  return toTeamMembershipDto(updated);
}

export async function deleteTeamMembership(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<void> {
  const row = await loadLive<TeamMembershipRow>('staff_team_memberships', input.id);
  await softDeleteLive('staff_team_memberships', input.id, input.auth.userId);
  await recordMutation({
    action: 'SOFT_DELETE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'profile',
    entityId: row.user_id,
    reason: `team ${row.team} membership removed`,
  });
}

export type { TeamRow };
