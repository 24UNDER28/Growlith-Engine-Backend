import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import { ApiError } from '@/server/api/errors';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import type { RouteAuthorizationContext, RouteTenantResolver } from '@/server/api/with-route';

type TenantTable =
  | 'organizations'
  | 'engagements'
  | 'services'
  | 'projects'
  | 'project_memberships'
  | 'deliverables'
  | 'tasks'
  | 'reports'
  | 'metrics'
  | 'files'
  | 'comments'
  | 'notifications'
  | 'invitations'
  | 'organization_memberships';

/**
 * Resolve the tenant FROM THE ROW, through the caller's own RLS. A miss is
 * `null` (404-before-403). Never the service client — a guard that sees more
 * than the caller is how existence leaks.
 */
export function tenantFromRow(
  table: TenantTable,
  paramKey: string,
): RouteTenantResolver<unknown, unknown, unknown> {
  return async (context) => {
    const id = (context.params as Record<string, string> | undefined)?.[paramKey];
    if (typeof id !== 'string' || id.length === 0) {
      return null;
    }
    const supabase = await createSupabaseServerClient();
    const selectable =
      table === 'organizations' ? 'id' : table === 'notifications' ? 'organization_id' : 'organization_id';
    const column = table === 'organizations' ? 'id' : 'id';
    let query = supabase.from(table).select(selectable).eq(column, id);
    if (
      table !== 'invitations' &&
      table !== 'notifications' &&
      table !== 'metrics'
    ) {
      query = query.is('deleted_at', null);
    }
    const { data, error } = await query.maybeSingle();
    if (error !== null) {
      throw ApiError.serviceUnavailable('The resource could not be inspected.');
    }
    if (data === null) {
      return null;
    }
    const row = data as unknown as { id?: string; organization_id?: string | null };
    if (table === 'organizations') {
      return row.id ?? null;
    }
    const orgId = row.organization_id;
    return orgId === null || orgId === undefined ? undefined : orgId;
  };
}

export function tenantFromParam(
  key: string,
): <TParams, TQuery, TBody>(
  context: RouteAuthorizationContext<TParams, TQuery, TBody>,
) => string | null {
  return (context) => {
    const value = (context.params as Record<string, unknown> | undefined)?.[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
}

/**
 * List endpoints: staff may omit `organizationId` (GLOBAL read). A client
 * must name a tenant — missing is 422, not a silent "all my orgs" scan.
 */
export function tenantFromListQuery(context: {
  readonly query: { readonly organizationId?: string | undefined };
  readonly auth: AuthContext;
}): string | undefined {
  if (context.query.organizationId !== undefined) {
    return context.query.organizationId;
  }
  if (context.auth.platformRole !== null) {
    return undefined;
  }
  throw ApiError.validation(
    [
      {
        path: 'organizationId',
        code: 'required',
        message: 'organizationId is required.',
      },
    ],
    'The query string is invalid.',
  );
}

export function firstActiveMembershipTenant(auth: AuthContext): string | undefined {
  return auth.memberships.find((membership) => membership.status === 'ACTIVE')?.organizationId;
}

/**
 * B-4: staff resolve no tenant (GLOBAL cells); a client resolves the first
 * organization where both actor and target hold a live membership. Invisible
 * is `null` (404-before-403).
 */
export async function sharedOrgTenant(
  auth: AuthContext,
  targetUserId: string,
): Promise<string | null | undefined> {
  if (auth.platformRole !== null) {
    return undefined;
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('organization_memberships')
    .select('organization_id')
    .eq('user_id', targetUserId)
    .eq('status', 'ACTIVE')
    .is('deleted_at', null);
  if (error !== null) {
    throw ApiError.serviceUnavailable('The user could not be inspected.');
  }
  const reachable = new Set(
    auth.memberships
      .filter((membership) => membership.status === 'ACTIVE')
      .map((membership) => membership.organizationId),
  );
  const shared = (data ?? []).find((row) => reachable.has(row.organization_id));
  return shared?.organization_id ?? null;
}

export function isStaff(auth: AuthContext): boolean {
  return auth.platformRole !== null;
}
