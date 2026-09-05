/**
 * Role vocabulary.
 *
 * SCOPE NOTE (Phase 1): this module defines *who the actors are*. It contains no
 * permission logic whatsoever — the role → capability matrix is authorization
 * and belongs to Phase 4, where it will be added as `permissions.ts` alongside
 * the server-side guard and the matching RLS policies.
 *
 * Two distinct axes exist and must not be conflated:
 *
 * - **Platform roles** are global. An actor holding one is internal Growlith
 *   staff and is not scoped to any organization.
 * - **Organization roles** are always scoped to exactly one organization. The
 *   same person can be a CLIENT_ADMIN of one organization and absent from
 *   another; there is no such thing as a global CLIENT_ADMIN.
 */

/** Internal Growlith staff. Cross-tenant by nature. */
export const PLATFORM_ROLES = ['SUPER_ADMIN', 'ADMIN'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** Client-side users. Always scoped to one organization. */
export const ORGANIZATION_ROLES = ['CLIENT_ADMIN', 'CLIENT_MEMBER'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/**
 * Every role in the system — and, deliberately, only four of them.
 *
 * KNOWN GAP (risk R-1 / finding B-8, requires an owner decision): this
 * vocabulary cannot express "internal staff member limited to their own team and
 * their own assigned engagements". With only SUPER_ADMIN and ADMIN internally,
 * every specialist across the seven teams must be granted cross-tenant ADMIN
 * simply to do their job, so one compromised contractor account exposes every
 * client organization's data — a least-privilege violation.
 *
 * The recommended addition is a fifth platform role, `TEAM_MEMBER`, authorized
 * only for entities whose delivering team matches one of the actor's
 * `staff_team_memberships`. This module is intentionally data-driven so that
 * adding it is a vocabulary change plus one migration, not a refactor.
 *
 * The gap is NOT silently closed here, and it is not merely written down: it is
 * **enforced by a failing test**. `tests/unit/domain.spec.ts` asserts that no
 * fifth role exists and that risk R-1 is still open in the risk register, so the
 * moment Phase 4 adds the role the test fails and forces the register,
 * `docs/architecture/domain-model.md` and the Phase 2 enum migration to be
 * updated in the same change. A note that cannot be ignored beats a constant
 * that can.
 */
export const ROLES = [...PLATFORM_ROLES, ...ORGANIZATION_ROLES] as const;
export type Role = (typeof ROLES)[number];

/**
 * Semantic contract of each role.
 *
 * Written as data rather than prose in a README so that the Phase 4 permission
 * matrix, the Phase 2 database enums and the Phase 9 UI labels all derive from
 * one source.
 */
export const ROLE_DEFINITIONS = {
  /**
   * Internal. Unrestricted, including the operations that are irreversible or
   * that change who else has power: deleting an organization, granting roles,
   * platform settings, destructive purges. Must be held by a named few with MFA.
   */
  SUPER_ADMIN: {
    axis: 'platform',
    tenantScoped: false,
    summary: 'Internal owner of the platform. Holds irreversible and role-granting operations.',
  },
  /**
   * Internal. Operates the machine across all tenants: organizations,
   * engagements, services, projects, deliverables, tasks, staff and teams.
   * Cannot grant roles, delete an organization, or change platform settings.
   */
  ADMIN: {
    axis: 'platform',
    tenantScoped: false,
    summary: 'Internal operator across all client organizations.',
  },
  /**
   * Client-side, scoped to one organization. Full read of that organization,
   * approves or requests revisions on deliverables, uploads attachments, and
   * manages the organization's own members — but may only ever grant
   * CLIENT_MEMBER, never an internal role and never CLIENT_ADMIN elevation of
   * others without an internal actor (Phase 4 confirms this rule).
   */
  CLIENT_ADMIN: {
    axis: 'organization',
    tenantScoped: true,
    summary: 'Client-side owner of one organization: approvals and member management.',
  },
  /**
   * Client-side, scoped to one organization. Read and collaborate only: view
   * client-visible work, comment, upload. No approvals, no member management.
   */
  CLIENT_MEMBER: {
    axis: 'organization',
    tenantScoped: true,
    summary: 'Client-side collaborator on one organization: read, comment, upload.',
  },
} as const satisfies Record<
  Role,
  { axis: 'platform' | 'organization'; tenantScoped: boolean; summary: string }
>;

/**
 * Project membership roles — the delivery-team leg of §2.1's three-level
 * resolution, and the only role axis that is NOT in the permission matrix: a
 * project role never grants a capability, it satisfies an object-side
 * qualifier (`[P]`) on a capability an organization role already granted.
 * Mirrors the Postgres `project_member_role` enum (see the parity assertion
 * in tests/unit/domain.spec.ts's sibling, the schema contract test).
 */
export const PROJECT_MEMBER_ROLES = ['LEAD', 'CONTRIBUTOR', 'REVIEWER', 'OBSERVER'] as const;
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number];
