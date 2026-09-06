import { describe, expect, it } from 'vitest';

import {
  ALL_CAPABILITIES,
  PERMISSION_ACTIONS,
  PERMISSION_MATRIX,
  PERMISSION_RESOURCES,
  RESOURCE_TABLES,
  SUPER_ADMIN_EXCLUSIVE_CAPABILITIES,
  capabilitiesHeldByRole,
  parseCapability,
  tablesOf,
  type Capability,
  type PermissionResource,
} from '@/lib/domain/permissions';
import { ROLES, type Role } from '@/lib/domain/roles';
import { readRepositoryFile, stripComments, walkRepository } from '../helpers/repo';

/**
 * L2 — properties of the matrix itself (authorization.md §16).
 *
 * No snapshots: a snapshot would let a reviewer accept a changed permission
 * matrix without reading what changed.
 */

const CLIENT_FORBIDDEN_RESOURCES: readonly PermissionResource[] = [
  'task',
  'team_membership',
  'platform_grant',
  'activity',
];

const INFRA_TABLES = new Set(['idempotency_keys']);

function grantKind(
  role: Role,
  resource: PermissionResource,
  action: (typeof PERMISSION_ACTIONS)[number],
) {
  return PERMISSION_MATRIX[role][resource][action].kind;
}

describe('L2 invariant 1 — the matrix is dense', () => {
  it('has an explicit grant for every (role, resource, action) triple', () => {
    for (const role of ROLES) {
      for (const resource of PERMISSION_RESOURCES) {
        for (const action of PERMISSION_ACTIONS) {
          expect(
            PERMISSION_MATRIX[role][resource][action],
            `${role} ${resource}:${action} is undefined`,
          ).toBeDefined();
          expect(['ALLOW', 'DENY', 'NA']).toContain(PERMISSION_MATRIX[role][resource][action].kind);
        }
      }
    }
  });
});

describe('L2 invariant 2 — clients cannot see internal structure', () => {
  it('grants no client role any capability on task, team_membership, platform_grant or activity', () => {
    for (const role of ['CLIENT_ADMIN', 'CLIENT_MEMBER'] as const) {
      for (const resource of CLIENT_FORBIDDEN_RESOURCES) {
        for (const action of PERMISSION_ACTIONS) {
          expect(
            grantKind(role, resource, action),
            `${role} must not hold ${resource}:${action}`,
          ).not.toBe('ALLOW');
        }
      }
    }
  });
});

describe('CLIENT_ADMIN and CLIENT_MEMBER GLOBAL/SELF cells are identical', () => {
  it('so a tenant-less resolution cannot privilege one client role over the other', () => {
    for (const resource of PERMISSION_RESOURCES) {
      for (const action of PERMISSION_ACTIONS) {
        const admin = PERMISSION_MATRIX.CLIENT_ADMIN[resource][action];
        const member = PERMISSION_MATRIX.CLIENT_MEMBER[resource][action];
        if (admin.kind !== 'ALLOW' && member.kind !== 'ALLOW') continue;
        if (admin.kind === 'ALLOW' && admin.scope !== 'TENANT') {
          expect(member, `${resource}:${action} GLOBAL/SELF must match`).toEqual(admin);
        }
        if (member.kind === 'ALLOW' && member.scope !== 'TENANT') {
          expect(admin, `${resource}:${action} GLOBAL/SELF must match`).toEqual(member);
        }
      }
    }
  });
});

describe('L2 invariant 3 — CLIENT_MEMBER ⊂ CLIENT_ADMIN', () => {
  it('holds a strict subset of CLIENT_ADMIN capabilities', () => {
    const admin = new Set(capabilitiesHeldByRole('CLIENT_ADMIN'));
    const member = capabilitiesHeldByRole('CLIENT_MEMBER');
    for (const capability of member) {
      expect(
        admin.has(capability),
        `CLIENT_MEMBER holds ${capability} that CLIENT_ADMIN does not`,
      ).toBe(true);
    }
    expect(member.length).toBeLessThan(admin.size);
  });
});

describe('L2 invariant 4 — ADMIN ⊂ SUPER_ADMIN', () => {
  it('holds a strict subset of SUPER_ADMIN capabilities', () => {
    const superAdmin = new Set(capabilitiesHeldByRole('SUPER_ADMIN'));
    const admin = capabilitiesHeldByRole('ADMIN');
    for (const capability of admin) {
      expect(
        superAdmin.has(capability),
        `ADMIN holds ${capability} that SUPER_ADMIN does not`,
      ).toBe(true);
    }
    expect(admin.length).toBeLessThan(superAdmin.size);
  });
});

describe('L2 invariant 5 — SUPER_ADMIN-exclusive capabilities', () => {
  it('are exactly the irreversible / power-changing cells of §A', () => {
    expect([...SUPER_ADMIN_EXCLUSIVE_CAPABILITIES]).toEqual([
      'organization:delete',
      'platform_grant:create',
      'platform_grant:delete',
      'platform_settings:manage_settings',
      'platform_settings:read',
      'platform_settings:update',
      'user:delete',
    ]);
  });
});

describe('L2 invariant 6 — qualifiers name real tables', () => {
  it('every CLIENT_VISIBLE or RPC_ONLY allow names at least one backing table', () => {
    for (const role of ROLES) {
      for (const resource of PERMISSION_RESOURCES) {
        for (const action of PERMISSION_ACTIONS) {
          const grant = PERMISSION_MATRIX[role][resource][action];
          if (grant.kind !== 'ALLOW') continue;
          if (
            grant.qualifiers.includes('CLIENT_VISIBLE') ||
            grant.qualifiers.includes('RPC_ONLY')
          ) {
            const capability = `${resource}:${action}` as Capability;
            expect(
              tablesOf(capability).length,
              `${capability} carries a qualifier but names no table`,
            ).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

describe('L2 invariant 7 — every public table maps to exactly one resource', () => {
  it('covers generated public.Tables except infrastructure', () => {
    const source = readRepositoryFile('src/types/database.ts');
    const block = source.split('Tables: {')[1]?.split('Views:')[0] ?? '';
    const discovered = [...block.matchAll(/\n      ([a-z_]+): \{/g)].map((match) => match[1]!);

    const mapped = new Map<string, PermissionResource>();
    for (const resource of PERMISSION_RESOURCES) {
      for (const table of RESOURCE_TABLES[resource]) {
        if (table === 'storage.objects') continue;
        expect(
          mapped.has(table),
          `${table} is claimed by both ${mapped.get(table)} and ${resource}`,
        ).toBe(false);
        mapped.set(table, resource);
      }
    }

    for (const table of discovered) {
      if (INFRA_TABLES.has(table)) continue;
      expect(mapped.has(table), `${table} is not claimed by any permission resource`).toBe(true);
    }
  });
});

describe('Phase 5 coverage — every ALLOW capability is a route, a delegation, or an absence', () => {
  const DELEGATED = new Set<Capability>([
    'user:create',
    'membership:create',
    'membership:update',
    'membership:delete',
    'project_membership:create',
    'project_membership:update',
    'project_membership:delete',
    'deliverable:upload',
    'deliverable:download',
  ]);
  const ABSENT = new Set<Capability>([
    'invitation:delete',
    'notification:create',
    'notification:delete',
    'activity:create',
    'activity:update',
    'activity:delete',
    'platform_settings:create',
    'platform_settings:read',
    'platform_settings:update',
    'platform_settings:delete',
    'platform_settings:manage_settings',
  ]);

  function declaredCapabilities(): Set<Capability> {
    const files = walkRepository({ roots: ['app/api'], extensions: new Set(['.ts']) });
    const found = new Set<Capability>();
    const rule = /\bcapability\s*:\s*'([a-z_]+):([a-z_]+)'/g;
    for (const file of files) {
      const source = stripComments(readRepositoryFile(file));
      for (const match of source.matchAll(rule)) {
        const capability = `${match[1]}:${match[2]}` as Capability;
        found.add(capability);
      }
    }
    return found;
  }

  it('every capability held by at least one role is answered', () => {
    const routes = declaredCapabilities();
    for (const capability of ALL_CAPABILITIES) {
      const parsed = parseCapability(capability);
      if (parsed === null) continue;
      const held = ROLES.some(
        (role) => PERMISSION_MATRIX[role][parsed.resource][parsed.action].kind === 'ALLOW',
      );
      if (!held) {
        expect(routes.has(capability), `dead capability ${capability} is declared on a route`).toBe(
          false,
        );
        continue;
      }
      if (DELEGATED.has(capability) || ABSENT.has(capability)) continue;
      expect(
        routes.has(capability),
        `${capability} is ALLOW for a role but has no route, delegation or documented absence`,
      ).toBe(true);
    }
  });
});
