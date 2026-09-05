import { describe, expect, it } from 'vitest';

import {
  ALL_CAPABILITIES,
  PERMISSION_MATRIX,
  type Capability,
  type PermissionAction,
  type PermissionResource,
} from '@/lib/domain/permissions';
import { ROLES, type Role } from '@/lib/domain/roles';
import { readRepositoryFile, stripComments, walkRepository } from '../helpers/repo';

/**
 * The route/authorization contract (design §G, §I.3) — static, per route file.
 *
 * `withRoute` enforces the capability requirement through the TYPE system, so
 * this spec is not the primary line of defense: it is the regression gate for
 * what types cannot see — a route that exists at all. Specifically:
 *
 *  1. every route module under `app/api` goes through `withRoute`
 *     (nothing bypasses the wrapper),
 *  2. every route DEFINITION declares its authentication posture explicitly,
 *  3. every `auth: 'required'` route declares a capability that EXISTS in the
 *     matrix (§G: "no protected route without a capability" — also asserted at
 *     runtime as a 500 backstop, but a deployment must not be able to ship
 *     with one open),
 *  4. a capability whose matrix cells are TENANT-scoped for ANY role may only
 *     be declared by a route that provides a tenant resolver — the guard
 *     refuses to guess the tenant (§I.3 step 4), so a TENANT route without a
 *     resolver is either broken or silently degraded to a GLOBAL check. A
 *     GLOBAL-scoped capability (e.g. `user:update` for staff, with the client
 *     roles at ◦ SELF) legitimately carries no resolver, and rule 4 lets it.
 *  5. the public surface is a CLOSED, reviewed list: an accidental
 *     `auth: 'public'` on a new route is exactly the kind of "temporarily open
 *     until Phase 4" debt this repo's history forbids.
 *
 * The parsing is deliberately conservative: definition blocks are located by
 * brace-matching from `withRoute({` after comments are stripped. A route that
 * plays source-level tricks to hide a missing capability is a review bug, not
 * something the AST would change — the type system is the enforcement; this
 * file is the tripwire.
 */

const PUBLIC_SURFACE = [
  'app/api/v1/auth/login/route.ts',
  'app/api/v1/auth/logout/route.ts',
  'app/api/v1/auth/password-recovery/route.ts',
  'app/api/v1/auth/session/route.ts',
  'app/api/v1/health/route.ts',
] as const;

interface RouteBlock {
  readonly file: string;
  readonly source: string;
  readonly exported: string;
}

/** `withRoute(...)` definitions plus the HTTP method each is exported as. */
function routeBlocks(): RouteBlock[] {
  // The scan covers the API surface only. `app/auth/confirm` is a browser
  // redirect handler (a page route, not an API endpoint) and legitimately
  // does not wear the withRoute wrapper.
  const files = walkRepository({ roots: ['app/api'], extensions: new Set(['.ts']) });
  const blocks: RouteBlock[] = [];
  for (const file of files) {
    const source = stripComments(readRepositoryFile(file));
    if (!source.includes('withRoute(')) {
      throw new Error(`${file}: route file that does not go through withRoute`);
    }
    for (const match of source.matchAll(/const\s+(GET|POST|PUT|PATCH|DELETE)\s*=\s*withRoute\(/g)) {
      const open = source.indexOf('{', match.index! + match[0].length - 1);
      blocks.push({ file, exported: match[1]!, source: sliceBraced(source, open) });
    }
  }
  return blocks;
}

/** Balanced-brace slice starting at `open` (the definition object). */
function sliceBraced(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced braces in route definition');
}

const TENANT_RULE = /\btenant\s*:/;
const CAPABILITY_RULE = /\bcapability\s*:\s*'([a-z_]+):([a-z_]+)'/;
const AUTH_RULE = /\bauth\s*:\s*'(public|required)'/;

function tenantScopedSomewhere(capability: Capability): boolean {
  const [resource, action] = capability.split(':') as [PermissionResource, PermissionAction];
  return ROLES.some(
    (role: Role) =>
      PERMISSION_MATRIX[role][resource][action].kind === 'ALLOW' &&
      (PERMISSION_MATRIX[role][resource][action] as { scope?: string }).scope === 'TENANT',
  );
}

describe('route authorization contract (Phase 4, static)', () => {
  const blocks = routeBlocks();

  it('every app/api route file is covered and every definition declares its posture', () => {
    for (const block of blocks) {
      expect(
        AUTH_RULE.test(block.source),
        `${block.file} (${block.exported}): no auth posture`,
      ).toBe(true);
    }
    // The file list is non-empty and every file contributes at least one block.
    const files = new Set(blocks.map((block) => block.file));
    expect(files.size).toBeGreaterThanOrEqual(16);
  });

  it('the public surface is exactly the reviewed list', () => {
    const publicFiles = blocks
      .filter((block) => AUTH_RULE.exec(block.source)?.[1] === 'public')
      .map((block) => block.file)
      .sort();
    expect([...new Set(publicFiles)].sort()).toEqual([...PUBLIC_SURFACE].sort());
  });

  it('every protected route declares a matrix capability', () => {
    for (const block of blocks) {
      if (AUTH_RULE.exec(block.source)?.[1] !== 'required') continue;
      const match = CAPABILITY_RULE.exec(block.source);
      expect(
        match,
        `${block.file} (${block.exported}): protected without capability`,
      ).not.toBeNull();
      const capability = `${match![1]}:${match![2]}` as Capability;
      expect(
        ALL_CAPABILITIES.includes(capability),
        `${block.file}: capability "${capability}" is not in the matrix`,
      ).toBe(true);
    }
  });

  it('every route whose capability is TENANT-scoped for any role carries a tenant resolver', () => {
    for (const block of blocks) {
      if (AUTH_RULE.exec(block.source)?.[1] !== 'required') continue;
      const match = CAPABILITY_RULE.exec(block.source);
      if (match === null) continue;
      const capability = `${match[1]}:${match[2]}` as Capability;
      if (!tenantScopedSomewhere(capability)) continue;
      expect(
        TENANT_RULE.test(block.source),
        `${block.file} (${block.exported}): ${capability} is TENANT-scoped for at least one role but resolves no tenant`,
      ).toBe(true);
    }
  });

  it('no public route smuggles authorization machinery into the definition', () => {
    for (const block of blocks) {
      if (AUTH_RULE.exec(block.source)?.[1] !== 'public') continue;
      // Definition-level keys only: a public handler is free to build any
      // object it likes — the guard looks at the DEFINITION before any
      // handler runs, so that is the surface pinned here.
      const definitionOnly = block.source.slice(0, block.source.indexOf('\n    handler'));
      for (const field of ['capability', 'tenant', 'subjectUser', 'project', 'minAal'] as const) {
        expect(
          new RegExp(`\\b${field}\\s*:`).test(definitionOnly),
          `${block.file}: public route declares ${field}`,
        ).toBe(false);
      }
    }
  });
});
