import 'server-only';

import { z } from 'zod';
import type { AuthContext } from '@/lib/auth/context';
import {
  can,
  parseCapability,
  type Capability,
  type CapabilityScopeInput,
  type DenyReason,
  type PermissionQualifier,
  type PermissionResource,
} from '@/lib/domain/permissions';
import type { EntityKind } from '@/lib/domain/entities';
import { ApiError } from '@/server/api/errors';
import { recordAuthEvent } from '@/server/auth/audit';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import type { Logger } from '@/server/logging/logger';

/**
 * Phase 4 — the server-side authorization helper (design §I).
 *
 * The guard answers the questions `can()` can answer WITHOUT loading a row,
 * in the §I.3 order, and maps every outcome to its §J wire shape:
 *
 *   1. authenticated            — `requireAuthContext` (not this module);
 *   2. account status           — `requireAuthContext` (423/401/403);
 *   3. assurance floor          — `requireAuthContext({ minAal })`;
 *   4. tenant reach (Q1)        — `NO_TENANT_ACCESS` → **404, log-only**;
 *   5. capability (Q2/Q3)       — `CAPABILITY_NOT_GRANTED` → 403 + denial audit;
 *   6. obligations (Q4 partial) — `PROJECT_MEMBERSHIP_REQUIRED` → 403 + audit;
 *   7. row identity + state     — the handler, through the user-JWT client
 *      (RLS filters) and the database's own constraints/triggers.
 *
 * THE 404-BEFORE-403 RULE IS THE LOAD-BEARING ONE (ADR-0019): an actor who
 * cannot reach a tenant receives the same response for a row that exists in
 * another tenant as for one that does not exist anywhere. A 403 here would be
 * a cross-tenant existence oracle — which is precisely why step 4 cannot be
 "simplified" into step 5, and why a route must never pre-check existence on
 * behalf of a tenant the caller cannot reach.
 *
 * What this module deliberately does NOT do:
 *  • re-evaluate RLS — the row filter is the database's job (§0: two layers,
 *    one shared definition of identity, never a shared re-implementation);
 *  • answer CLIENT_VISIBLE or object-side PROJECT_MEMBER about a row it has
 *    not loaded — it returns them as OBLIGATIONS instead;
 *  • trust anything cached. The `AuthContext` it consumes is live per
 *    request (ADR-0011); a stale snapshot can only ever over-deny here,
 *    because the matrix consults it, and RLS independently re-checks every
 *    row read.
 */

export interface GuardInput {
  /** The tenant the operation targets, or null when it was not resolvable
   * from the request (which itself decides whether TENANT scopes can pass). */
  readonly organizationId: string | null;
  readonly projectId?: string | null | undefined;
  readonly subjectUserId?: string | null | undefined;
  readonly requiredAal?: 1 | 2 | undefined;
}

export interface GuardResult {
  readonly allowed: true;
  readonly obligations: readonly PermissionQualifier[];
}

/** The entity kind a denial on a resource is about, for the audit row. */
const RESOURCE_TO_AUDIT_ENTITY: Partial<Record<PermissionResource, EntityKind>> = {
  organization: 'organization',
  engagement: 'engagement',
  service: 'service',
  project: 'project',
  deliverable: 'deliverable',
  task: 'task',
  report: 'report',
  comment: 'comment',
  file: 'attachment',
  notification: 'notification',
  // user, membership, platform_grant and invitation are all ABOUT people;
  // their denial audits name the actor as the subject when no id is supplied
  // (the row that could not be touched may not exist — naming it would be an
  // existence oracle again).
  user: 'profile',
  membership: 'profile',
};

/**
 * Evaluate one capability against one context, throwing the §J-mapped
 * `ApiError` for every denial. `denialSubject` (when the route can name the
 * row id without loading it) enriches the audit row; the audit is written
 * ONLY for capability-level denials — tenant-reach failures are log-only by
 * rule (a probe for "does org X exist?" must not create a queryable
 * per-organization record of who asked).
 */
export async function authorize(
  context: AuthContext,
  capability: Capability,
  input: GuardInput,
  log: Logger,
  requestId: string,
  request?: Request,
  denialSubject?: {
    readonly entityKind?: EntityKind | undefined;
    readonly entityId?: string | null | undefined;
  },
): Promise<GuardResult> {
  const scope = {
    organizationId: input.organizationId,
    projectId: input.projectId ?? null,
    subjectUserId: input.subjectUserId ?? null,
  } satisfies CapabilityScopeInput;
  if (input.requiredAal !== undefined) {
    // exactOptionalPropertyTypes: absent means "no floor", never `undefined`.
    (scope as { requiredAal?: 1 | 2 }).requiredAal = input.requiredAal;
  }
  const decision = can(context, capability, scope);

  if (decision.allowed === true) {
    // §5 rule 3, overflow path: the matrix ALLOWS `project:manage_members`
    // for an ADMIN whose projectRoles map was truncated (§2 cap). Absence in
    // a truncated map proves nothing, so LEAD is consulted live. One extra
    // round trip for actors holding >500 project memberships — that is the
    // whole cost of never guessing.
    if (
      capability === 'project:manage_members' &&
      decision.role === 'ADMIN' &&
      decision.obligations.includes('PROJECT_MEMBER') &&
      context.projectRolesOverflow &&
      input.projectId
    ) {
      const role = await fetchProjectRole(input.projectId);
      if (role !== 'LEAD') {
        return deny(
          context,
          capability,
          'PROJECT_MEMBERSHIP_REQUIRED',
          input.organizationId,
          log,
          requestId,
          request,
          denialSubject,
        );
      }
    }
    return { allowed: true, obligations: decision.obligations };
  }

  const reason = decision.reason;
  if (reason === 'NO_TENANT_ACCESS') {
    log.info('tenant-unreachable request answered 404', {
      capability,
      requestedOrganization: input.organizationId ?? 'none',
    });
    throw ApiError.notFound();
  }
  if (reason === 'ASSURANCE_LEVEL_TOO_LOW') {
    // A live session at aal1 is authentic, not forbidden — the correct verb
    // is the step-up the §8 matrix already defines for privileged surfaces.
    throw ApiError.mfaRequired();
  }
  return deny(
    context,
    capability,
    reason,
    input.organizationId,
    log,
    requestId,
    request,
    denialSubject,
  );
}

async function deny(
  context: AuthContext,
  capability: Capability,
  reason: DenyReason,
  organizationId: string | null,
  log: Logger,
  requestId: string,
  request: Request | undefined,
  subject:
    | {
        readonly entityKind?: EntityKind | undefined;
        readonly entityId?: string | null | undefined;
      }
    | undefined,
): Promise<never> {
  const parsed = parseCapability(capability);
  // An audit row must describe a REAL subject. When the route could not name
  // the target row, the honest subject is the ACTOR's profile — writing
  // entity_kind 'deliverable' with an unrelated uuid would be exactly the
  // fabrication an audit trail must never contain.
  const hasTarget = typeof subject?.entityId === 'string' && subject.entityId.length > 0;
  const entityKind: EntityKind = hasTarget
    ? (subject?.entityKind ??
      (parsed ? RESOURCE_TO_AUDIT_ENTITY[parsed.resource] : undefined) ??
      'profile')
    : 'profile';

  // Best-effort by the audit module's contract: a failed audit write never
  // changes the 403 — but the attempt is made BEFORE the throw, so the deny
  // path is auditable even when the audit store is down (§11).
  await recordAuthEvent({
    action: 'PERMISSION_DENIED',
    severity: 'WARNING',
    entityId: hasTarget ? (subject?.entityId as string) : context.userId,
    entityKind,
    actorUserId: context.userId,
    actorRole: context.platformRole ?? undefined,
    organizationId: organizationId ?? undefined,
    requestId,
    request,
    reason: `${capability}:${reason}`,
  });

  log.info('capability denied', { capability, reason });
  throw ApiError.forbidden();
}

/* ───────────────────────────── the object side ─────────────────────────── */

const projectRoleSchema = z
  .object({
    projectId: z.string().min(1),
    role: z.enum(['LEAD', 'CONTRIBUTOR', 'REVIEWER', 'OBSERVER']),
  })
  .nullable();

/**
 * Live LEAD/REVIEWER-style lookup for the database-side fallbacks, through
 * the REQUEST-SCOPED client — the caller's own RLS visibility defines what
 * `project_role_in()` can see, and a bypass of that would turn the fallback
 * into a privilege.
 */
async function fetchProjectRole(
  projectId: string,
): Promise<'LEAD' | 'CONTRIBUTOR' | 'REVIEWER' | 'OBSERVER' | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('project_role_in', { p_project_id: projectId });
  if (error !== null) {
    // The lookup is part of the decision path; failing to perform it is not a
    // pass. 503: the denial would claim "not a LEAD", which is a lie when the
    // database could not answer.
    throw ApiError.serviceUnavailable('Project role could not be verified.');
  }
  // project_role_in() returns a bare enum label, not a row; accept both so an
  // accidental shape change fails closed instead of silently granting.
  if (typeof data === 'string') {
    return z.enum(['LEAD', 'CONTRIBUTOR', 'REVIEWER', 'OBSERVER']).parse(data);
  }
  const parsed = projectRoleSchema.safeParse(data);
  if (!parsed.success) {
    throw ApiError.serviceUnavailable('Project role could not be verified.');
  }
  return parsed.data?.role ?? null;
}

/**
 * The state-machine obligation (§I.2): when a route carries STATE_MACHINE,
 * the service layer must run the transition past `status_transitions` with
 * the caller's EFFECTIVE role before attempting the write, so a client gets a
 * 409-with-explanation rather than a trigger's 400 — and so the trigger in
 * `growlith.enforce_status_transition()` (which re-checks from the database,
 * unconditionally) stays the authority rather than the surprise.
 *
 * Phase 4 provides the helper; routes that declare status-writing handlers
 * are contract-tested to call it (or to delegate to a definer RPC whose body
 * consults the same table — §13's "one stored definition" is what makes both
 * acceptable).
 */
export async function assertTransitionAllowed(
  entityKind: EntityKind,
  fromStatus: string,
  toStatus: string,
  context: AuthContext,
  organizationId: string | null,
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('status_transitions')
    .select('from_status,to_status,allowed_roles,requires_reason')
    .eq('entity_kind', entityKind)
    .eq('from_status', fromStatus)
    .eq('to_status', toStatus)
    .maybeSingle();

  if (error !== null) {
    // Reading the catalogue is a plain RLS-visible read (reference data).
    // A failure here is unavailability, never a denial.
    throw ApiError.serviceUnavailable('The status catalogue could not be read.');
  }
  if (data === null) {
    throw ApiError.conflict(
      `${entityKind}: ${fromStatus} → ${toStatus} is not a legal transition.`,
    );
  }

  const effective =
    context.platformRole ??
    context.memberships.find((m) => m.organizationId === organizationId && m.status === 'ACTIVE')
      ?.role ??
    null;
  const allowed = (data.allowed_roles ?? []) as readonly string[];
  if (effective === null || !allowed.includes(effective)) {
    throw ApiError.forbidden(
      `This role may not move a ${entityKind} from ${fromStatus} to ${toStatus}.`,
    );
  }
}
