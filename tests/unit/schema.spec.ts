import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ENTITY_KINDS, TENANT_SCOPED_ENTITIES } from '@/lib/domain/entities';
import { ORGANIZATION_ROLES, PLATFORM_ROLES } from '@/lib/domain/roles';
import { SERVICE_LINES } from '@/lib/domain/service-lines';
import { INTERNAL_TEAMS } from '@/lib/domain/teams';
import { REPO_ROOT, readRepositoryFile } from '../helpers/repo';

/**
 * Schema contract.
 *
 * WHY THIS SUITE EXISTS
 * `scripts/db-verify.mjs` is the real proof: it applies the migrations to a
 * live PostgreSQL and asserts behaviour. But it needs a database, so it cannot
 * run in the default `npm test`. The failure mode that leaves is a developer
 * editing `src/lib/domain/roles.ts`, seeing green, and shipping a TypeScript
 * vocabulary that no longer matches the enum rows already in production.
 *
 * These tests close exactly that gap by reading the migration SQL as text. They
 * are not a substitute for `db:verify`; they are the part of it that can run
 * with no infrastructure, and they fail on the one class of drift that is both
 * silent and expensive.
 */

const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function allMigrationSql(): string {
  return migrationFiles()
    .map((file) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    .join('\n');
}

/** Extract the value list of a `create type public.<name> as enum (...)`. */
function enumValues(sql: string, typeName: string): string[] {
  const pattern = new RegExp(
    `create\\s+type\\s+public\\.${typeName}\\s+as\\s+enum\\s*\\(([^)]*)\\)`,
    'i',
  );
  const match = pattern.exec(sql);
  if (match?.[1] === undefined) {
    throw new Error(`enum public.${typeName} not found in the migrations`);
  }
  const values = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string);

  // Additive values from later migrations (`alter type ... add value`), in
  // migration order — PostgreSQL appends them after the value list, which is
  // exactly how ENTITY_KINDS and friends mirror the vocabulary. Introduced by
  // the Phase 3 auth migrations; the same rule applies to any future addition.
  const alterations = [
    ...sql.matchAll(
      new RegExp(`alter\\s+type\\s+public\\.${typeName}\\s+add\\s+value\\s+'([^']+)'`, 'gi'),
    ),
  ].map((m) => m[1] as string);

  return [...values, ...alterations];
}

describe('migration files', () => {
  const files = migrationFiles();

  it('exist', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('are named YYYYMMDDHHMMSS_snake_case.sql', () => {
    for (const file of files) {
      expect(file).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
    }
  });

  it('have unique, strictly increasing timestamps', () => {
    // Two migrations sharing a timestamp have no defined order, so a clean
    // apply and an incremental apply can diverge.
    const stamps = files.map((f) => f.slice(0, 14));
    expect(new Set(stamps).size).toBe(stamps.length);
    expect([...stamps].sort()).toEqual(stamps);
  });

  it('never use `drop table` or `drop column`', () => {
    // Forward-only. Destroying a table or column in a migration destroys client
    // data and audit evidence; the correct move is a new nullable column, a
    // backfill, and a later deprecation with an explicit ADR.
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
        .replace(/--[^\n]*/g, '')
        .toLowerCase();
      expect(sql, `${file} drops a table`).not.toMatch(/\bdrop\s+table\b/);
      expect(sql, `${file} drops a column`).not.toMatch(/\bdrop\s+column\b/);
    }
  });

  it('pin search_path on every function they define', () => {
    // A SECURITY DEFINER function with a mutable search_path is a real
    // privilege-escalation vector, and Supabase's own linter flags it.
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const definitions = sql.split(/create\s+or\s+replace\s+function/i).slice(1);
      for (const body of definitions) {
        const head = body.slice(0, body.indexOf('$$'));
        expect(head, `a function in ${file} has no pinned search_path`).toMatch(
          /set\s+search_path\s*=/i,
        );
      }
    }
  });
});

describe('enum parity with src/lib/domain', () => {
  const sql = allMigrationSql();

  it('platform_role matches PLATFORM_ROLES', () => {
    expect(enumValues(sql, 'platform_role')).toEqual([...PLATFORM_ROLES]);
  });

  it('organization_role matches ORGANIZATION_ROLES', () => {
    expect(enumValues(sql, 'organization_role')).toEqual([...ORGANIZATION_ROLES]);
  });

  it('team matches INTERNAL_TEAMS', () => {
    expect(enumValues(sql, 'team')).toEqual([...INTERNAL_TEAMS]);
  });

  it('service_line matches SERVICE_LINES', () => {
    expect(enumValues(sql, 'service_line')).toEqual([...SERVICE_LINES]);
  });

  it('entity_kind matches ENTITY_KINDS exactly, including order', () => {
    // Order matters: enum sort order is what `order by status` uses, and
    // reordering an enum in place is not possible without a type rewrite.
    expect(enumValues(sql, 'entity_kind')).toEqual([...ENTITY_KINDS]);
  });

  it('account_status carries the four required values', () => {
    expect(enumValues(sql, 'account_status')).toEqual([
      'INVITED',
      'ACTIVE',
      'SUSPENDED',
      'DEACTIVATED',
    ]);
  });

  it('still has exactly two platform roles while risk R-1 is open', () => {
    // The tripwire from Phase 1, extended to the database. When Phase 4 adds
    // TEAM_MEMBER, this test fails and forces the enum, the domain module, the
    // risk register and the policy layer to be updated in one change.
    expect(enumValues(sql, 'platform_role')).not.toContain('TEAM_MEMBER');
  });
});

describe('tenant isolation is structural', () => {
  const sql = allMigrationSql();

  /**
   * The EFFECTIVE foreign-key constraints: the last definition of each
   * constraint name, replayed across the migrations in filename order.
   *
   * Migrations are forward-only, so a superseded declaration stays in the file
   * that wrote it — a plain grep over the concatenated SQL reports a defect
   * that was fixed three migrations later. Replaying drops and re-adds is what
   * makes this check mean what the database actually does.
   */
  function effectiveConstraints(): Array<{
    name: string;
    composite: boolean;
    deleteAction: string | null;
    setNullColumns: string | null;
    referencesOrganizations: boolean;
  }> {
    // The trailing group captures the `on update … on delete …` clauses that
    // belong to THIS constraint. It is anchored on `on update|on delete` so it
    // stops at the next constraint rather than running into it.
    const definition =
      /constraint\s+([a-z_]+)\s+foreign\s+key\s*\(([^)]*)\)\s*references\s+(?:public\.)?([a-z_]+)\s*\(([^)]*)\)((?:[ \t]*(?:\r?\n)?\s*on\s+(?:update|delete)\s+(?:cascade|restrict|no\s+action|set\s+null|set\s+default)(?:\s*\([^)]*\))?)*)/gi;

    const state = new Map<
      string,
      {
        name: string;
        composite: boolean;
        deleteAction: string | null;
        setNullColumns: string | null;
        referencesOrganizations: boolean;
      }
    >();

    for (const file of migrationFiles()) {
      const text = readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(/--[^\n]*/g, '');

      for (const drop of text.matchAll(/drop\s+constraint\s+(?:if\s+exists\s+)?([a-z_]+)/gi)) {
        state.delete(drop[1] as string);
      }

      for (const m of text.matchAll(definition)) {
        const [, name, childCols, parent, , clauses] = m;
        const action =
          /\bon\s+delete\s+(cascade|restrict|no\s+action|set\s+null|set\s+default)(?:\s*\(([^)]*)\))?/i.exec(
            clauses as string,
          );
        state.set(name as string, {
          name: name as string,
          composite: (childCols as string).includes(','),
          deleteAction: action ? (action[1] as string).toLowerCase().replace(/\s+/g, ' ') : null,
          setNullColumns: action?.[2] ? (action[2] as string).trim() : null,
          referencesOrganizations: (parent as string).toLowerCase() === 'organizations',
        });
      }
    }

    return [...state.values()];
  }

  // Tables that must carry organization_id and reach their parent through it.
  const TENANT_TABLES = [
    'engagements',
    'services',
    'projects',
    'project_memberships',
    'deliverables',
    'deliverable_versions',
    'tasks',
    'comments',
    'files',
    'reports',
    'report_metrics',
    'metrics',
  ] as const;

  it.each(TENANT_TABLES)('%s declares organization_id NOT NULL', (table) => {
    const pattern = new RegExp(
      `create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
      'i',
    );
    const body = pattern.exec(sql)?.[1];
    expect(body, `table ${table} not found`).toBeDefined();
    expect(body).toMatch(/organization_id\s+uuid\s+not\s+null/i);
  });

  it.each([
    'services',
    'projects',
    'project_memberships',
    'deliverables',
    'deliverable_versions',
    'tasks',
    'comments',
    'files',
    'report_metrics',
    'metrics',
  ])('%s reaches its parent through a composite foreign key', (table) => {
    const pattern = new RegExp(
      `create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
      'i',
    );
    const body = pattern.exec(sql)?.[1] ?? '';
    expect(body).toMatch(/foreign\s+key\s*\([a-z_]+,\s*organization_id\)/i);
  });

  it('every hierarchy table is a composite-FK target', () => {
    for (const table of ['engagements', 'services', 'projects', 'deliverables', 'tasks']) {
      expect(sql).toMatch(
        new RegExp(
          `constraint\\s+${table}_id_org_key\\s+unique\\s*\\(id,\\s*organization_id\\)`,
          'i',
        ),
      );
    }
  });

  it('leaves no composite foreign key with a bare SET NULL', () => {
    // A composite FK is always (parent_id, organization_id). A bare
    // `on delete set null` nulls BOTH columns, and organization_id is NOT NULL
    // and frozen by growlith.freeze_organization_id() — so the referential
    // action can never succeed and the parent cannot be deleted at all. Only
    // the PostgreSQL 15+ column-list form (`set null (parent_id)`) is
    // reachable.
    //
    // Migrations are forward-only, so a superseded declaration stays in the
    // migration that wrote it. This resolves the EFFECTIVE state — last
    // definition per constraint name, in filename order — which is what a
    // naive grep over the concatenation would get wrong.
    const violations = effectiveConstraints().filter(
      (c) => c.composite && c.deleteAction === 'set null' && c.setNullColumns === null,
    );
    expect(
      violations.map((c) => c.name),
      'a bare SET NULL also nulls organization_id, which is NOT NULL and ' +
        'immutable — name the column instead: `on delete set null (parent_id)`',
    ).toEqual([]);
  });

  it('leaves no foreign key into organizations cascading', () => {
    // The tenant root never cascades. One DELETE on organizations would
    // otherwise physically remove a client's files, metrics, reports,
    // membership history and invitations, bypassing the soft-delete retention
    // policy the rest of the schema is built on. Deleting a tenant is the
    // SUPER_ADMIN purge: ordered, explicit, and audited.
    const violations = effectiveConstraints().filter(
      (c) => c.referencesOrganizations && c.deleteAction === 'cascade',
    );
    expect(
      violations.map((c) => c.name),
      'use ON DELETE RESTRICT and let the purge delete children explicitly',
    ).toEqual([]);
  });

  it('declares RLS on every table it creates', () => {
    const created = [
      ...allMigrationSql().matchAll(/create\s+table\s+if\s+not\s+exists\s+public\.([a-z_]+)/gi),
    ].map((m) => m[1] as string);

    expect(created.length).toBeGreaterThan(15);

    for (const table of created) {
      expect(sql, `${table} does not enable RLS`).toMatch(
        new RegExp(
          `alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`,
          'i',
        ),
      );
      expect(sql, `${table} does not force RLS`).toMatch(
        new RegExp(`alter\\s+table\\s+public\\.${table}\\s+force\\s+row\\s+level\\s+security`, 'i'),
      );
    }
  });

  it('covers every tenant-scoped domain entity with a table', () => {
    // TENANT_SCOPED_ENTITIES is the domain layer's list; each must exist as a
    // table so nothing in the vocabulary is unimplemented.
    const entityToTable: Record<string, string> = {
      engagement: 'engagements',
      service: 'services',
      project: 'projects',
      deliverable: 'deliverables',
      task: 'tasks',
      comment: 'comments',
      attachment: 'files',
      metric: 'metrics',
      notification: 'notifications',
    };

    for (const entity of TENANT_SCOPED_ENTITIES) {
      const table = entityToTable[entity];
      expect(table, `no table mapped for entity ${entity}`).toBeDefined();
      expect(sql).toMatch(
        new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\b`, 'i'),
      );
    }
  });
});

describe('generated types', () => {
  const types = readRepositoryFile('src/types/database.ts');

  it('are marked generated', () => {
    expect(types).toContain('GENERATED FILE — DO NOT EDIT BY HAND');
  });

  it('describe the Phase 2 schema rather than the empty Phase 1 placeholder', () => {
    expect(types).not.toContain('Tables: Record<string, never>');
    for (const table of ['organizations', 'engagements', 'deliverables', 'tasks', 'audit_events']) {
      expect(types).toContain(`${table}: {`);
    }
  });

  it('expose the domain enums', () => {
    for (const name of ['platform_role', 'organization_role', 'account_status', 'team']) {
      expect(types).toContain(`${name}:`);
    }
  });
});

describe('seed data', () => {
  const seed = readRepositoryFile('supabase/seed.sql');

  it('uses only reserved test domains', () => {
    // RFC 2606 reserves `.test`; it cannot resolve, so a stray email in a local
    // stack cannot reach a real person.
    const emails = [...seed.matchAll(/'([^']*@[^']*)'/g)].map((m) => m[1] as string);
    expect(emails.length).toBeGreaterThan(0);
    for (const email of emails) {
      expect(email, `${email} is not on a reserved test domain`).toMatch(/\.test$/);
    }
  });

  it('creates two organizations, because isolation cannot be shown with one', () => {
    const inserts = seed.match(/insert\s+into\s+public\.organizations/gi) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    expect(seed).toContain('acme-industrials');
    expect(seed).toContain('globex-health');
  });
});
