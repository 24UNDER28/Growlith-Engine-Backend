import 'server-only';

import type { PageResult } from '@/lib/types/pagination';
import type { InvitationDto } from '@/server/auth/invitations';
import { ApiError } from '@/server/api/errors';
import { throwIfError } from '@/server/db/errors';
import { listLive } from '@/server/services/crud';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import type { Database } from '@/types/database';
import type { PaginationQuery } from '@/lib/validation/pagination';

type InvitationRow = Database['public']['Tables']['invitations']['Row'];

function toDto(row: InvitationRow): InvitationDto {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    organizationId: row.organization_id,
    organizationRole: row.organization_role,
    platformRole: row.platform_role,
    expiresAt: row.expires_at,
    resentCount: row.resent_count,
    lastSentAt: row.last_sent_at,
  };
}

export async function listInvitations(input: {
  readonly query: PaginationQuery & {
    readonly organizationId?: string | undefined;
    readonly status?: readonly string[] | undefined;
    readonly email?: string | undefined;
  };
}): Promise<PageResult<InvitationDto>> {
  const page = await listLive<InvitationRow>({
    table: 'invitations',
    query: input.query,
    live: false,
    allowedSorts: ['createdAt'],
    apply: (q) => {
      let next = q;
      if (input.query.organizationId !== undefined) {
        next = next.eq('organization_id', input.query.organizationId);
      }
      if (input.query.status !== undefined && input.query.status.length > 0) {
        next = next.in('status', [...input.query.status]);
      }
      if (input.query.email !== undefined) {
        next = next.ilike('email', `%${input.query.email}%`);
      }
      return next;
    },
    keyOf: (row) => row.created_at,
  });
  return { data: page.data.map(toDto), pagination: page.pagination };
}

export async function getInvitation(id: string): Promise<InvitationDto> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from('invitations').select('*').eq('id', id).maybeSingle();
  throwIfError(error, 'read');
  if (data === null) {
    throw ApiError.notFound();
  }
  return toDto(data);
}
