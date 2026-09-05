#!/usr/bin/env node
/**
 * Schema verification against a live PostgreSQL.
 *
 * Two halves:
 *
 *   1. STRUCTURE — inspects the catalog. Every table has a PK; every FK column
 *      is indexed; every tenant table carries organization_id, a composite FK
 *      through it, and the `(id, organization_id)` unique index that FK needs;
 *      RLS is enabled and forced everywhere.
 *
 *   2. BEHAVIOUR — inserts real rows and asserts the integrity rules actually
 *      fire: cross-tenant writes rejected, tenant key derived and frozen,
 *      illegal status transitions refused, append-only tables immutable,
 *      audit rows written.
 *
 * Structure alone is not evidence. A composite FK that exists but is never
 * violated in a test proves nothing about whether it points where it should.
 *
 * Usage: DATABASE_URL=... node scripts/db-verify.mjs
 */

import pg from 'pg';

const results = [];
let failures = 0;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
}

function check(name, condition, detail = '') {
  record(name, Boolean(condition), detail);
}

/** Assert that a statement fails, and that it fails for the expected reason. */
async function expectFailure(client, name, sql, params, expectedFragment) {
  await client.query('savepoint sp');
  try {
    await client.query(sql, params);
    await client.query('rollback to savepoint sp');
    record(name, false, 'statement unexpectedly succeeded');
  } catch (error) {
    await client.query('rollback to savepoint sp');
    const message = String(error.message);
    const matched =
      !expectedFragment || message.toLowerCase().includes(expectedFragment.toLowerCase());
    record(name, matched, matched ? '' : `rejected, but with: ${message}`);
  }
}

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
  'organization_memberships',
];

// Composite-FK targets: tables children point at via (id, organization_id).
const COMPOSITE_FK_TARGETS = [
  'engagements',
  'services',
  'projects',
  'deliverables',
  'deliverable_versions',
  'tasks',
  'comments',
  'reports',
  'files',
];

async function verifyStructure(client) {
  // --- Every table has a primary key -------------------------------------
  const { rows: noPk } = await client.query(`
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not exists (
        select 1 from pg_constraint k
        where k.conrelid = c.oid and k.contype = 'p'
      )
    order by 1
  `);
  check('every table has a primary key', noPk.length === 0, noPk.map((r) => r.relname).join(', '));

  // --- RLS enabled and forced --------------------------------------------
  const { rows: noRls } = await client.query(`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and (not c.relrowsecurity or not c.relforcerowsecurity)
    order by 1
  `);
  check(
    'RLS enabled and forced on every table',
    noRls.length === 0,
    noRls.map((r) => r.relname).join(', '),
  );

  // --- Tenant tables carry a NOT NULL organization_id --------------------
  for (const table of TENANT_TABLES) {
    const { rows } = await client.query(
      `select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = $1 and column_name = 'organization_id'`,
      [table],
    );
    check(
      `${table}.organization_id exists and is NOT NULL`,
      rows.length === 1 && rows[0].is_nullable === 'NO',
      rows.length === 0 ? 'column missing' : `nullable=${rows[0]?.is_nullable}`,
    );
  }

  // --- Composite-FK targets have their (id, organization_id) unique key ---
  for (const table of COMPOSITE_FK_TARGETS) {
    const { rows } = await client.query(
      `select 1
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = $1 and k.contype = 'u'
         and (
           select array_agg(a.attname::text order by a.attname::text)
           from unnest(k.conkey) ck(attnum)
           join pg_attribute a on a.attrelid = k.conrelid and a.attnum = ck.attnum
         ) = array['id','organization_id']::text[]`,
      [table],
    );
    check(`${table} has unique (id, organization_id)`, rows.length === 1);
  }

  // --- Tenant children reach their parent through a COMPOSITE FK ----------
  const { rows: compositeFks } = await client.query(`
    select c.relname as child, k.conname, array_length(k.conkey, 1) as cols
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and k.contype = 'f' and array_length(k.conkey, 1) = 2
  `);
  const withComposite = new Set(compositeFks.map((r) => r.child));
  for (const table of [
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
  ]) {
    check(`${table} reaches its parent by composite FK`, withComposite.has(table));
  }

  // --- Every FK column is indexed ----------------------------------------
  // An unindexed FK turns every parent delete and every cascade into a
  // sequential scan of the child table.
  const { rows: fkList } = await client.query(`
    select c.relname, k.conname, k.conkey::int2[] as cols, c.oid as relid
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and k.contype = 'f'
    order by 1, 2
  `);
  const { rows: idxList } = await client.query(`
    -- indkey is an int2vector: zero-based once cast, so element order is the
    -- index's column order and slicing is done in JS below.
    select i.indrelid as relid, i.indkey::int2[] as cols
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
  `);
  const indexesByRel = new Map();
  for (const idx of idxList) {
    if (!indexesByRel.has(idx.relid)) indexesByRel.set(idx.relid, []);
    indexesByRel.get(idx.relid).push(idx.cols.map(Number));
  }
  const unindexed = fkList.filter((fk) => {
    const fkCols = fk.cols.map(Number);
    const candidates = indexesByRel.get(fk.relid) ?? [];
    // An index serves a FK when the FK's columns are exactly its leading
    // columns, in any order (a multi-column index is usable as a prefix).
    return !candidates.some((idxCols) => {
      const prefix = idxCols.slice(0, fkCols.length);
      return (
        prefix.length === fkCols.length &&
        fkCols.every((c) => prefix.includes(c)) &&
        prefix.every((c) => fkCols.includes(c))
      );
    });
  });
  check(
    'every foreign key is index-backed',
    unindexed.length === 0,
    unindexed.map((r) => `${r.relname}.${r.conname}`).join(', '),
  );

  // --- Enum parity with the domain layer ---------------------------------
  const { rows: entityKinds } = await client.query(`
    select e.enumlabel
    from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'entity_kind' order by e.enumsortorder
  `);
  const expected = [
    'organization',
    'engagement',
    'service',
    'project',
    'deliverable',
    'task',
    'comment',
    'attachment',
    'metric',
    'notification',
  ];
  check(
    'entity_kind matches src/lib/domain/entities.ts',
    JSON.stringify(entityKinds.map((r) => r.enumlabel)) === JSON.stringify(expected),
  );

  // --- Reference data seeded ---------------------------------------------
  const { rows: teamCount } = await client.query('select count(*)::int as n from public.teams');
  check('seven teams seeded', teamCount[0].n === 7, `found ${teamCount[0].n}`);
  const { rows: lineCount } = await client.query(
    'select count(*)::int as n from public.service_lines',
  );
  check('seven service lines seeded', lineCount[0].n === 7, `found ${lineCount[0].n}`);
  const { rows: transitions } = await client.query(
    'select count(*)::int as n from public.status_transitions',
  );
  check('status transitions seeded', transitions[0].n > 50, `found ${transitions[0].n}`);

  // --- Audit partitions ---------------------------------------------------
  const { rows: parts } = await client.query(`
    select count(*)::int as n from pg_inherits i
    join pg_class p on p.oid = i.inhparent
    where p.relname = 'audit_events'
  `);
  check(
    'audit_events is partitioned with a year of partitions',
    parts[0].n >= 13,
    `found ${parts[0].n}`,
  );

  // --- Internal-only columns are not granted to `authenticated` ----------
  for (const [table, column] of [
    ['engagements', 'contract_value'],
    ['engagements', 'monthly_retainer'],
    ['engagements', 'notes_internal'],
    ['services', 'fee'],
  ]) {
    const { rows } = await client.query(
      `select has_column_privilege('authenticated', $1, $2, 'SELECT') as granted`,
      [`public.${table}`, column],
    );
    check(`${table}.${column} is NOT readable by authenticated`, rows[0].granted === false);
  }
  const { rows: visible } = await client.query(
    `select has_column_privilege('authenticated', 'public.engagements', 'name', 'SELECT') as granted`,
  );
  check('engagements.name IS readable by authenticated', visible[0].granted === true);

  // --- No role may DELETE -------------------------------------------------
  const { rows: del } = await client.query(
    `select has_table_privilege('authenticated', 'public.deliverables', 'DELETE') as granted`,
  );
  check('authenticated cannot DELETE (soft delete only)', del[0].granted === false);
}

async function verifyBehaviour(client) {
  await client.query('begin');

  // Two tenants and two people: the minimum fixture that can demonstrate
  // isolation at all.
  const {
    rows: [{ id: userA }],
  } = await client.query(
    `insert into auth.users (email, raw_user_meta_data, email_confirmed_at)
     values ('staff@growlith.test', '{"full_name":"Staff One","user_type":"INTERNAL"}', now())
     returning id`,
  );
  const {
    rows: [{ id: clientUser }],
  } = await client.query(
    `insert into auth.users (email, raw_user_meta_data, email_confirmed_at)
     values ('client@acme.test', '{"full_name":"Client One","user_type":"CLIENT"}', now())
     returning id`,
  );

  // Counted relative to the ids just created, so the suite gives the same
  // result against an empty database and against a seeded one.
  const { rows: profileRows } = await client.query(
    'select id, user_type, account_status from public.profiles where id = any($1::uuid[])',
    [[userA, clientUser]],
  );
  check('profile auto-created for each auth user', profileRows.length === 2);
  check(
    'user_type derived from auth metadata',
    profileRows.some((r) => r.user_type === 'INTERNAL') &&
      profileRows.some((r) => r.user_type === 'CLIENT'),
  );
  check(
    'account_status ACTIVE for a confirmed auth user',
    profileRows.every((r) => r.account_status === 'ACTIVE'),
  );

  const mkOrg = async (slug) => {
    const { rows } = await client.query(
      `insert into public.organizations (slug, legal_name, display_name, region, primary_currency, status)
       values ($1::extensions.citext, $2, $2, 'NYC', 'USD', 'ACTIVE') returning id`,
      [slug, slug],
    );
    return rows[0].id;
  };
  const orgA = await mkOrg('acme');
  const orgB = await mkOrg('globex');

  const { rows: settings } = await client.query(
    'select count(*)::int as n from public.organization_settings where organization_id = any($1::uuid[])',
    [[orgA, orgB]],
  );
  check('organization_settings auto-created 1:1', settings[0].n === 2);

  await expectFailure(
    client,
    'duplicate live slug rejected',
    `insert into public.organizations (slug, legal_name, display_name, region, primary_currency)
     values ('acme', 'x', 'x', 'LDN', 'GBP')`,
    [],
    'duplicate key',
  );

  const mkEngagement = async (org, code, currency = 'USD') => {
    const { rows } = await client.query(
      `insert into public.engagements
         (organization_id, code, name, engagement_type, currency, monthly_retainer, start_date, status, signed_at)
       values ($1, $2, $3, 'RETAINER', $4, 10000, current_date, 'ACTIVE', now()) returning id`,
      [org, code, code, currency],
    );
    return rows[0].id;
  };
  const engA = await mkEngagement(orgA, 'ENG-A');
  const engB = await mkEngagement(orgB, 'ENG-B');

  await expectFailure(
    client,
    'retainer without an amount rejected',
    `insert into public.engagements (organization_id, code, name, engagement_type, currency, start_date)
     values ($1, 'ENG-X', 'x', 'RETAINER', 'USD', current_date)`,
    [orgA],
    'engagements_retainer_requires_amount',
  );

  await expectFailure(
    client,
    'ACTIVE engagement without a signature rejected',
    `insert into public.engagements
       (organization_id, code, name, engagement_type, currency, monthly_retainer, start_date, status)
     values ($1, 'ENG-Y', 'y', 'RETAINER', 'USD', 100, current_date, 'ACTIVE')`,
    [orgA],
    'engagements_active_requires_signature',
  );

  // --- Tenant key derivation ---------------------------------------------
  await expectFailure(
    client,
    'declaring the wrong tenant is rejected, not silently corrected',
    `insert into public.services
       (organization_id, engagement_id, service_line, delivering_team, name, currency, start_date)
     values ($1, $2, 'PROGRAMMATIC_SEO', 'SEO', 'mismatch', 'USD', current_date)`,
    [orgB, engA], // engagement is org A
    'tenant mismatch',
  );

  // organization_id omitted entirely: the trigger supplies it from the parent.
  const {
    rows: [svcA],
  } = await client.query(
    `insert into public.services
       (engagement_id, service_line, delivering_team, name, currency, start_date, status)
     values ($1, 'PROGRAMMATIC_SEO', 'SEO', 'SEO retainer', 'USD', current_date, 'ACTIVE')
     returning id, organization_id`,
    [engA],
  );
  check(
    'organization_id is derived from the parent when omitted',
    svcA.organization_id === orgA,
    `got ${svcA.organization_id}`,
  );

  await expectFailure(
    client,
    'service currency must match its engagement',
    `insert into public.services
       (organization_id, engagement_id, service_line, delivering_team, name, currency, start_date)
     values ($1, $2, 'WEB_CORE', 'WEB_DEVELOPMENT', 'x', 'GBP', current_date)`,
    [orgA, engA],
    'must match engagement currency',
  );

  await expectFailure(
    client,
    'tenant key is immutable',
    `update public.services set organization_id = $1 where id = $2`,
    [orgB, svcA.id],
    'immutable',
  );

  const {
    rows: [projA],
  } = await client.query(
    `insert into public.projects (organization_id, service_id, code, name, owning_team, status)
     values ($1, $2, 'PRJ-1', 'Rebuild', 'SEO', 'IN_PROGRESS') returning id, organization_id`,
    [orgA, svcA.id],
  );

  const {
    rows: [delA],
  } = await client.query(
    `insert into public.deliverables (organization_id, project_id, title, deliverable_type)
     values ($1, $2, 'Q4 audit', 'AUDIT') returning id, client_visible, status`,
    [orgA, projA.id],
  );
  check('deliverables default to client_visible = false', delA.client_visible === false);

  // --- The composite FK, exercised ---------------------------------------
  const {
    rows: [svcB],
  } = await client.query(
    `insert into public.services
       (organization_id, engagement_id, service_line, delivering_team, name, currency, start_date)
     values ($1, $2, 'WEB_CORE', 'WEB_DEVELOPMENT', 'B web', 'USD', current_date) returning id`,
    [orgB, engB],
  );
  const {
    rows: [projB],
  } = await client.query(
    `insert into public.projects (organization_id, service_id, code, name, owning_team)
     values ($1, $2, 'PRJ-B', 'B project', 'WEB_DEVELOPMENT') returning id`,
    [orgB, svcB.id],
  );
  const {
    rows: [delB],
  } = await client.query(
    `insert into public.deliverables (organization_id, project_id, title, deliverable_type)
     values ($1, $2, 'B deliverable', 'REPORT') returning id`,
    [orgB, projB.id],
  );

  // Org A's project pointing at org B's service: the FK must refuse.
  await expectFailure(
    client,
    'cross-tenant project rejected',
    `insert into public.projects (organization_id, service_id, code, name, owning_team)
     values ($1, $2, 'PRJ-EVIL', 'evil', 'SEO')`,
    [orgA, svcB.id], // service belongs to org B
    'tenant mismatch',
  );

  // --- The ADR-0005 task edge --------------------------------------------
  const {
    rows: [taskA],
  } = await client.query(
    `insert into public.tasks (organization_id, project_id, deliverable_id, title)
     values ($1, $2, $3, 'Do the thing') returning id, deliverable_id`,
    [orgA, projA.id, delA.id],
  );
  check('task may attach to a deliverable in its own project', taskA.deliverable_id === delA.id);

  const { rows: looseTask } = await client.query(
    `insert into public.tasks (organization_id, project_id, title)
     values ($1, $2, 'Investigation, no deliverable') returning id`,
    [orgA, projA.id],
  );
  check('task may exist with no deliverable (ADR-0005)', looseTask.length === 1);

  await expectFailure(
    client,
    'task cannot attach to a deliverable in another tenant',
    `insert into public.tasks (organization_id, project_id, deliverable_id, title)
     values ($1, $2, $3, 'cross-tenant')`,
    [orgA, projA.id, delB.id],
    'belongs to project',
  );

  // --- Status machine -----------------------------------------------------
  await expectFailure(
    client,
    'illegal deliverable transition rejected (DRAFT -> PUBLISHED)',
    `update public.deliverables set status = 'PUBLISHED' where id = $1`,
    [delA.id],
    'not a legal transition',
  );

  await client.query(`update public.deliverables set status = 'IN_PROGRESS' where id = $1`, [
    delA.id,
  ]);
  const { rows: afterTransition } = await client.query(
    'select status from public.deliverables where id = $1',
    [delA.id],
  );
  check('legal deliverable transition accepted', afterTransition[0].status === 'IN_PROGRESS');

  await client.query(
    `update public.deliverables set status = 'INTERNAL_REVIEW', submitted_at = now() where id = $1`,
    [delA.id],
  );
  await client.query(`update public.deliverables set status = 'SUBMITTED' where id = $1`, [
    delA.id,
  ]);
  await expectFailure(
    client,
    'CLIENT_REVIEW requires client_visible',
    `update public.deliverables set status = 'CLIENT_REVIEW' where id = $1`,
    [delA.id],
    'deliverables_client_states_require_visibility',
  );

  // --- Comments -----------------------------------------------------------
  await expectFailure(
    client,
    'comment on two subjects rejected',
    `insert into public.comments (organization_id, project_id, task_id, author_user_id, body)
     values ($1, $2, $3, $4, 'x')`,
    [orgA, projA.id, taskA.id, userA],
    'exactly one of project_id',
  );
  await expectFailure(
    client,
    'comment on no subject rejected',
    `insert into public.comments (organization_id, author_user_id, body) values ($1, $2, 'x')`,
    [orgA, userA],
    'exactly one of project_id',
  );
  await expectFailure(
    client,
    'client user cannot author an internal comment',
    `insert into public.comments (organization_id, deliverable_id, author_user_id, body, is_internal)
     values ($1, $2, $3, 'secret', true)`,
    [orgA, delA.id, clientUser],
    'internal comment',
  );

  // --- Files --------------------------------------------------------------
  await expectFailure(
    client,
    'storage path must be organization-prefixed',
    `insert into public.files
       (organization_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
     values ($1, 'wrong/place/file.pdf', 'f.pdf', 'application/pdf', 10, $2)`,
    [orgA, userA],
    'files_path_is_org_prefixed',
  );
  const { rows: goodFile } = await client.query(
    `insert into public.files
       (organization_id, storage_path, file_name, mime_type, size_bytes, uploaded_by, deliverable_id)
     values ($1, $4, 'report.pdf', 'application/pdf', 1024, $2, $3)
     returning id`,
    [orgA, userA, delA.id, `${orgA}/deliverables/report.pdf`],
  );
  check('org-prefixed file accepted', goodFile.length === 1);

  // --- Memberships --------------------------------------------------------
  await client.query(
    `insert into public.organization_memberships
       (organization_id, user_id, role, status, joined_at)
     values ($1, $2, 'CLIENT_ADMIN', 'ACTIVE', now())`,
    [orgA, clientUser],
  );
  await expectFailure(
    client,
    'internal staff cannot hold a client membership',
    `insert into public.organization_memberships (organization_id, user_id, role)
     values ($1, $2, 'CLIENT_MEMBER')`,
    [orgA, userA],
    'not a CLIENT profile',
  );
  await expectFailure(
    client,
    'duplicate live membership rejected',
    `insert into public.organization_memberships (organization_id, user_id, role)
     values ($1, $2, 'CLIENT_MEMBER')`,
    [orgA, clientUser],
    'duplicate key',
  );
  await expectFailure(
    client,
    'client user of org A cannot be staffed on an org B project',
    `insert into public.project_memberships (organization_id, project_id, user_id, project_role)
     values ($1, $2, $3, 'OBSERVER')`,
    [orgB, projB.id, clientUser],
    'no active membership',
  );
  const { rows: staffed } = await client.query(
    `insert into public.project_memberships (organization_id, project_id, user_id, project_role)
     values ($1, $2, $3, 'LEAD') returning id`,
    [orgA, projA.id, userA],
  );
  check('internal staff may be staffed on any project', staffed.length === 1);

  // --- Notifications ------------------------------------------------------
  await expectFailure(
    client,
    'cross-tenant notification rejected',
    `insert into public.notifications
       (recipient_user_id, organization_id, notification_type, title)
     values ($1, $2, 'SYSTEM', 'leak')`,
    [clientUser, orgB],
    'no membership in organization',
  );

  // --- Append-only --------------------------------------------------------
  const { rows: version } = await client.query(
    `insert into public.deliverable_versions
       (organization_id, deliverable_id, version_number, status, submitted_by)
     values ($1, $2, 1, 'SUBMITTED', $3) returning id`,
    [orgA, delA.id, userA],
  );
  await expectFailure(
    client,
    'deliverable_versions is append-only (UPDATE)',
    `update public.deliverable_versions set summary = 'tampered' where id = $1`,
    [version[0].id],
    'append-only',
  );
  await expectFailure(
    client,
    'deliverable_versions is append-only (DELETE)',
    `delete from public.deliverable_versions where id = $1`,
    [version[0].id],
    'append-only',
  );

  // --- Metrics ------------------------------------------------------------
  await client.query(
    `insert into public.metrics
       (organization_id, service_id, metric_key, metric_date, value, unit, currency, source)
     values ($1, $2, 'REVENUE', current_date, 1000.50, 'CURRENCY', 'USD', 'GA4')`,
    [orgA, svcA.id],
  );
  await expectFailure(
    client,
    'duplicate metric point rejected',
    `insert into public.metrics
       (organization_id, service_id, metric_key, metric_date, value, unit, currency)
     values ($1, $2, 'REVENUE', current_date, 2000, 'CURRENCY', 'USD')`,
    [orgA, svcA.id],
    'duplicate key',
  );
  await expectFailure(
    client,
    'CURRENCY metric without a currency rejected',
    `insert into public.metrics (organization_id, metric_key, metric_date, value, unit)
     values ($1, 'CPA', current_date, 10, 'CURRENCY')`,
    [orgA],
    'metrics_currency_iff_currency_unit',
  );

  // --- Invitations --------------------------------------------------------
  await expectFailure(
    client,
    'invitation with both branches rejected',
    `insert into public.invitations
       (email, organization_id, organization_role, platform_role, invited_by, token_hash, expires_at)
     values ('x@y.com', $1, 'CLIENT_MEMBER', 'ADMIN', $2, repeat('a', 64), now() + interval '7 days')`,
    [orgA, userA],
    'invitations_exactly_one_branch',
  );
  const { rows: invite } = await client.query(
    `insert into public.invitations
       (email, organization_id, organization_role, invited_by, token_hash, expires_at)
     values ('new@acme.test', $1, 'CLIENT_MEMBER', $2, repeat('b', 64), now() + interval '7 days')
     returning id`,
    [orgA, userA],
  );
  await expectFailure(
    client,
    'invitation target is immutable',
    `update public.invitations set organization_role = 'CLIENT_ADMIN' where id = $1`,
    [invite[0].id],
    'immutable',
  );

  // --- Reports ------------------------------------------------------------
  const { rows: report } = await client.query(
    `insert into public.reports
       (organization_id, engagement_id, title, report_type, period_start, period_end)
     values ($1, $2, 'October performance', 'PERFORMANCE',
             date_trunc('month', current_date)::date, current_date)
     returning id`,
    [orgA, engA],
  );
  await expectFailure(
    client,
    'PUBLISHED report requires visibility and attribution',
    `update public.reports set status = 'PUBLISHED' where id = $1`,
    [report[0].id],
    'reports_published_coherent',
  );
  await client.query(
    `insert into public.report_metrics (organization_id, report_id, metric_key, value, unit, currency)
     values ($1, $2, 'REVENUE', 1000.50, 'CURRENCY', 'USD')`,
    [orgA, report[0].id],
  );
  await expectFailure(
    client,
    'report_metrics is append-only',
    `update public.report_metrics set value = 9999 where report_id = $1`,
    [report[0].id],
    'append-only',
  );

  // --- Audit --------------------------------------------------------------
  const { rows: audit } = await client.query(
    `select entity_kind, action, severity, changed_fields
     from public.audit_events
     where organization_id = any($1::uuid[]) order by id`,
    [[orgA, orgB]],
  );
  check('audit events were recorded', audit.length > 0, `${audit.length} rows`);
  check(
    'organization creation audited',
    audit.some((r) => r.entity_kind === 'organization' && r.action === 'CREATE'),
  );
  check(
    'status change recorded as STATUS_CHANGE',
    audit.some((r) => r.action === 'STATUS_CHANGE' && r.changed_fields?.includes('status')),
  );
  check(
    'membership change audited at CRITICAL',
    audit.some((r) => r.severity === 'CRITICAL'),
  );

  const { rows: auditIds } = await client.query(
    'select id, occurred_at from public.audit_events limit 1',
  );
  await expectFailure(
    client,
    'audit_events is immutable',
    `update public.audit_events set reason = 'tampered' where id = $1`,
    [auditIds[0].id],
    'append-only',
  );

  // --- Soft delete --------------------------------------------------------
  await client.query(
    `update public.projects set deleted_at = now(), deleted_by = $2 where id = $1`,
    [projA.id, userA],
  );
  const { rows: softDeleted } = await client.query(
    `select action from public.audit_events
     where entity_kind = 'project' and action = 'SOFT_DELETE'
       and organization_id = $1`,
    [orgA],
  );
  check('soft delete recorded as SOFT_DELETE, not UPDATE', softDeleted.length === 1);

  const { rows: codeReuse } = await client.query(
    `insert into public.projects (organization_id, service_id, code, name, owning_team)
     values ($1, $2, 'PRJ-1', 'Rebuild take two', 'SEO') returning id`,
    [orgA, svcA.id],
  );
  check('a code is reusable after soft delete', codeReuse.length === 1);

  await client.query('rollback');
}

async function main() {
  const url = process.env.SUPABASE_DB_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('Set SUPABASE_DB_URL_DIRECT or DATABASE_URL.');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    console.log('\n── Structure ─────────────────────────────────────────────');
    const before = results.length;
    await verifyStructure(client);
    printFrom(before);

    console.log('\n── Behaviour ─────────────────────────────────────────────');
    const behaviourStart = results.length;
    await verifyBehaviour(client);
    printFrom(behaviourStart);
  } catch (error) {
    console.error('\nVerification aborted:', error.message);
    failures += 1;
  } finally {
    await client.end();
  }

  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

function printFrom(index) {
  for (const r of results.slice(index)) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  }
}

await main();
