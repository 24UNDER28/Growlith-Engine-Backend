import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import type { EntityKind } from '@/lib/domain/entities';
import { ApiError } from '@/server/api/errors';
import { assertTransitionAllowed } from '@/server/auth/authorize';
import { recordMutation } from '@/server/audit/mutation';
import { throwIfError } from '@/server/db/errors';
import { loadLive, updateLive } from '@/server/services/crud';
import { createSupabaseServerClient } from '@/server/supabase/client-server';

export async function changeStatus<T extends { readonly id: string; readonly status: string; readonly organization_id: string }>(
  input: {
    readonly table: string;
    readonly entityKind: EntityKind;
    readonly id: string;
    readonly toStatus: string;
    readonly reason?: string | undefined;
    readonly auth: AuthContext;
    readonly request: Request;
    readonly requestId: string;
    readonly extra?: Record<string, unknown> | undefined;
  },
): Promise<T> {
  const row = await loadLive<T>(input.table, input.id);
  await assertTransitionAllowed(
    input.entityKind,
    row.status,
    input.toStatus,
    input.auth,
    row.organization_id,
  );

  const supabase = await createSupabaseServerClient();
  const { data: edge, error } = await supabase
    .from('status_transitions')
    .select('requires_reason')
    .eq('entity_kind', input.entityKind)
    .eq('from_status', row.status)
    .eq('to_status', input.toStatus)
    .maybeSingle();
  throwIfError(error, 'read');
  if (edge?.requires_reason === true && (input.reason === undefined || input.reason.trim() === '')) {
    throw ApiError.validation(
      [{ path: 'reason', code: 'required', message: 'reason is required for this transition.' }],
      'The request failed validation.',
    );
  }

  const updated = await updateLive<T>(input.table, input.id, {
    status: input.toStatus,
    updated_by: input.auth.userId,
    ...(input.extra ?? {}),
  });
  await recordMutation({
    action: 'STATUS_CHANGE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: input.entityKind,
    entityId: input.id,
    organizationId: row.organization_id,
    changedFields: ['status'],
    before: { status: row.status },
    after: { status: input.toStatus },
    reason: input.reason,
  });
  return updated;
}
