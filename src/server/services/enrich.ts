import 'server-only';

import { throwIfError } from '@/server/db/errors';
// JUSTIFIED service-role call site (client-service.ts rule): commercial
// columns (`contract_value`, `monthly_retainer`, `notes_internal`, `fee`,
// `fee_model`, `allocation_pct`) are revoked from `authenticated` at GRANT.
// Staff still must not see rows RLS hid, so we load IDs through the user-JWT
// client first and enrich ONLY those ids.
import { getSupabaseServiceClient } from '@/server/supabase/client-service';

export async function enrichByIds(
  table: 'engagements' | 'services' | 'project_memberships',
  ids: readonly string[],
  columns: string,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) {
    return out;
  }
  const service = getSupabaseServiceClient();
  const { data, error } = await service
    .from(table)
    .select(`id, ${columns}`)
    .in('id', [...ids]);
  throwIfError(error, 'read');
  for (const row of (data ?? []) as unknown as readonly { readonly id: string }[]) {
    out.set(row.id, row as unknown as Record<string, unknown>);
  }
  return out;
}
