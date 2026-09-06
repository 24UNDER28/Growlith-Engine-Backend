/**
 * State-machine contract (ADR-0009, design §13).
 *
 * Legal transitions live in PostgreSQL (`status_transitions`) and are enforced
 * by `growlith.enforce_status_transition()`. This module does not duplicate
 * that table — two copies would drift. What it records is the APPLICATION
 * contract around the catalogue:
 *
 *   - which entities are state-machined (PATCH never writes `status`);
 *   - the comment edit window;
 *   - that reports are a linear lifecycle outside the catalogue.
 *
 * The service layer calls `assertTransitionAllowed()` (which reads the live
 * catalogue through the caller's JWT) before any status write, so a client
 * gets a 409-with-explanation rather than a trigger's 400. The trigger remains
 * the authority.
 */

import type { EntityKind } from '@/lib/domain/entities';

/**
 * Entities whose `status` column is governed by `status_transitions`.
 * Reports are deliberately absent: publication is a linear RPC, not a branchy
 * machine (migration 20 / `publish_report()`).
 */
export const STATE_MACHINE_ENTITIES = [
  'organization',
  'engagement',
  'service',
  'project',
  'deliverable',
  'task',
] as const satisfies readonly EntityKind[];

export type StateMachineEntity = (typeof STATE_MACHINE_ENTITIES)[number];

/** PATCH bodies never include `status`; status moves through a dedicated action. */
export const STATUS_IS_NOT_A_PATCH_FIELD = true;

/**
 * Authors may edit a comment for 24 hours. SUPER_ADMIN may moderate after that
 * (matrix: `comment:update` is GLOBAL only for SUPER_ADMIN).
 */
export const COMMENT_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isStateMachineEntity(value: string): value is StateMachineEntity {
  return (STATE_MACHINE_ENTITIES as readonly string[]).includes(value);
}

export function commentEditWindowOpen(createdAt: string, nowMs = Date.now()): boolean {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) {
    return false;
  }
  return nowMs - created <= COMMENT_EDIT_WINDOW_MS;
}
