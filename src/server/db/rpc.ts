import 'server-only';

import { ApiError } from '@/server/api/errors';
import { mapDatabaseError } from '@/server/db/errors';
import { createSupabaseServerClient } from '@/server/supabase/client-server';

/**
 * Invoke a SECURITY DEFINER RPC through the USER-JWT client so `auth.uid()`
 * inside the function is the caller. Authority is re-checked from the
 * database; this helper only maps the outcome.
 */
export async function callRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error !== null) {
    mapDatabaseError(error, 'write');
  }
  return data as T;
}

export async function callRpcVoid(fn: string, args: Record<string, unknown>): Promise<void> {
  await callRpc<unknown>(fn, args);
}

export function requireRow<T>(row: T | null, message?: string): T {
  if (row === null) {
    throw ApiError.notFound(message);
  }
  return row;
}
