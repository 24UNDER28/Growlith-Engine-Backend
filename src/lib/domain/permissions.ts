/**
 * Phase 4 — the capability matrix (design: docs/architecture/authorization.md §1, §4, §A–§B).
 *
 * This module answers exactly two of the four authorization questions:
 *
 *   Q2  RESOURCE   — is this resource in this role's vocabulary?
 *   Q3  ACTION     — is this verb granted to this role on that resource?
 *
 * Q1 (tenant reach) is evaluated here as a *reachability gate* because the
 * guard cannot honestly answer "may this verb?" without knowing "in whose
 * tenant?", but a failing Q1 is reported as its own reason so the API layer can
 * return 404, never 403. Q4 (project membership) is evaluated only where the
 * subject-side rule is knowable without a database read — everything else is
 * returned to the caller as an OBLIGATION for the service layer, and RLS
 * enforces the rows regardless.
 *
 * THE MATRIX IS DATA, ONCE, FOR EVERYONE (ADR-0007, §0). It is imported
 * unchanged by the API guard (`src/server/auth/authorize.ts`), the RSC page
 * guards, the UI affordance logic and the test suite. It is never duplicated
 * into SQL and never re-expressed in components: the two layers that enforce
 * authorization share a definition of identity (`auth_context()`), not a
 * definition of permissions.
 *
 * Purity contract (enforced by tests/architecture): this module reads no I/O,
 * no environment reads, no process state, no `@/server/*`. It must stay importable
 * from the browser so the UI can hide what the server will deny — while
 * remaining true that the UI check is never the control (§K: "A hidden button
 * is a courtesy to the user, not a control").
 */

import type { AccountStatus } from '@/lib/auth/account-status';
import type { InternalTeam } from '@/lib/domain/teams';
import type {
  OrganizationRole,
  PlatformRole,
  ProjectMemberRole,
  Role,
} from '@/lib/domain/roles';

/* ────────────────────────────── the vocabulary ─────────────────────────── */

/**
 * The eleven verbs (§1.1). An action is a capability of the SYSTEM, not of a
 * UI widget; `MANAGE_MEMBERS` and `MANAGE_SETTINGS` exist because "membership"
 * and "settings" are composite powers that decompose to CRUD on rows whose
 * write paths are guarded separately (RPCs and separate tables — §1.1).
 */
export const PERMISSION_ACTIONS = [
  'create',
  'read',
  'update',
  'delete',
  'assign',
  'approve',
  'publish',
  'upload',
  'download',
  'manage_members',
  'manage_settings',
] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/**
 * The authorization subjects of §1.2's table — one row per resource, every
 * table of the schema mapping to exactly one resource (asserted by
 * tests/unit/permissions.spec.ts against the generated `database.ts`).
 *
 * `platform_settings` is the deliberately table-less reservation of
 * §A ("the capability is reserved now so the route cannot ship without one"):
 * the Phase 7 settings table inherits a matrix row instead of a route
 * improvising one.
 */
export const PERMISSION_RESOURCES = [
  'organization',
  'user',
  'membership',
  'platform_grant',
  'invitation',
  'team_membership',
  'engagement',
  'service',
  'project',
  'project_membership',
  'task',
  'deliverable',
  'report',
  'file',
  'notification',
  'activity',
  'comment',
  'status_transition',
  'platform_settings',
] as const;
export type PermissionResource = (typeof PERMISSION_RESOURCES)[number];

/** `{resource}:{action}` — a contract string (§1.3). */
export type Capability = `${PermissionResource}:${PermissionAction}`;

export const ALL_CAPABILITIES: readonly Capability[] = PERMISSION_RESOURCES.flatMap(
  (resource) => PERMISSION_ACTIONS.map((action) => `${resource}:${action}` as Capability),
);

export function isCapability(value: string): value is Capability {
  return (ALL_CAPABILITIES as readonly string[]).includes(value);
}

export function parseCapability(
  value: string,
): { resource: PermissionResource; action: PermissionAction } | null {
  if (!isCapability(value)) {
    return null;
  }
  const separator = value.indexOf(':');
  return {
    resource: value.slice(0, separator) as PermissionResource,
    action: value.slice(separator + 1) as PermissionAction,
  };
}

/**
 * What the guard CHECKS (§4). GLOBAL needs no tenant; TENANT requires the
 * actor to reach the named organization; SELF marks a capability whose row
 * identity the service layer (and RLS) must still honour.
 */
export const PERMISSION_SCOPES = ['GLOBAL', 'TENANT', 'SELF'] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

/**
 * What the guard RECORDS AS AN OBLIGATION (§4). The guard does not evaluate
 * CLIENT_VISIBLE — it has not loaded the row — but carrying the qualifier makes
 * the duty visible to the contract test, which requires a matching RLS policy
 * predicate for every gated capability (§16 invariant 6).
 */
export const PERMISSION_QUALIFIERS = [
  'CLIENT_VISIBLE',
  'PROJECT_MEMBER',
  'STATE_MACHINE',
  'RPC_ONLY',
  'COLUMN_RESTRICTED',
  'OWN_ROW',
] as const;
export type PermissionQualifier = (typeof PERMISSION_QUALIFIERS)[number];

export type PermissionGrant =
  | { readonly kind: 'DENY' }
  | { readonly kind: 'NA' }
  | { readonly kind: 'ALLOW'; readonly scope: PermissionScope; readonly qualifiers: readonly PermissionQualifier[] };

const DENY: PermissionGrant = Object.freeze({ kind: 'DENY' });
const NOT_APPLICABLE: PermissionGrant = Object.freeze({ kind: 'NA' });

function allow(scope: PermissionScope, qualifiers: readonly PermissionQualifier[]): PermissionGrant {
  return Object.freeze({ kind: 'ALLOW', scope, qualifiers: Object.freeze([...qualifiers]) });
}

/* ───────────────────────────── the actor model ──────────────────────────── */

/**
 * The authorization subject (§2): the Phase 3 `AuthContext` plus the two facts
 * Phase 4 adds to the same `auth_context()` round trip. `AuthContext` is
 * structurally assignable to this interface; nothing here may be read from a
 * JWT claim (ADR-0011).
 */
export interface PermissionActor {
  readonly userId: string;
  readonly userType: 'INTERNAL' | 'CLIENT';
  readonly accountStatus: AccountStatus;
  readonly platformRole: PlatformRole | null;
  readonly memberships: readonly {
    readonly organizationId: string;
    readonly role: OrganizationRole;
    readonly status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  }[];
  /** Staff team memberships (`staff_team_memberships`), Phase 4 addition. */
  readonly teams: readonly InternalTeam[];
  /**
   * `projectRoles[projectId]` for every live `project_memberships` row,
   * Phase 4 addition. A record rather than a Map because the whole context is
   * a serializable DTO.
   */
  readonly projectRoles: Readonly<Record<string, ProjectMemberRole>>;
  /**
   * True when the actor holds more than 500 project memberships (§2 cap, risk
   * A-4): `projectRoles` is then truncated and project-qualified checks must
   * consult the database instead. Over-capacity never silently permits.
   */
  readonly projectRolesOverflow: boolean;
  readonly aal: 'aal1' | 'aal2';
}

/**
 * The effective role for one `(actor, organization)` pair (§2.1). Platform
 * role OUTRANKS AND REPLACES organization role — it never merges. `null` means
 * "no role applies here", which the guard answers with NO_TENANT_ACCESS.
 *
 * `organizationId === null` (a GLOBAL or SELF capability, or a list without a
 * tenant context) resolves the client role from the actor's live memberships;
 * the choice is safe because every GLOBAL/SELF matrix cell for CLIENT_ADMIN and
 * CLIENT_MEMBER is identical, which tests/unit/permissions.spec.ts enforces.
 */
export function effectiveRoleFor(
  actor: PermissionActor,
  organizationId: string | null,
): Role | null {
  if (actor.platformRole !== null) {
    return actor.platformRole;
  }
  if (actor.accountStatus !== 'ACTIVE' || actor.userType !== 'CLIENT') {
    // INTERNAL users always carry a platform role or hold nothing: a null
    // platform role for staff means their grant is revoked — deny.
    return null;
  }
  if (organizationId !== null) {
    const membership = actor.memberships.find(
      (candidate) => candidate.organizationId === organizationId && candidate.status === 'ACTIVE',
    );
    return membership?.role ?? null;
  }
  const active = actor.memberships.filter((membership) => membership.status === 'ACTIVE');
  if (active.some((membership) => membership.role === 'CLIENT_ADMIN')) {
    return 'CLIENT_ADMIN';
  }
  return active.some((membership) => membership.role === 'CLIENT_MEMBER') ? 'CLIENT_MEMBER' : null;
}

/** Q1 (§3): binary tenant reach, the application-side mirror of `has_org_access()`. */
export function reachesTenant(actor: PermissionActor, organizationId: string): boolean {
  if (actor.platformRole !== null) {
    return true;
  }
  if (actor.accountStatus !== 'ACTIVE' || actor.userType !== 'CLIENT') {
    return false;
  }
  return actor.memberships.some(
    (membership) => membership.organizationId === organizationId && membership.status === 'ACTIVE',
  );
}

/* ─────────────────────────── the matrix itself ──────────────────────────── */

/**
 * The dense matrix, transcribed row-for-row from §B.1–B.4 and §1.2.
 *
 * Cell notation: `✗` denied, `—` not defined for this resource (a type error to
 * attempt, not a runtime deny), `●` allowed within the role's tenant reach,
 * `◑` own tenant only, `◒` own tenant AND the client-visibility gate, `◦` own
 * row only — and the flags `[R]` RPC-only, `[S]` state-machine-constrained,
 * `[P]` project-membership qualifier, `[C]` column-restricted (§B legend).
 * The four columns are SUPER_ADMIN, ADMIN, CLIENT_ADMIN, CLIENT_MEMBER.
 *
 * EVERY (resource, action) pair appears, for every role — the matrix is dense
 * (§4): the absence of a cell is a review failure, and the module below
 * throws at load if any of the 19×11×4 cells is missing.
 */
const MATRIX_SPEC = {
  /** §B.1 Identity and access. */
  organization: {
    create: '● ● ✗ ✗', // tenant creation is internal by definition
    read: '● ● ◑ ◑', // client sees its own row; notes_internal-class columns not granted
    update: '● ● ✗ ✗', // legal name, region, status are contractual facts
    delete: '●[R] ✗ ✗ ✗', // soft delete; purge is a separate SUPER_ADMIN RPC that audits first
    assign: '● ● ✗ ✗', // account_manager_user_id
    approve: '— — — —',
    publish: '— — — —',
    upload: '— — — —',
    download: '— — — —',
    manage_members: '● ● ◑[R] ✗', // the CLIENT_ADMIN ceiling applies — definer RPC
    manage_settings: '● ● ◑ ✗', // organization_settings is a separate table (§1.1)
  },
  user: {
    create: '●[R] ●[R] ◑[R] ✗', // only by invitation; sign-up is disabled
    read: '● ● ◑ ◑', // co-members + staff identities on their work, not the roster
    update: '● ●[R] ◦ ◦', // ADMIN may not alter a SUPER_ADMIN's account; status changes are RPC + audited
    delete: '●[R] ✗ ✗ ✗', // GDPR erasure — SUPER_ADMIN only, audited, irreversible
    assign: '— — — —',
    approve: '— — — —',
    publish: '— — — —',
    upload: '— — — —',
    download: '— — — —',
    manage_members: '— — — —',
    manage_settings: '— — — —',
  },
  membership: {
    create: '●[R] ●[R] ◑[R] ✗', // CLIENT_ADMIN: CLIENT_MEMBER role only
    read: '● ● ◑ ◑',
    update: '●[R] ●[R] ◑[R] ✗', // four ceilings (§A)
    delete: '●[R] ●[R] ◑[R] ✗', // soft delete; last-admin and primary-contact rules
    assign: '— — — —',
    approve: '— — — —',
    publish: '— — — —',
    upload: '— — — —',
    download: '— — — —',
    manage_members: '— — — —',
    manage_settings: '— — — —',
  },
  platform_grant: {
    create: '●[R] ✗ ✗ ✗', // the role-granting operation; CRITICAL audit
    read: '● ◦ ✗ ✗', // ADMIN may see its own grant, never the roster of power
    delete: '●[R] ✗ ✗ ✗', // revocation is an UPDATE of revoked_at via the RPC
    update: '— — — —',
    assign: '— — — —',
    approve: '— — — —',
    publish: '— — — —',
    upload: '— — — —',
    download: '— — — —',
    manage_members: '— — — —',
    manage_settings: '— — — —',
  },
  invitation: {
    create: '● ● ◑ ✗', // CLIENT_ADMIN: own org, CLIENT_MEMBER branch only
    read: '● ● ◑ ✗', // never the token — token_hash is revoked at GRANT (§F.1)
    update: '● ● ◑ ✗', // resend and revoke; terms frozen by trigger after issue
    delete: '✗ ✗ ✗ ✗', // expired rows are removed by the retention job, not a person
    assign: '— — — —',
    approve: '— — — —',
    publish: '— — — —',
    upload: '— — — —',
    download: '— — — —',
    manage_members: '— — — —',
    manage_settings: '— — — —',
  },
  team_membership: {
    create: '● ● ✗ ✗', // internal delivery structure
    read: '● ● ✗ ✗', // a client must not enumerate Growlith's staff by team
    update: '● ● ✗ ✗',
    delete: '● ● ✗ ✗',
    assign: '— — — —',
    approve: '— — — —',
    publish: '— — — —',
    upload: '— — — —',
    download: '— — — —',
    manage_members: '— — — —',
    manage_settings: '— — — —',
  },

  /** §B.2 Commercial hierarchy. */
  engagement: {
    create: '● ● ✗ ✗',
    read: '● ● ◑[C] ◑[C]', // contract_value, monthly_retainer, notes_internal not granted
    update: '●[S] ●[S] ✗ ✗',
    delete: '● ● ✗ ✗', // soft delete
    assign: '● ● ✗ ✗', // account_manager_user_id
    approve: '— — — —',
    publish: '— — — —',
    upload: '— — — —',
    download: '— — — —',
    manage_members: '— — — —',
    manage_settings: '— — — —',
  },
  service: {
    create: '● ● ✗ ✗',
    read: '● ● ◑[C] ◑[C]', // fee, fee_model not granted
    update: '●[S] ●[S] ✗ ✗',
    delete: '● ● ✗ ✗',
    assign: '● ● ✗ ✗', // delivering_team, lead_user_id
    approve: '— — — —',
    publish: '— — — —',
    upload: '— — — —',
    download: '— — — —',
    manage_members: '— — — —',
    manage_settings: '— — — —',
  },
  project: {
    create: '● ● ✗ ✗',
    read: '● ● ◒ ◒', // client_visible defaults TRUE — the client sees the shape of the work
    update: '●[S] ●[S] ✗ ✗',
    delete: '● ● ✗ ✗',
    assign: '●[P] ●[P] ✗ ✗', // lead_user_id must hold a LEAD membership; owning_team
    manage_members: '● ●[P] ✗ ✗', // ADMIN requires LEAD on that project; SUPER_ADMIN overrides
    approve: '— — — —',
    publish: '— — — —',
    upload: '— — — —',
    download: '— — — —',
    manage_settings: '— — — —',
  },

  /** §B.3 Delivery. */
  project_membership: {
    create: '● ●[P] ✗ ✗', // the tenancy trigger already refuses a cross-tenant person
    read: '● ● ◒[C] ◒[C]', // roster of a visible project; allocation_pct not exposed
    update: '● ●[P] ✗ ✗',
    delete: '● ●[P] ✗ ✗',
    assign: '— — — —',
    approve: '— — — —',
    publish: '— — — —',
    upload: '— — — —',
    download: '— — — —',
    manage_members: '— — — —',
    manage_settings: '— — — —',
  },
  task: {
    create: '● ● ✗ ✗',
    read: '● ● ✗ ✗', // no client policy exists on tasks — an ABSENT POLICY, not a flag
    update: '●[S] ●[S] ✗ ✗',
    delete: '● ● ✗ ✗',
    assign: '●[P] ●[P] ✗ ✗', // assignee must be a live project member (trigger)
    approve: '— — — —',
    publish: '— — — —',
    upload: '— — — —',
    download: '— — — —',
    manage_members: '— — — —',
    manage_settings: '— — — —',
  },
  deliverable: {
    create: '● ● ✗ ✗',
    read: '● ● ◒ ◒', // client_visible AND status >= CLIENT_REVIEW — the strict gate
    update: '●[S] ●[S] ✗ ✗',
    delete: '● ● ✗ ✗',
    assign: '●[P] ●[P] ✗ ✗', // owner_user_id
    approve: '●[S] ●[S] ◒[R][S] ✗', // the client-driven transition, CLIENT_ADMIN only at the client end
    publish: '●[S] ●[S] ✗ ✗', // APPROVED → PUBLISHED is Growlith's act, never the client's
    upload: '● ● ◒ ◒', // client feedback attachments; delegates to file:upload
    download: '● ● ◒ ◒', // delegates to file:download
    manage_members: '— — — —',
    manage_settings: '— — — —',
  },

  /** §B.4 Reporting, files, communication, activity. */
  report: {
    create: '● ● ✗ ✗',
    // `report:read` also governs the resource's two companion tables
    // (§1.2: reports + report_metrics + metrics). The RLS layer splits the
    // gate per table exactly as §E says: reports published, report_metrics
    // inherited, raw `metrics` organization-wide WITHOUT a flag (the row
    // "read (metrics) ● ● ◑ ◑" of §B.4 is the metrics-table policy, not a
    // separate capability).
    read: '● ● ◒ ◒',
    update: '● ● ✗ ✗', // frozen once published
    delete: '● ● ✗ ✗',
    publish: '● ● ✗ ✗', // freezes report_metrics; sets published_at/by/visible
    download: '● ● ◒ ◒', // export of a published report; audited EXPORT
    assign: '— — — —',
    approve: '— — — —',
    upload: '— — — —',
    manage_members: '— — — —',
    manage_settings: '— — — —',
  },
  file: {
    // `file:create` is deliberately NOT-A — an upload IS the create;
    // registering metadata without the object is not an upload (§1.1).
    create: '— — — —',
    read: '● ● ◒ ◒', // metadata. Gate = visible ∧ parent visible ∧ scan CLEAN
    update: '● ● ◦ ◦', // rename/reclassify own upload only
    delete: '● ● ◦ ◦', // soft delete own upload; purge is a job
    assign: '— — — —',
    approve: '— — — —',
    publish: '— — — —',
    upload: '● ● ◑ ◑', // signed URL; path must begin {organization_id}/
    download: '● ● ◒ ◒', // same gate plus a 60 s signed URL; audited FILE_DOWNLOAD
    manage_members: '— — — —',
    manage_settings: '— — — —',
  },
  notification: {
    create: '✗ ✗ ✗ ✗', // NO role may create one — server-side emission via definer only
    read: '◦ ◦ ◦ ◦', // recipient only. Even SUPER_ADMIN reads only their own inbox.
    update: '◦ ◦ ◦ ◦', // read_at / archived_at only
    delete: '✗ ✗ ✗ ✗', // retention job
    assign: '— — — —',
    approve: '— — — —',
    publish: '— — — —',
    upload: '— — — —',
    download: '— — — —',
    manage_members: '— — — —',
    manage_settings: '— — — —',
  },
  activity: {
    read: '● ● ✗ ✗', // no client policy on audit_events; a projected feed instead (§F.4)
    create: '✗ ✗ ✗ ✗', // written by trigger and definer only
    update: '✗ ✗ ✗ ✗', // append-only, enforced for EVERY role including service_role
    delete: '✗ ✗ ✗ ✗',
    assign: '— — — —',
    approve: '— — — —',
    publish: '— — — —',
    upload: '— — — —',
    download: '— — — —',
    manage_members: '— — — —',
    manage_settings: '— — — —',
  },
  comment: {
    create: '● ● ◒ ◒', // clients: never is_internal, never on a task (trigger refuses)
    read: '● ● ◒ ◒', // plus is_internal = false
    update: '● ◦ ◦ ◦', // author only within the edit window; SUPER_ADMIN may moderate
    delete: '● ● ◦ ◦', // soft delete
    assign: '— — — —',
    approve: '— — — —',
    publish: '— — — —',
    upload: '— — — —',
    download: '— — — —',
    manage_members: '— — — —',
    manage_settings: '— — — —',
  },
  status_transition: {
    read: '● ● ● ●', // the status vocabulary is needed to render any label (§G)
    create: '— — — —', // the catalogue changes by migration, never at runtime
    update: '— — — —',
    delete: '— — — —',
    assign: '— — — —',
    approve: '— — — —',
    publish: '— — — —',
    upload: '— — — —',
    download: '— — — —',
    manage_members: '— — — —',
    manage_settings: '— — — —',
  },

  /**
   * The reserved platform-settings axis (§A item 4). SUPER_ADMIN only; the
   * backing table arrives with Phase 7, and the reservation exists so a
   * settings route cannot ship on a weaker capability.
   */
  platform_settings: {
    create: '✗ ✗ ✗ ✗', // the single settings row per deployment is created by migration
    read: '● ✗ ✗ ✗',
    update: '● ✗ ✗ ✗',
    delete: '✗ ✗ ✗ ✗',
    assign: '— — — —',
    approve: '— — — —',
    publish: '— — — —',
    upload: '— — — —',
    download: '— — — —',
    manage_members: '— — — —',
    manage_settings: '● ✗ ✗ ✗', // changes how the system behaves for everyone
  },
} as const satisfies Record<PermissionResource, Record<PermissionAction, string>>;

/** Parse one `"✗ — ◑[C] …"` row string into four structured grants, keyed by role column. */
function parseRow(row: string): Record<Role, PermissionGrant> {
  const cells = row.trim().split(/\s+/);
  if (cells.length !== 4) {
    throw new Error(`permission matrix row "${row}" must have exactly four cells`);
  }
  return {
    SUPER_ADMIN: parseCell(cells[0] ?? ''),
    ADMIN: parseCell(cells[1] ?? ''),
    CLIENT_ADMIN: parseCell(cells[2] ?? ''),
    CLIENT_MEMBER: parseCell(cells[3] ?? ''),
  } satisfies Record<Role, PermissionGrant>;
}

function parseCell(cell: string): PermissionGrant {
  const flags = cell.slice(1);
  if (cell.startsWith('✗')) return flags === '' ? DENY : malformed(cell);
  if (cell.startsWith('—')) return flags === '' ? NOT_APPLICABLE : malformed(cell);

  const qualifiers: PermissionQualifier[] = [];
  if (cell.startsWith('◒')) qualifiers.push('CLIENT_VISIBLE');
  if (cell.startsWith('◦')) qualifiers.push('OWN_ROW');
  for (const flag of flags.matchAll(/\[([RSPC])\]/g)) {
    switch (flag[1]) {
      case 'R':
        qualifiers.push('RPC_ONLY');
        break;
      case 'S':
        qualifiers.push('STATE_MACHINE');
        break;
      case 'P':
        qualifiers.push('PROJECT_MEMBER');
        break;
      case 'C':
        qualifiers.push('COLUMN_RESTRICTED');
        break;
    }
  }
  if (flags.replace(/(\[[RSPC]\])+/, '') !== '') {
    return malformed(cell);
  }

  switch (cell[0]) {
    case '●':
      return allow('GLOBAL', qualifiers);
    case '◑':
    case '◒':
      return allow('TENANT', qualifiers);
    case '◦':
      return allow('SELF', qualifiers);
    default:
      return malformed(cell);
  }
}

function malformed(cell: string): never {
  throw new Error(`permission matrix cell "${cell}" is not a valid glyph+flags token`);
}

/**
 * The dense, frozen matrix: `PERMISSION_MATRIX[role][resource][action]`.
 * Built at module load from `MATRIX_SPEC`; an authoring hole is a load-time
 * exception, not a default (§4: "dense, not sparse").
 */
export const PERMISSION_MATRIX: Readonly<
  Record<Role, Readonly<Record<PermissionResource, Readonly<Record<PermissionAction, PermissionGrant>>>>>
> = buildMatrix();

function buildMatrix() {
  const roleColumns: readonly Role[] = ['SUPER_ADMIN', 'ADMIN', 'CLIENT_ADMIN', 'CLIENT_MEMBER'];
  type MutableMatrix = Record<Role, Record<PermissionResource, Record<PermissionAction, PermissionGrant>>>;
  const matrix: MutableMatrix = Object.fromEntries(
    roleColumns.map((role) => [
      role,
      Object.fromEntries(PERMISSION_RESOURCES.map((resource) => [resource, {}])),
    ]),
  ) as MutableMatrix;

  for (const resource of PERMISSION_RESOURCES) {
    const rows = MATRIX_SPEC[resource] as Record<PermissionAction, string>;
    for (const action of PERMISSION_ACTIONS) {
      const spec = rows[action];
      if (spec === undefined) {
        // Type-level `satisfies Record<Resource, Record<Action, string>>` makes
        // this unreachable; the throw is the runtime backstop of the claim.
        throw new Error(`permission matrix is missing ${resource}:${action}`);
      }
      const grants = parseRow(spec);
      for (const role of roleColumns) {
        matrix[role][resource][action] = grants[role];
      }
    }
  }

  for (const role of roleColumns) {
    for (const resource of PERMISSION_RESOURCES) {
      for (const action of PERMISSION_ACTIONS) {
        if (matrix[role][resource][action] === undefined) {
          throw new Error(`permission matrix hole at ${role} ${resource}:${action}`);
        }
      }
      Object.freeze(matrix[role][resource]);
    }
    Object.freeze(matrix[role]);
  }

  return Object.freeze(matrix) as Readonly<
    Record<Role, Readonly<Record<PermissionResource, Readonly<Record<PermissionAction, PermissionGrant>>>>>
  >;
}

/** Every capability the role holds an explicit ALLOW for (used by the snapshot, §K.1). */
export function capabilitiesHeldByRole(role: Role): readonly Capability[] {
  const held: Capability[] = [];
  for (const resource of PERMISSION_RESOURCES) {
    for (const action of PERMISSION_ACTIONS) {
      if (PERMISSION_MATRIX[role][resource][action].kind === 'ALLOW') {
        held.push(`${resource}:${action}` as Capability);
      }
    }
  }
  return Object.freeze(held.sort());
}

/**
 * The capabilities that exactly SUPER_ADMIN holds (§12 blast-radius reduction
 * and §16 invariant 5's matrix half). §A item 5 — the SUPER_ADMIN-only
 * reopening transitions — is deliberately absent: it is state-machine data
 * (`status_transitions.allowed_roles`), not a capability.
 */
export const SUPER_ADMIN_EXCLUSIVE_CAPABILITIES: readonly Capability[] = (() => {
  const exclusive: Capability[] = [];
  for (const capability of ALL_CAPABILITIES) {
    const parsed = parseCapability(capability);
    if (parsed === null) {
      continue;
    }
    const { resource, action } = parsed;
    if (
      PERMISSION_MATRIX.SUPER_ADMIN[resource][action].kind === 'ALLOW' &&
      (['ADMIN', 'CLIENT_ADMIN', 'CLIENT_MEMBER'] as const).every(
        (role) => PERMISSION_MATRIX[role][resource][action].kind !== 'ALLOW',
      )
    ) {
      exclusive.push(capability);
    }
  }
  return Object.freeze(exclusive.sort());
})();

/**
 * The backing tables of each resource (§1.2 + §16 invariant 7: every table in
 * the schema belongs to exactly one resource, which is what makes the coverage
 * assertion possible). `platform_settings` is the one reserved resource with no
 * table yet (Phase 7).
 */
export const RESOURCE_TABLES: Readonly<Record<PermissionResource, readonly string[]>> =
  Object.freeze({
    organization: ['organizations', 'organization_settings'],
    user: ['profiles'],
    membership: ['organization_memberships'],
    platform_grant: ['platform_role_grants'],
    invitation: ['invitations'],
    team_membership: ['staff_team_memberships', 'teams'],
    engagement: ['engagements'],
    service: ['services', 'service_lines'],
    project: ['projects'],
    project_membership: ['project_memberships'],
    task: ['tasks'],
    deliverable: ['deliverables', 'deliverable_versions'],
    report: ['reports', 'report_metrics', 'metrics'],
    file: ['files', 'storage.objects'],
    notification: ['notifications'],
    activity: ['audit_events'],
    comment: ['comments'],
    status_transition: ['status_transitions'],
    platform_settings: [],
  } as const satisfies Record<PermissionResource, readonly string[]>);

/**
 * The resources whose CLIENT-SIDE read gate is enforced by RLS, per §E:
 * every capability carrying CLIENT_VISIBLE must name at least one table with
 * a `*_select_client` policy (asserted against the migrations by the L2 test).
 */
export function tablesOf(capability: Capability): readonly string[] {
  const parsed = parseCapability(capability);
  return parsed === null ? [] : RESOURCE_TABLES[parsed.resource];
}

/* ─────────────────────────── the decision function ──────────────────────── */

export type DenyReason =
  | 'NO_TENANT_ACCESS' // Q1 — the API maps this to 404, never 403 (§I.3)
  | 'CAPABILITY_NOT_GRANTED' // Q2/Q3 — mapped to 403, and only once reach is established
  | 'PROJECT_MEMBERSHIP_REQUIRED' // Q4
  | 'ASSURANCE_LEVEL_TOO_LOW'; // MFA step-up outstanding

export type PermissionDecision =
  | {
      readonly allowed: true;
      readonly role: Role;
      readonly scope: PermissionScope;
      /** Duties the caller owes beyond this allow (§I.2). */
      readonly obligations: readonly PermissionQualifier[];
    }
  | {
      readonly allowed: false;
      readonly role: Role | null;
      readonly reason: DenyReason;
    };

/** Inputs that let the guard evaluate what it CAN without a database read. */
export interface CapabilityScopeInput {
  /** The tenant the operation targets. Required by TENANT-scoped grants. */
  readonly organizationId?: string | null;
  /** The project the operation targets, when the route already knows it. */
  readonly projectId?: string | null;
  /** The subject of a SELF-scoped operation, when it is a person id (e.g. `accounts/{userId}`). */
  readonly subjectUserId?: string | null;
  /** Minimum authenticator assurance level the route demands (design §6c, §J.3 `/admin/**`). */
  readonly requiredAal?: 1 | 2;
}

/**
 * Capabilities where the PROJECT_MEMBER qualifier gates the ACTOR (not the
 * object) for ADMIN: §5 rule 3 — staffing a project requires LEAD, with
 * SUPER_ADMIN overriding. Every other `[P]` cell is an object rule (§D: "not
 * the verb — the object") and is returned as an obligation for the service
 * layer, the RPCs and `growlith.enforce_task_assignee_membership()`.
 */
const ACTOR_SIDE_PROJECT_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'project:manage_members',
]);

/**
 * The pure decision (§I.2). Evaluation order mirrors §I.3 steps 3–6; steps 1–2
 * (authentication, account status) belong to `requireAuthContext`, and step 7
 * (load the row through the user-JWT client, letting RLS filter it) belongs to
 * the service layer — `can()` denies everything it cannot positively allow,
 * and returns everything it cannot yet see as an obligation.
 */
export function can(
  actor: PermissionActor,
  capability: Capability,
  input: CapabilityScopeInput = {},
): PermissionDecision {
  // Defensive normalization: the matrix makes unknown capabilities a compile
  // error, but the guard receives strings from route DECLARATIONS that may be
  // built dynamically. Anything unparseable denies (fail closed, §I.3).
  const parsed = parseCapability(capability);
  const organizationId = input.organizationId ?? null;

  const deny = (reason: DenyReason, role: Role | null): PermissionDecision => ({
    allowed: false,
    role,
    reason,
  });

  if (parsed === null) {
    return deny('CAPABILITY_NOT_GRANTED', null);
  }

  // The assurance pre-flight (design step 3): nothing else matters until the
  // second factor exists for routes that demand it.
  if (input.requiredAal === 2 && actor.aal !== 'aal2') {
    return deny('ASSURANCE_LEVEL_TOO_LOW', null);
  }

  // The account-status re-check (belt and braces on requireAuthContext's
  // gate): a non-ACTIVE identity holds no role anywhere, hence nothing.
  if (actor.accountStatus !== 'ACTIVE') {
    return deny('NO_TENANT_ACCESS', null);
  }

  const role = effectiveRoleFor(actor, organizationId);
  if (role === null) {
    return deny('NO_TENANT_ACCESS', null);
  }

  const grant = PERMISSION_MATRIX[role][parsed.resource][parsed.action];
  if (grant.kind !== 'ALLOW') {
    return deny('CAPABILITY_NOT_GRANTED', role);
  }

  // Q1 for TENANT grants: the tenant gate answers 404-shaped denials (§I.3
  // step 4) so the API is never a cross-tenant existence oracle.
  if (grant.scope === 'TENANT') {
    if (organizationId === null) {
      // A TENANT-scoped capability without a resolvable tenant: for staff
      // this is a routing bug; for a client, "which tenant?" was the entire
      // question. Deny without revealing either way.
      return deny('CAPABILITY_NOT_GRANTED', role);
    }
    if (!reachesTenant(actor, organizationId)) {
      return deny('NO_TENANT_ACCESS', role);
    }
  }

  // SELF grants: the guard enforces the subject where it is statically known
  // (a path-named person id); otherwise the OWN_ROW obligation is honoured by
  // the service layer and RLS.
  if (
    grant.scope === 'SELF' &&
    input.subjectUserId !== undefined &&
    input.subjectUserId !== null &&
    input.subjectUserId !== actor.userId
  ) {
    return deny('CAPABILITY_NOT_GRANTED', role);
  }

  // Q4 — the one actor-side project rule the matrix can evaluate without a
  // read: §5 rule 3.
  if (
    grant.qualifiers.includes('PROJECT_MEMBER') &&
    ACTOR_SIDE_PROJECT_CAPABILITIES.has(capability) &&
    role === 'ADMIN'
  ) {
    const projectId = input.projectId ?? null;
    if (projectId === null) {
      return deny('PROJECT_MEMBERSHIP_REQUIRED', role);
    }
    if (actor.projectRolesOverflow) {
      // Over-capacity (§2, risk A-4): `can()` cannot decide; the obligation is
      // returned and the DB-backed guard consults `project_role_in()` per
      // project. A stale or absent map never grants access by omission.
      return decision(role, grant, [...grant.qualifiers]);
    }
    if (actor.projectRoles[projectId] !== 'LEAD') {
      return deny('PROJECT_MEMBERSHIP_REQUIRED', role);
    }
  }

  return decision(role, grant, grant.qualifiers);
}

function decision(
  role: Role,
  grant: Extract<PermissionGrant, { kind: 'ALLOW' }>,
  obligations: readonly PermissionQualifier[],
): PermissionDecision {
  return { allowed: true, role, scope: grant.scope, obligations: Object.freeze([...obligations]) };
}

/* ───────────────────────── the permission snapshot (§K.1) ───────────────── */

/**
 * The serializable, derived capability set the protected layouts hand to the
 * UI. COARSE BY DESIGN: it answers "may this role ever do this?", never "may
 * this user do this to row 7" — a per-row permission map in the browser would
 * be a second authorization implementation, and the second implementation is
 * always the one that is wrong (§K.1).
 *
 * Nothing in this type is trusted by the server; §K's invariants are enforced
 * by the API guard and RLS, independently, always.
 */
export interface PermissionSnapshot {
  readonly capabilities: readonly Capability[];
  readonly organizationId: string | null;
  readonly effectiveRole: Role;
}

/**
 * Derive the snapshot for a context and the organization in view. The
 * derivation consults THE SAME matrix the server guard consults — one source,
 * two callers, no second copy (§K.2). A stale snapshot can therefore only
 * over-restrict relative to a revoked role: the server re-resolves from
 * PostgreSQL on the very next request (ADR-0011).
 */
export function derivePermissionSnapshot(
  actor: PermissionActor,
  organizationId: string | null,
): PermissionSnapshot | null {
  const role = effectiveRoleFor(actor, organizationId);
  if (role === null) {
    return null;
  }
  return { capabilities: capabilitiesHeldByRole(role), organizationId, effectiveRole: role };
}
