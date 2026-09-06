import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import type { PageResult } from '@/lib/types/pagination';
import { toNotificationDto, type NotificationDto } from '@/lib/dto/mappers';
import { ApiError } from '@/server/api/errors';
import { throwIfError } from '@/server/db/errors';
import { listLive } from '@/server/services/crud';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import type { Database } from '@/types/database';
import type { PaginationQuery } from '@/lib/validation/pagination';

type Row = Database['public']['Tables']['notifications']['Row'];

export async function listNotifications(input: {
  readonly auth: AuthContext;
  readonly query: PaginationQuery & {
    readonly unread?: boolean | undefined;
    readonly archived?: boolean | undefined;
  };
}): Promise<PageResult<NotificationDto>> {
  const page = await listLive<Row>({
    table: 'notifications',
    query: input.query,
    live: false,
    allowedSorts: ['createdAt'],
    apply: (q) => {
      let next = q.eq('recipient_user_id', input.auth.userId);
      if (input.query.unread === true) next = next.is('read_at', null);
      if (input.query.archived !== true) {
        next = next.is('archived_at', null);
      }
      return next;
    },
  });
  return { data: page.data.map(toNotificationDto), pagination: page.pagination };
}

export async function getNotification(input: {
  readonly id: string;
  readonly auth: AuthContext;
}): Promise<NotificationDto> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('id', input.id)
    .eq('recipient_user_id', input.auth.userId)
    .maybeSingle();
  throwIfError(error, 'read');
  if (data === null) {
    throw ApiError.notFound();
  }
  return toNotificationDto(data);
}

export async function patchNotification(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly body: { readonly read?: boolean | undefined; readonly archived?: boolean | undefined };
}): Promise<NotificationDto> {
  const supabase = await createSupabaseServerClient();
  const { data: existing, error: loadError } = await supabase
    .from('notifications')
    .select('*')
    .eq('id', input.id)
    .eq('recipient_user_id', input.auth.userId)
    .maybeSingle();
  throwIfError(loadError, 'read');
  if (existing === null) {
    throw ApiError.notFound();
  }
  const patch: Record<string, unknown> = {};
  if (input.body.read === true) patch.read_at = new Date().toISOString();
  if (input.body.read === false) patch.read_at = null;
  if (input.body.archived === true) patch.archived_at = new Date().toISOString();
  if (input.body.archived === false) patch.archived_at = null;
  const { data: updated, error } = await supabase
    .from('notifications')
    .update(patch as never)
    .eq('id', input.id)
    .eq('recipient_user_id', input.auth.userId)
    .select('*')
    .maybeSingle();
  throwIfError(error, 'write');
  if (updated === null) {
    throw ApiError.notFound();
  }
  return toNotificationDto(updated);
}

export async function markAllNotificationsRead(
  auth: AuthContext,
): Promise<{ readonly updated: number }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('recipient_user_id', auth.userId)
    .is('read_at', null)
    .select('id');
  throwIfError(error, 'write');
  return { updated: data?.length ?? 0 };
}
