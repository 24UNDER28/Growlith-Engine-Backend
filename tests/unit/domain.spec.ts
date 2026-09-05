import { describe, expect, it } from 'vitest';

import {
  ENTITY_KINDS,
  HIERARCHY_ENTITIES,
  HIERARCHY_PARENT,
  IDENTITY_ENTITIES,
  SUPPORTING_ENTITIES,
  TENANT_ROOT,
  TENANT_SCOPED_ENTITIES,
  ancestorChain,
  isEntityKind,
  parentOf,
  REPORTING_ENTITIES,
} from '@/lib/domain/entities';
import {
  ORGANIZATION_ROLES,
  PLATFORM_ROLES,
  ROLES,
  ROLE_DEFINITIONS,
  type Role,
} from '@/lib/domain/roles';
import {
  SERVICE_LINES,
  SERVICE_LINE_DEFAULT_TEAM,
  SERVICE_LINE_LABELS,
  defaultTeamForServiceLine,
  isServiceLine,
} from '@/lib/domain/service-lines';
import {
  INTERNAL_TEAMS,
  TEAM_LABELS,
  isInternalTeam,
  teamLabel,
  type InternalTeam,
} from '@/lib/domain/teams';
import { readRepositoryFile } from '../helpers/repo';

/**
 * Domain vocabulary.
 *
 * WHY THIS SUITE EXISTS
 * `src/lib/domain/**` is data, not behaviour, so it has no logic to exercise —
 * and that is exactly why it went untested. In Phase 2 these arrays become
 * PostgreSQL `enum` types and the seed catalogue; in Phase 4 `ROLES` becomes the
 * row axis of the permission matrix; in Phase 9 they become navigation and
 * labels. A silent edit here is therefore not a cosmetic change, it is a schema
 * change — and enum values are the hardest kind of change to walk back once rows
 * reference them.
 *
 * These tests lock the vocabulary and its structural invariants so that any
 * change is a deliberate, reviewable diff in two places at once: here, and in
 * the migration that follows it.
 *
 * Per `tests/README.md`, assertions are written as explicit expected values
 * rather than snapshots. A snapshot would let a reviewer accept a changed role
 * list without reading what changed, which is the one failure mode this suite
 * exists to prevent.
 */

/** Values that must appear if, and only if, risk R-1 is still open. */
const FIFTH_ROLE_PROPOSAL = 'TEAM_MEMBER';

describe('role vocabulary — the Phase 2 enum and the Phase 4 matrix axis', () => {
  it('is exactly the four agreed roles, in declaration order', () => {
    // Enum declaration order is part of the contract: Phase 2 generates the
    // PostgreSQL enum from this list, and reordering it changes the migration.
    expect([...ROLES]).toEqual(['SUPER_ADMIN', 'ADMIN', 'CLIENT_ADMIN', 'CLIENT_MEMBER']);
  });

  it('keeps the two authorization axes disjoint', () => {
    expect([...PLATFORM_ROLES]).toEqual(['SUPER_ADMIN', 'ADMIN']);
    expect([...ORGANIZATION_ROLES]).toEqual(['CLIENT_ADMIN', 'CLIENT_MEMBER']);

    const overlap = PLATFORM_ROLES.filter((role) =>
      (ORGANIZATION_ROLES as readonly string[]).includes(role),
    );
    expect(
      overlap,
      'A role must be either platform-global or organization-scoped, never both. ' +
        'Conflating the axes is how a global CLIENT_ADMIN becomes thinkable.',
    ).toEqual([]);
  });

  it('defines every role exactly once, with no definitions for roles that do not exist', () => {
    const defined = Object.keys(ROLE_DEFINITIONS).sort();
    expect(defined).toEqual([...ROLES].sort());
  });

  it('agrees with itself about which roles are tenant-scoped', () => {
    for (const role of ROLES) {
      const definition = ROLE_DEFINITIONS[role];
      const isPlatform = (PLATFORM_ROLES as readonly string[]).includes(role);

      expect(
        definition.axis,
        `${role} is declared on the ${isPlatform ? 'platform' : 'organization'} axis`,
      ).toBe(isPlatform ? 'platform' : 'organization');

      // This is the property RLS depends on: a platform role must never carry a
      // tenant scope, and an organization role must always carry one. Getting it
      // backwards yields either a client user who can cross tenants or internal
      // staff who can see nothing.
      expect(definition.tenantScoped, `${role} tenant scoping`).toBe(!isPlatform);
      expect(definition.summary.length).toBeGreaterThan(0);
    }
  });

  it('records the known role-model gap as open, and fails the day it is closed silently', () => {
    // RISK R-1 TRIPWIRE.
    //
    // The four roles cannot express "internal staff limited to their own team and
    // assigned engagements", so every specialist needs cross-tenant ADMIN. That
    // is an accepted, documented gap — not an oversight — and the acceptance is
    // only honest while it is visible.
    //
    // This test binds the code and the risk register together. Adding a fifth
    // role fails here until `docs/architecture/README.md` §M is updated in the
    // same change; conversely, closing R-1 in the register without adding the
    // role also fails. Either direction forces the two artefacts to agree.
    const register = readRepositoryFile('docs/architecture/README.md');
    const riskRow = register.split('\n').find((line) => line.startsWith('| R-1 ')) ?? '';

    expect(
      riskRow,
      'Risk R-1 must remain a row in the §M risk register of ' +
        'docs/architecture/README.md. It records an open owner decision, and an ' +
        'undocumented risk is an unmanaged one.',
    ).not.toBe('');

    const gapRecordedAsOpen = riskRow.includes('Owner decision required');
    const fifthRoleExists = (ROLES as readonly string[]).includes(FIFTH_ROLE_PROPOSAL);

    if (ROLES.length > 4) {
      expect(
        gapRecordedAsOpen,
        `A fifth role has been added to src/lib/domain/roles.ts, which closes ` +
          `risk R-1. Update the §M risk register in docs/architecture/README.md ` +
          `(and docs/architecture/domain-model.md) in the same change, add the ` +
          `enum value to the Phase 2 migration, and extend the permission matrix ` +
          `in Phase 4 — then update this test to assert the new vocabulary.`,
      ).toBe(false);
      expect(fifthRoleExists, 'the fifth role should be the proposed one').toBe(true);
    } else {
      expect(ROLES).toHaveLength(4);
      expect(
        gapRecordedAsOpen,
        'R-1 is still open in the vocabulary, so the register must still record ' +
          'it as requiring an owner decision.',
      ).toBe(true);
    }
  });
});

describe('internal team vocabulary — who delivers', () => {
  it('is exactly the seven delivery teams', () => {
    expect([...INTERNAL_TEAMS]).toEqual([
      'ACCOUNT_MANAGEMENT',
      'SEO',
      'PAID_MEDIA',
      'WEB_DEVELOPMENT',
      'CRM_LIFECYCLE',
      'AI_AUTOMATION',
      'VIDEO_MULTIMEDIA',
    ]);
  });

  it('has no duplicate identifiers', () => {
    expect(new Set(INTERNAL_TEAMS).size).toBe(INTERNAL_TEAMS.length);
  });

  it('labels every team, and labels nothing else', () => {
    expect(Object.keys(TEAM_LABELS).sort()).toEqual([...INTERNAL_TEAMS].sort());
    for (const team of INTERNAL_TEAMS) {
      expect(teamLabel(team).length, `${team} needs a human-readable label`).toBeGreaterThan(0);
    }
  });

  it('recognises declared team identifiers and rejects everything else', () => {
    for (const team of INTERNAL_TEAMS) {
      expect(isInternalTeam(team)).toBe(true);
      expect(teamLabel(team).length).toBeGreaterThan(0);
    }

    // Case-sensitive by design: these identifiers become PostgreSQL enum labels.
    expect(isInternalTeam('')).toBe(false);
    expect(isInternalTeam('seo')).toBe(false);
    expect(isInternalTeam('SEO ')).toBe(false);
    expect(isInternalTeam('ENGINEERING')).toBe(false);
    // A service line is not a team, even where the words are similar.
    expect(isInternalTeam('PROGRAMMATIC_SEO')).toBe(false);
    expect(isInternalTeam('WEB_CORE')).toBe(false);
  });

  it('keeps display labels distinct from identifiers, except where the domain says otherwise', () => {
    // Labels are presentation and must never be persisted or sent to the API.
    // One deliberate exception: the SEO team's label is its identifier, because
    // the acronym is already the human-readable name. Locking the exception set
    // means a second one is a conscious diff rather than an accident.
    const labelEqualsIdentifier = INTERNAL_TEAMS.filter((team) => teamLabel(team) === team);
    expect([...labelEqualsIdentifier]).toEqual(['SEO']);
  });
});

describe('service line vocabulary — what the client bought', () => {
  it('is exactly the seven published service lines', () => {
    expect([...SERVICE_LINES]).toEqual([
      'PROGRAMMATIC_SEO',
      'PRECISION_PAID_MEDIA',
      'WEB_CORE',
      'LIFECYCLE_CRM',
      'AI_AUTOMATIONS',
      'VIDEO_MULTIMEDIA',
      'ACCOUNT_MANAGEMENT',
    ]);
  });

  it('is a genuinely distinct axis from internal teams', () => {
    // ADR-0006: a service line is *what the client bought*; a team is *who
    // delivers it*. They are separate enums and must not be merged — merging
    // would force per-client duplication of the catalogue and make reporting
    // across clients impossible.
    //
    // The proof that they are distinct is that the mapping between them is not
    // the identity function: five of the seven lines map to a differently-named
    // team. If a future edit makes them synonyms, this fails, and that is the
    // point — it means one of the two axes has stopped earning its place.
    const identityMapped = SERVICE_LINES.filter((line) => SERVICE_LINE_DEFAULT_TEAM[line] === line);
    expect([...identityMapped]).toEqual(['VIDEO_MULTIMEDIA', 'ACCOUNT_MANAGEMENT']);
    expect(SERVICE_LINES.length - identityMapped.length).toBeGreaterThanOrEqual(5);

    // Those two coincidences are real: Video & Multimedia and Account Management
    // are both a thing clients buy and a team that delivers it. They are locked
    // so that a *new* coincidence (renaming a line onto a team identifier) shows
    // up as a deliberate change rather than a silent one.
    const sharedIdentifiers = SERVICE_LINES.filter((line) =>
      (INTERNAL_TEAMS as readonly string[]).includes(line),
    ).sort();
    expect([...sharedIdentifiers]).toEqual(['ACCOUNT_MANAGEMENT', 'VIDEO_MULTIMEDIA']);
  });

  it('labels every service line, and labels nothing else', () => {
    expect(Object.keys(SERVICE_LINE_LABELS).sort()).toEqual([...SERVICE_LINES].sort());
  });

  it('maps every service line to a real team', () => {
    // Totality is the invariant Phase 2 relies on when it seeds
    // `services.delivering_team_id`. A missing entry would make the seed depend
    // on which line it happened to be processing.
    expect(Object.keys(SERVICE_LINE_DEFAULT_TEAM).sort()).toEqual([...SERVICE_LINES].sort());

    for (const line of SERVICE_LINES) {
      const team = defaultTeamForServiceLine(line);
      expect(isInternalTeam(team), `${line} must default to a declared team`).toBe(true);
      expect(team).toBe(SERVICE_LINE_DEFAULT_TEAM[line]);
    }
  });

  it('leaves no team without a service line to deliver', () => {
    // An orphan team is a modelling error: it would exist in the schema with no
    // way to be assigned work by default. Note this is deliberately weaker than
    // asserting a 1:1 correspondence — ADR-0006 expects the relationship to
    // become N:M (a Web Core engagement jointly delivered by WEB_DEVELOPMENT and
    // SEO), and that must not require a change to this test.
    const defaulted = new Set<InternalTeam>(Object.values(SERVICE_LINE_DEFAULT_TEAM));
    const orphans = INTERNAL_TEAMS.filter((team) => !defaulted.has(team));
    expect(orphans).toEqual([]);
  });

  it('recognises service lines by identifier only', () => {
    for (const line of SERVICE_LINES) {
      expect(isServiceLine(line)).toBe(true);
      expect(isServiceLine(SERVICE_LINE_LABELS[line])).toBe(false);
    }

    expect(isServiceLine('')).toBe(false);
    expect(isServiceLine('SEO')).toBe(false);
    expect(isServiceLine('web_core')).toBe(false);
  });
});

describe('entity hierarchy — the containment model RLS is built on', () => {
  it('is exactly the six hierarchy entities, root first', () => {
    // Order is depth order. Phase 2 uses it to reason about composite foreign
    // keys, and the API route taxonomy nests in the same sequence.
    expect([...HIERARCHY_ENTITIES]).toEqual([
      'organization',
      'engagement',
      'service',
      'project',
      'deliverable',
      'task',
    ]);
  });

  it('keeps supporting entities separate from the hierarchy', () => {
    expect([...SUPPORTING_ENTITIES]).toEqual(['comment', 'attachment', 'metric', 'notification']);

    const overlap = HIERARCHY_ENTITIES.filter((entity) =>
      (SUPPORTING_ENTITIES as readonly string[]).includes(entity),
    );
    expect(overlap).toEqual([]);
    expect(new Set(ENTITY_KINDS).size, 'entity kinds must be unique').toBe(ENTITY_KINDS.length);
    expect([...ENTITY_KINDS]).toEqual([
      ...HIERARCHY_ENTITIES,
      ...SUPPORTING_ENTITIES,
      ...IDENTITY_ENTITIES,
      ...REPORTING_ENTITIES,
    ]);
  });

  it('keeps identity entities global — a profile is never tenant-scoped', () => {
    // `profile` arrives in Phase 3 as the audit subject for authentication
    // events. It must stay outside BOTH the hierarchy and the supporting set,
    // and it must never appear among tenant-scoped entities: a person exists
    // once, globally, not once per tenant.
    expect([...IDENTITY_ENTITIES]).toEqual(['profile']);
    expect(HIERARCHY_ENTITIES).not.toContain('profile');
    expect(SUPPORTING_ENTITIES).not.toContain('profile');
    expect(TENANT_SCOPED_ENTITIES).not.toContain('profile');
  });

  it('declares a parent for every hierarchy entity and exactly one tenant root', () => {
    expect(Object.keys(HIERARCHY_PARENT).sort()).toEqual([...HIERARCHY_ENTITIES].sort());
    expect(TENANT_ROOT).toBe('organization');
    expect(HIERARCHY_PARENT[TENANT_ROOT]).toBeNull();

    const roots = HIERARCHY_ENTITIES.filter((entity) => HIERARCHY_PARENT[entity] === null);
    expect(
      roots,
      'Exactly one entity may be the tenant root. A second root would mean a ' +
        'second place where tenant isolation begins, and RLS cannot express that.',
    ).toEqual([TENANT_ROOT]);
  });

  it('forms a single acyclic chain that terminates at the tenant root', () => {
    for (const entity of HIERARCHY_ENTITIES) {
      const chain = ancestorChain(entity);

      expect(
        new Set(chain).size,
        `${entity} has a cycle in its ancestry — ancestorChain would not terminate`,
      ).toBe(chain.length);

      if (entity === TENANT_ROOT) {
        expect(chain).toEqual([]);
        continue;
      }

      // Nearest ancestor first, tenant root last. Every non-root entity must be
      // able to reach the root, or its organization_id could not be derived.
      expect(chain.at(-1), `${entity} must reach the tenant root`).toBe(TENANT_ROOT);
      expect(chain[0], `${entity}'s nearest ancestor`).toBe(parentOf(entity));
    }
  });

  it('produces the full chain for the deepest entity', () => {
    expect(ancestorChain('task')).toEqual([
      'deliverable',
      'project',
      'service',
      'engagement',
      'organization',
    ]);
    expect(parentOf('task')).toBe('deliverable');
    expect(parentOf('organization')).toBeNull();
  });

  it('treats every non-identity entity except the tenant root as tenant-scoped', () => {
    // This is the exact set of tables that must carry `organization_id` and be
    // covered by a tenant-isolation RLS policy in Phase 2. Asserting it as a
    // derivation of the vocabulary means a new entity cannot be added without
    // someone deciding, explicitly, whether it is tenant-scoped. Identity
    // entities (Phase 3) are global by design and excluded from the derivation.
    const expected = ENTITY_KINDS.filter(
      (entity) =>
        entity !== TENANT_ROOT && !(IDENTITY_ENTITIES as readonly string[]).includes(entity),
    );
    expect([...TENANT_SCOPED_ENTITIES].sort()).toEqual([...expected].sort());
    expect(TENANT_SCOPED_ENTITIES).not.toContain(TENANT_ROOT);
  });

  it('recognises entity kinds and rejects anything else', () => {
    for (const entity of ENTITY_KINDS) {
      expect(isEntityKind(entity)).toBe(true);
    }

    expect(isEntityKind('')).toBe(false);
    expect(isEntityKind('Task')).toBe(false);
    expect(isEntityKind('user')).toBe(false);
    expect(isEntityKind('__proto__')).toBe(false);
  });
});

describe('vocabulary shape — invariants Phase 2 and Phase 4 depend on', () => {
  it('uses SCREAMING_SNAKE_CASE for enums and lowercase for entity kinds', () => {
    // Two conventions, each load-bearing: PostgreSQL enum labels are rendered in
    // the UI and in logs, so they are uppercase; entity kinds name tables and
    // API route segments, so they are lowercase. Mixing them produces either
    // shouting table names or unreadable enum labels.
    const upperSnake = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
    const lowerSnake = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

    for (const role of ROLES as readonly string[]) {
      expect(role, `${role} is a PostgreSQL enum label`).toMatch(upperSnake);
    }
    for (const team of INTERNAL_TEAMS as readonly string[]) {
      expect(team).toMatch(upperSnake);
    }
    for (const line of SERVICE_LINES as readonly string[]) {
      expect(line).toMatch(upperSnake);
    }
    for (const entity of ENTITY_KINDS as readonly string[]) {
      expect(entity, `${entity} names a table and a route segment`).toMatch(lowerSnake);
    }
  });

  it('exposes every role as a usable type member', () => {
    // Compile-time check with a runtime assertion: if `Role` ever stops being the
    // union of `ROLES`, this assignment fails to type-check.
    const assignable: Role[] = [...ROLES];
    expect(assignable).toHaveLength(ROLES.length);
  });
});
