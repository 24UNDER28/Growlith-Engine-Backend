/**
 * The entity hierarchy, expressed as data.
 *
 *   Organization → Engagement → Service → Project → Deliverable → Task
 *
 * SCOPE NOTE (Phase 1): this module records the *shape* of the hierarchy — which
 * entity contains which, and which entities are tenant-scoped. It deliberately
 * contains no status values, no transition rules and no field-level entity
 * types:
 *
 * - Statuses and their legal transitions are a business state machine
 *   (Phase 5, `state-machines.ts`). Encoding them before the endpoints that use
 *   them exist would be speculative (Rule 14).
 * - Field-level entity types are **generated** from the database in Phase 2
 *   (`npm run db:types` → `src/types/database.ts`). Hand-writing them now would
 *   guarantee drift between TypeScript and PostgreSQL, which is exactly what
 *   ADR-0004 avoids by not using an ORM.
 *
 * What lives here is used by three things that do exist in Phase 1: the audit
 * event contract, the comment subject contract, and the API route taxonomy.
 */

/** Entities in the commercial/delivery hierarchy. */
export const HIERARCHY_ENTITIES = [
  'organization',
  'engagement',
  'service',
  'project',
  'deliverable',
  'task',
] as const;

export type HierarchyEntity = (typeof HIERARCHY_ENTITIES)[number];

/** Supporting entities that hang off the hierarchy. */
export const SUPPORTING_ENTITIES = ['comment', 'attachment', 'metric', 'notification'] as const;

export type SupportingEntity = (typeof SUPPORTING_ENTITIES)[number];

/**
 * Identity entities. `profile` arrives in Phase 3: authentication events
 * (login, logout, status changes, MFA) need an audit subject, and the subject
 * of every such event is a person. It is deliberately NOT part of the hierarchy
 * or the supporting set — a profile is global, never tenant-scoped.
 */
export const IDENTITY_ENTITIES = ['profile'] as const;

export type IdentityEntity = (typeof IDENTITY_ENTITIES)[number];

/**
 * Reporting entity. `report` arrives in Phase 4: publication freezes figures
 * for the client, and both the audit event (§B.4 `report:publish`) and the
 * projected activity feed (§F.4's allow-list) need an answer to "which thing
 * happened to". Like `profile` before it, it is APPENDED to the enum rather
 * than interleaved — PostgreSQL enum labels are positional, and reordering
 * one in place requires a type rewrite of every stored value.
 */
export const REPORTING_ENTITIES = ['report'] as const;

export type ReportingEntity = (typeof REPORTING_ENTITIES)[number];

export const ENTITY_KINDS = [
  ...HIERARCHY_ENTITIES,
  ...SUPPORTING_ENTITIES,
  ...IDENTITY_ENTITIES,
  ...REPORTING_ENTITIES,
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * Parent of each hierarchy entity. `null` marks the tenant root.
 *
 * This map is the authoritative statement of the containment rules that Phase 2
 * encodes as composite foreign keys — `tasks (project_id, organization_id)
 * REFERENCES projects (id, organization_id)` — so that a child row cannot be
 * placed in a different tenant from its parent (ADR-0005).
 *
 * MODELLED TRADEOFF (ADR-0005): `task`'s parent here is `deliverable`, per the
 * stated hierarchy, but some real work is not attached to any deliverable
 * (investigation, meetings, internal maintenance). Phase 2 resolves this by
 * making `tasks.deliverable_id` NULLABLE while `tasks.project_id` stays NOT
 * NULL, constrained so that a task's deliverable — when present — belongs to the
 * same project. This map remains the authoritative containment statement; the
 * persistence model is deliberately looser at exactly this one edge, so the
 * difference is a decision and not an accident.
 */
export const HIERARCHY_PARENT = {
  organization: null,
  engagement: 'organization',
  service: 'engagement',
  project: 'service',
  deliverable: 'project',
  task: 'deliverable',
} as const satisfies Record<HierarchyEntity, HierarchyEntity | null>;

/** The tenant root. Every tenant-scoped row carries its `organization_id`. */
export const TENANT_ROOT: HierarchyEntity = 'organization';

/**
 * Entities whose rows always carry an `organization_id` and are therefore
 * subject to tenant-isolation RLS policies.
 *
 * `organization` itself is the tenant, not a row within one, so it is handled
 * by a distinct policy shape and is excluded here.
 */
export const TENANT_SCOPED_ENTITIES = [
  'engagement',
  'service',
  'project',
  'deliverable',
  'task',
  'comment',
  'attachment',
  'metric',
  'notification',
  // Phase 4: a report is the tenant's reporting artifact — frozen figures
  // about this organization, published to it.
  'report',
] as const satisfies readonly EntityKind[];

export type TenantScopedEntity = (typeof TENANT_SCOPED_ENTITIES)[number];

export function isEntityKind(value: string): value is EntityKind {
  return (ENTITY_KINDS as readonly string[]).includes(value);
}

export function parentOf(entity: HierarchyEntity): HierarchyEntity | null {
  return HIERARCHY_PARENT[entity];
}

/**
 * The chain from an entity up to the tenant root, ordered nearest-ancestor
 * first. Used to build breadcrumb-style navigation and to reason about which
 * ancestors must be visible for a row to be reachable.
 */
export function ancestorChain(entity: HierarchyEntity): HierarchyEntity[] {
  const chain: HierarchyEntity[] = [];
  let current: HierarchyEntity | null = HIERARCHY_PARENT[entity];

  while (current !== null) {
    chain.push(current);
    current = HIERARCHY_PARENT[current];
  }

  return chain;
}
