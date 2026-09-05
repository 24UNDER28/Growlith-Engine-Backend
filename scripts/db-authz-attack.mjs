#!/usr/bin/env node
/**
 * Phase 4 authorization ATTACK harness.
 *
 * Runs the real migration set + seed against a real PostgreSQL engine
 * (PGlite, PostgreSQL 18.3 in WASM — same SQL, same planner, same RLS) and
 * then executes an authenticated malicious-CLIENT attack simulation, exactly
 * as the Phase 4 gate demands: "Do not merely inspect source code. Execute
 * actual tests against the application/database."
 *
 * Each check emulates a PostgREST request: `set role authenticated` plus
 * `request.jwt.claim.sub` / `request.jwt.claim.role` GUCs, which is how
 * Supabase delivers the caller's identity to `auth.uid()`. A check PASSes
 * when the observed result matches the authorization contract (the attack is
 * BLOCKED, or the legitimate operation is ALLOWED). A check FAILs when an
 * attack lands — i.e. a confirmed authorization bypass.
 *
 * The seeded actors:
 *   dana  CLIENT_ADMIN of Acme   (the malicious client)
 *   eli   CLIENT_MEMBER of Acme
 *   fay   CLIENT_ADMIN of Globex
 *   ben   ADMIN (internal)
 *   ada   SUPER_ADMIN (internal)
 *
 * Usage:
 *   node scripts/db-authz-attack.mjs
 * Exits non-zero if any attack lands.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

const ROOT = process.cwd();

const ACTORS = {
  ada: '11111111-1111-4111-8111-111111111111',
  ben: '22222222-2222-4222-8222-222222222222',
  cara: '33333333-3333-4333-8333-333333333333',
  dana: '44444444-4444-4444-8444-444444444444',
  eli: '55555555-5555-4555-8555-555555555555',
  fay: '66666666-6666-4666-8666-666666666666',
};

const ORGS = {
  acme: 'aaaaaaaa-0000-4000-8000-000000000001',
  globex: 'bbbbbbbb-0000-4000-8000-000000000002',
};

const IDS = {
  acmeEngagement: 'a1000000-0000-4000-8000-000000000001',
  acmeService: 'a2000000-0000-4000-8000-000000000001',
  acmeProject: 'a3000000-0000-4000-8000-000000000001',
  acmeDeliverableReview: 'a4000000-0000-4000-8000-000000000001',
  acmeDeliverableInternal: 'a4000000-0000-4000-8000-000000000002',
  acmeReport: 'a5000000-0000-4000-8000-000000000001',
  globexProject: 'b3000000-0000-4000-8000-000000000001',
  globexDeliverable: 'b4000000-0000-4000-8000-000000000002',
};

// ---------------------------------------------------------------------------
// Boot a real database with the exact migration set.
// ---------------------------------------------------------------------------

async function boot() {
  const dist = join(ROOT, 'node_modules', '@electric-sql', 'pglite', 'dist');
  const ext = (name) => ({ setup: async () => ({ bundlePath: join(dist, `${name}.tar.gz`) }) });
  const db = new PGlite({ extensions: { pgcrypto: ext('pgcrypto'), citext: ext('citext') } });
  await db.waitReady;

  await db.exec(readFileSync(join(ROOT, 'scripts/db-bootstrap-local.sql'), 'utf8'));
  const migrations = readdirSync(join(ROOT, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of migrations) {
    await db.exec(readFileSync(join(ROOT, 'supabase/migrations', file), 'utf8'));
  }
  await db.exec(readFileSync(join(ROOT, 'supabase/seed.sql'), 'utf8'));
  return db;
}

/**
 * Extra fixtures the attack set needs, written as the table owner (superuser,
 * RLS-bypassed) so the rows exist but the CLIENT cannot reach them.
 */
async function seedFixtures(db) {
  // A Globex deliverable sitting in CLIENT_REVIEW and client-visible, so
  // "approve another tenant's deliverable" has a real row to hit. Inserted
  // directly (no status-transition trigger on INSERT) and satisfies the
  // client-state coherence CHECKs.
  await db.exec(`
    insert into public.deliverables
      (id, organization_id, project_id, title, deliverable_type, status,
       client_visible, submitted_at, owner_user_id)
    values
      ('${IDS.globexDeliverable}', '${ORGS.globex}', '${IDS.globexProject}',
       'Design system foundations', 'DESIGN', 'CLIENT_REVIEW', true, now(), '${ACTORS.ben}')
    on conflict (id) do nothing;
  `);

  // Globex file metadata + storage object under the Globex prefix.
  await db.exec(`
    insert into public.files
      (organization_id, storage_path, file_name, mime_type, size_bytes, uploaded_by,
       client_visible, virus_scan_status, scanned_at, deliverable_id)
    values
      ('${ORGS.globex}', '${ORGS.globex}/internal-plan.pdf', 'internal-plan.pdf',
       'application/pdf', 1024, '${ACTORS.ben}', true, 'CLEAN', now(), '${IDS.globexDeliverable}')
    on conflict do nothing;
  `);
  await db.exec(`
    insert into storage.objects (bucket_id, name, owner)
    values ('growlith-private', '${ORGS.globex}/internal-plan.pdf', '${ACTORS.ben}')
    on conflict do nothing;
  `);

  // Acme file uploaded by Dana — the target for Eli's "edit someone else's file".
  await db.exec(`
    insert into public.files
      (organization_id, storage_path, file_name, mime_type, size_bytes, uploaded_by,
       client_visible, virus_scan_status, scanned_at, deliverable_id)
    values
      ('${ORGS.acme}', '${ORGS.acme}/feedback.docx', 'feedback.docx',
       'application/vnd...docx', 512, '${ACTORS.dana}', true, 'CLEAN', now(), '${IDS.acmeDeliverableReview}')
    on conflict do nothing;
  `);

  // A DRAFT (unpublished) Acme report — must never reach a client.
  await db.exec(`
    insert into public.reports
      (organization_id, engagement_id, title, report_type, period_start, period_end, status)
    values
      ('${ORGS.acme}', '${IDS.acmeEngagement}', 'Q3 draft — internal',
       'PERFORMANCE', current_date - 60, current_date - 30, 'DRAFT')
    on conflict do nothing;
  `);

  // Notifications: one for Fay, one for Dana.
  await db.exec(`
    insert into public.notifications
      (recipient_user_id, organization_id, notification_type, severity, title, body, subject_entity, subject_id)
    values
      ('${ACTORS.fay}',  '${ORGS.globex}', 'REPORT_PUBLISHED', 'INFO', 'Report ready', 'x', 'report', '${IDS.acmeReport}'),
      ('${ACTORS.dana}', '${ORGS.acme}',   'DELIVERABLE_APPROVED', 'INFO', 'Approved', 'y', 'deliverable', '${IDS.acmeDeliverableReview}')
    on conflict do nothing;
  `);

  // A Globex invitation (Dana must not see it).
  await db.exec(`
    insert into public.invitations
      (email, organization_id, organization_role, invited_by, token_hash, expires_at)
    values
      ('newcomer@globex.test', '${ORGS.globex}', 'CLIENT_MEMBER', '${ACTORS.fay}',
       repeat('c', 64), now() + interval '7 days')
    on conflict do nothing;
  `);

  // A comment authored by Eli on the Acme project (author-update positive control).
  await db.exec(`
    insert into public.comments
      (organization_id, project_id, author_user_id, body, is_internal)
    values
      ('${ORGS.acme}', '${IDS.acmeProject}', '${ACTORS.eli}', 'Eli''s own note', false)
    on conflict do nothing;
  `);

  // Acme engagement/service rows carry the internal-only commercial columns.
}

// ---------------------------------------------------------------------------
// Session emulation + assertion helpers.
// ---------------------------------------------------------------------------

const results = [];
let failures = 0;

/** Run `fn` as `authenticated` + the given caller uid, inside a rolled-back txn. */
async function asUser(db, uid, fn) {
  await db.exec('begin');
  try {
    await db.exec('set local role authenticated');
    await db.exec(`select set_config('request.jwt.claim.sub', '${uid}', true)`);
    await db.exec(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
    const value = await fn();
    await db.exec('rollback');
    return value;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

/** Run a query as a user; return rows returned AND rows affected. */
async function runAs(db, uid, sql, params = []) {
  return asUser(db, uid, async () => {
    const r = await db.query(sql, params);
    // `rows` is empty for UPDATE/INSERT/DELETE without RETURNING; the rows a
    // write actually touched are only visible through `affectedRows`. A write
    // attack must be judged by affectedRows — judging it by rows.length makes
    // every UPDATE attack look "blocked" whether RLS stopped it or not.
    return { count: r.rows.length, affected: r.affectedRows ?? 0, rows: r.rows };
  });
}

/** An attack that must be BLOCKED (no rows read, no rows affected, or an error). */
async function attack(db, label, uid, sql, params = []) {
  let outcome;
  let actual;
  try {
    const { count, affected } = await runAs(db, uid, sql, params);
    const landed = count > 0 || affected > 0;
    outcome = landed ? 'SUCCEEDED' : 'blocked';
    actual = `${outcome} (${count} row(s) read, ${affected} row(s) affected)`;
  } catch (error) {
    outcome = 'blocked';
    actual = `blocked (error: ${String(error.message).split('\n')[0].slice(0, 90)})`;
  }
  const pass = outcome === 'blocked';
  if (!pass) failures += 1;
  results.push({ label, expected: 'blocked', actual, pass });
  return pass;
}

/** A statement that must raise an error (e.g. column privilege, RPC denial). */
async function attackError(db, label, uid, sql, params = []) {
  let actual;
  let pass;
  try {
    const { count, affected } = await runAs(db, uid, sql, params);
    actual = `SUCCEEDED (${count} row(s) read, ${affected} row(s) affected)`;
    pass = false;
  } catch (error) {
    actual = `blocked (error: ${String(error.message).split('\n')[0].slice(0, 90)})`;
    pass = true;
  }
  if (!pass) failures += 1;
  results.push({ label, expected: 'blocked (error)', actual, pass });
  return pass;
}

/** A legitimate operation that must SUCCEED (positive control). */
async function allowed(db, label, uid, sql, params = []) {
  let actual;
  let pass;
  try {
    const { count, affected } = await runAs(db, uid, sql, params);
    pass = count >= 1 || affected >= 1;
    actual = `allowed (${count} row(s) read, ${affected} row(s) affected)`;
  } catch (error) {
    actual = `blocked (error: ${String(error.message).split('\n')[0].slice(0, 90)})`;
    pass = false;
  }
  if (!pass) failures += 1;
  results.push({ label, expected: 'allowed', actual, pass });
  return pass;
}

// ---------------------------------------------------------------------------
// The attack simulation.
// ---------------------------------------------------------------------------

async function main() {
  const db = await boot();
  await seedFixtures(db);

  const dana = ACTORS.dana;
  const eli = ACTORS.eli;
  const fay = ACTORS.fay;
  const ben = ACTORS.ben;
  const acme = ORGS.acme;
  const globex = ORGS.globex;

  /* ── 1. Cross-tenant reads (access another organization / another client's project) ── */
  await attack(
    db,
    'read another organization row',
    dana,
    `select 1 from public.organizations where id = '${globex}'`,
  );
  await attack(
    db,
    "read another tenant's engagement",
    dana,
    `select 1 from public.engagements where organization_id = '${globex}'`,
  );
  await attack(
    db,
    "read another tenant's service",
    dana,
    `select 1 from public.services where organization_id = '${globex}'`,
  );
  await attack(
    db,
    "read another client's project",
    dana,
    `select 1 from public.projects where id = '${IDS.globexProject}'`,
  );
  await attack(
    db,
    "read another tenant's deliverables",
    dana,
    `select 1 from public.deliverables where organization_id = '${globex}'`,
  );
  await attack(
    db,
    "read another tenant's deliverable versions",
    dana,
    `select 1 from public.deliverable_versions where organization_id = '${globex}'`,
  );
  await attack(
    db,
    "read another tenant's comments",
    dana,
    `select 1 from public.comments where organization_id = '${globex}'`,
  );
  await attack(
    db,
    "read another tenant's reports",
    dana,
    `select 1 from public.reports where organization_id = '${globex}'`,
  );
  await attack(
    db,
    "read another tenant's report metrics",
    dana,
    `select 1 from public.report_metrics where organization_id = '${globex}'`,
  );
  await attack(
    db,
    "read another tenant's raw metrics",
    dana,
    `select 1 from public.metrics where organization_id = '${globex}'`,
  );
  await attack(
    db,
    "read another tenant's files (metadata)",
    dana,
    `select 1 from public.files where organization_id = '${globex}'`,
  );
  await attack(
    db,
    "read another tenant's organization settings",
    dana,
    `select 1 from public.organization_settings where organization_id = '${globex}'`,
  );
  await attack(
    db,
    "read another tenant's membership roster",
    dana,
    `select 1 from public.organization_memberships where organization_id = '${globex}'`,
  );
  await attack(
    db,
    "read another tenant's invitations",
    dana,
    `select 1 from public.invitations where organization_id = '${globex}'`,
  );

  /* ── 2. Cross-tenant writes (modify another client's project) ── */
  await attack(
    db,
    "modify another client's project",
    dana,
    `update public.projects set name = 'pwned' where id = '${IDS.globexProject}'`,
  );
  await attack(
    db,
    "modify another tenant's deliverable",
    dana,
    `update public.deliverables set title = 'pwned' where organization_id = '${globex}'`,
  );
  await attack(
    db,
    "modify another tenant's engagement",
    dana,
    `update public.engagements set name = 'pwned' where organization_id = '${globex}'`,
  );
  await attack(
    db,
    "modify another tenant's organization",
    dana,
    `update public.organizations set legal_name = 'pwned' where id = '${globex}'`,
  );
  await attack(
    db,
    "modify another tenant's organization settings",
    dana,
    `update public.organization_settings set timezone = 'Mars/Olympus' where organization_id = '${globex}'`,
  );
  await attack(
    db,
    "soft-delete another tenant's file",
    dana,
    `update public.files set deleted_at = now() where organization_id = '${globex}'`,
  );
  await attack(
    db,
    "soft-delete another tenant's comment",
    dana,
    `update public.comments set deleted_at = now() where organization_id = '${globex}'`,
  );
  await attackError(
    db,
    'insert a project into another tenant',
    dana,
    `insert into public.projects (organization_id, service_id, code, name, owning_team)
     values ('${globex}', 'b2000000-0000-4000-8000-000000000001', 'GLX-HAX', 'pwned', 'WEB_DEVELOPMENT')`,
  );
  await attackError(
    db,
    'insert a file into another tenant',
    dana,
    `insert into public.files (organization_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
     values ('${globex}', '${globex}/pwn.txt', 'pwn.txt', 'text/plain', 1, '${dana}')`,
  );
  await attackError(
    db,
    'insert a comment into another tenant',
    dana,
    `insert into public.comments (organization_id, deliverable_id, author_user_id, body, is_internal)
     values ('${globex}', '${IDS.globexDeliverable}', '${dana}', 'pwned', false)`,
  );
  await attackError(
    db,
    'insert organization membership into another tenant (direct write)',
    dana,
    `insert into public.organization_memberships (organization_id, user_id, role, status)
     values ('${globex}', '${dana}', 'CLIENT_ADMIN', 'ACTIVE')`,
  );

  /* ── 3. Internal-only data ── */
  await attack(
    db,
    'read tasks (internal-only, even own tenant)',
    dana,
    `select 1 from public.tasks where organization_id = '${acme}'`,
  );
  await attack(
    db,
    'read staff team memberships',
    dana,
    `select 1 from public.staff_team_memberships`,
  );
  await attack(
    db,
    'read audit events',
    dana,
    `select 1 from public.audit_events where organization_id = '${acme}'`,
  );
  await attack(
    db,
    'read the platform role roster',
    dana,
    `select 1 from public.platform_role_grants`,
  );
  await attack(
    db,
    'read internal (staff) comments on own tenant',
    dana,
    `select 1 from public.comments where organization_id = '${acme}' and is_internal`,
  );
  await attack(
    db,
    'read an unpublished (DRAFT) report',
    dana,
    `select 1 from public.reports where organization_id = '${acme}' and status = 'DRAFT'`,
  );
  await attack(
    db,
    'read a non-client-visible deliverable',
    dana,
    `select 1 from public.deliverables where id = '${IDS.acmeDeliverableInternal}'`,
  );
  await attackError(
    db,
    'read engagement contract_value (internal column)',
    dana,
    `select contract_value from public.engagements where id = '${IDS.acmeEngagement}'`,
  );
  await attackError(
    db,
    'read engagement monthly_retainer (internal column)',
    dana,
    `select monthly_retainer from public.engagements where id = '${IDS.acmeEngagement}'`,
  );
  await attackError(
    db,
    'read engagement notes_internal (internal column)',
    dana,
    `select notes_internal from public.engagements where id = '${IDS.acmeEngagement}'`,
  );
  await attackError(
    db,
    'read service fee (internal column)',
    dana,
    `select fee from public.services where id = '${IDS.acmeService}'`,
  );
  await attackError(
    db,
    'read service fee_model (internal column)',
    dana,
    `select fee_model from public.services where id = '${IDS.acmeService}'`,
  );

  /* ── 4. Unauthorized task updates ── */
  await attack(
    db,
    'update a task (no client task policy)',
    dana,
    `update public.tasks set title = 'pwned' where organization_id = '${acme}'`,
  );
  await attackError(
    db,
    'insert a task (no client task policy)',
    dana,
    `insert into public.tasks (organization_id, project_id, title)
     values ('${acme}', '${IDS.acmeProject}', 'pwned')`,
  );
  await attackError(
    db,
    'delete a task (delete never granted)',
    dana,
    `delete from public.tasks where organization_id = '${acme}'`,
  );

  /* ── 5. Unauthorized deliverable approvals ── */
  await attackError(
    db,
    'CLIENT_MEMBER approves a deliverable',
    eli,
    `select public.approve_deliverable('${IDS.acmeDeliverableReview}', 'APPROVED', null)`,
  );
  await attackError(
    db,
    "approve ANOTHER tenant's deliverable",
    dana,
    `select public.approve_deliverable('${IDS.globexDeliverable}', 'APPROVED', null)`,
  );
  await attackError(
    db,
    'approve a deliverable not in CLIENT_REVIEW',
    dana,
    `select public.approve_deliverable('${IDS.acmeDeliverableInternal}', 'APPROVED', null)`,
  );
  await attackError(
    db,
    'client REJECTED outcome is refused',
    dana,
    `select public.approve_deliverable('${IDS.acmeDeliverableReview}', 'REJECTED', 'no')`,
  );
  await attackError(
    db,
    'client approval with forged approved_by',
    dana,
    `update public.deliverables set approved_by = '${ben}', status = 'APPROVED' where id = '${IDS.acmeDeliverableReview}'`,
  );
  await attackError(
    db,
    'client flips deliverable visibility flag',
    dana,
    `update public.deliverables set client_visible = false where id = '${IDS.acmeDeliverableReview}'`,
  );
  await attackError(
    db,
    'client re-homes deliverable into another tenant',
    dana,
    `update public.deliverables set organization_id = '${globex}' where id = '${IDS.acmeDeliverableReview}'`,
  );

  /* ── 6. Unauthorized downloads (storage objects) ── */
  await attack(
    db,
    "download another tenant's storage object",
    dana,
    `select 1 from storage.objects where name = '${globex}/internal-plan.pdf'`,
  );
  await attack(
    db,
    'download a file hanging on an internal (task) parent',
    dana,
    `select 1 from public.files where task_id is not null`,
  );

  /* ── 7. Member-management ceilings (CLIENT_ADMIN boundaries) ── */
  await attackError(
    db,
    'CLIENT_ADMIN elevates another client to CLIENT_ADMIN',
    dana,
    `select public.add_organization_member('${acme}', '${eli}', 'CLIENT_ADMIN', 'promote')`,
  );
  await attackError(
    db,
    'CLIENT_ADMIN adds a member to ANOTHER tenant',
    dana,
    `select public.add_organization_member('${globex}', '${eli}', 'CLIENT_MEMBER', null)`,
  );
  await attackError(
    db,
    'CLIENT_ADMIN adds themselves',
    dana,
    `select public.add_organization_member('${acme}', '${dana}', 'CLIENT_MEMBER', null)`,
  );
  await attackError(
    db,
    'CLIENT_MEMBER manages members',
    eli,
    `select public.add_organization_member('${acme}', '${fay}', 'CLIENT_MEMBER', null)`,
  );
  await attackError(
    db,
    'CLIENT_ADMIN modifies a CLIENT_ADMIN row',
    dana,
    `select public.update_organization_member(
       (select id from public.organization_memberships where organization_id = '${acme}' and user_id = '${dana}'),
       'CLIENT_MEMBER')`,
  );
  await attackError(
    db,
    'CLIENT_ADMIN promotes a CLIENT_MEMBER to CLIENT_ADMIN (update RPC)',
    dana,
    `select public.update_organization_member(
       (select id from public.organization_memberships where organization_id = '${acme}' and user_id = '${eli}'),
       'CLIENT_ADMIN')`,
  );
  await attackError(
    db,
    'CLIENT_ADMIN removes a CLIENT_ADMIN (even self-targeted row)',
    dana,
    `select public.remove_organization_member(
       (select id from public.organization_memberships where organization_id = '${acme}' and user_id = '${dana}'))`,
  );

  /* ── 8. Admin / SUPER_ADMIN boundaries ── */
  await attackError(
    db,
    'ADMIN grants a platform role (SUPER_ADMIN only)',
    ben,
    `select public.grant_platform_role('${ACTORS.cara}', 'SUPER_ADMIN', 'coup')`,
  );
  await attackError(
    db,
    'CLIENT_ADMIN grants a platform role',
    dana,
    `select public.grant_platform_role('${eli}', 'ADMIN', 'coup')`,
  );
  // The NULL-guard probes: a CLIENT caller has NO platform role, so the
  // SUPER_ADMIN-only RPCs must deny them outright — not skip the guard when
  // is_super_admin() evaluated to NULL instead of false.
  await attackError(
    db,
    'CLIENT_ADMIN grants a platform role to an INTERNAL user',
    dana,
    `select public.grant_platform_role('${ACTORS.cara}', 'ADMIN', 'coup')`,
  );
  await attackError(
    db,
    'CLIENT_ADMIN revokes a platform role',
    dana,
    `select public.revoke_platform_role('${ben}', 'coup')`,
  );
  await attackError(
    db,
    'CLIENT_ADMIN erases another user',
    dana,
    `select public.erase_user('${eli}', 'coup')`,
  );
  await attackError(
    db,
    'CLIENT_ADMIN purges an organization',
    dana,
    `select public.purge_organization('${acme}', 'acme-industrials')`,
  );
  await attackError(
    db,
    'ADMIN purges an organization (SUPER_ADMIN only)',
    ben,
    `select public.purge_organization('${acme}', 'acme-industrials')`,
  );
  await attackError(
    db,
    'ADMIN erases a user (SUPER_ADMIN only)',
    ben,
    `select public.erase_user('${eli}', 'test')`,
  );
  await attackError(
    db,
    'CLIENT_ADMIN submits internal review (staff only)',
    dana,
    `select public.submit_deliverable_review('${IDS.acmeDeliverableReview}', 'APPROVED', null)`,
  );
  await attackError(
    db,
    'CLIENT_ADMIN publishes a report (staff only)',
    dana,
    `select public.publish_report('${IDS.acmeReport}', true)`,
  );

  /* ── 9. Notifications ── */
  await attack(
    db,
    "read another user's notifications",
    dana,
    `select 1 from public.notifications where recipient_user_id = '${fay}'`,
  );
  await attack(
    db,
    "update another user's notification read_at",
    dana,
    `update public.notifications set read_at = now() where recipient_user_id = '${fay}'`,
  );
  await attackError(
    db,
    'insert a notification (server-emission only)',
    dana,
    `insert into public.notifications
       (recipient_user_id, organization_id, notification_type, severity, title, body, subject_entity, subject_id)
     values ('${eli}', '${acme}', 'REPORT_PUBLISHED', 'INFO', 'pwn', 'pwn', 'report', '${IDS.acmeReport}')`,
  );

  /* ── 10. ID manipulation / predictable IDs / ownership ── */
  await attack(
    db,
    "guess another tenant's project id",
    dana,
    `select 1 from public.projects where id = '${IDS.globexProject}'`,
  );
  await attack(
    db,
    "guess another tenant's deliverable id",
    dana,
    `select 1 from public.deliverables where id = '${IDS.globexDeliverable}'`,
  );
  await attack(
    db,
    "edit someone else's file (ownership)",
    eli,
    `update public.files set file_name = 'stolen.docx' where uploaded_by = '${dana}'`,
  );
  // A client forging their upload straight to CLEAN + visible must NOT land
  // visible: the upload itself is legitimate (it is their own tenant), but the
  // insert guard forces the row PENDING + invisible, so the client read gate
  // never returns it until the scan job and staff promote it. `RETURNING`
  // cannot be used to read the row back (RETURNING is itself subject to the
  // SELECT policy), so the two statements run in one transaction.
  {
    let pass = false;
    let actual;
    try {
      await asUser(db, dana, async () => {
        const ins = await db.query(
          `insert into public.files
             (organization_id, storage_path, file_name, mime_type, size_bytes, uploaded_by,
              client_visible, virus_scan_status, scanned_at)
           values ('${acme}', '${acme}/forged-visible.txt', 'forged-visible.txt', 'text/plain',
                   1, '${dana}', true, 'CLEAN', now())`,
        );
        const read = await db.query(
          `select 1 from public.files where storage_path = '${acme}/forged-visible.txt'`,
        );
        pass = ins.affectedRows === 1 && read.rows.length === 0;
        actual = `insert affected=${ins.affectedRows} row(s); read-back=${read.rows.length} row(s)`;
      });
    } catch (error) {
      actual = `error: ${String(error.message).split('\n')[0].slice(0, 90)}`;
    }
    if (!pass) failures += 1;
    results.push({
      label: 'forged clean+visible file upload stays invisible (insert guard)',
      expected: 'blocked',
      actual,
      pass,
    });
  }
  await attack(
    db,
    "edit someone else's comment (ownership)",
    eli,
    `update public.comments set body = 'pwned' where author_user_id = '${dana}'`,
  );
  await attack(
    db,
    "edit someone else's profile (self-only)",
    eli,
    `update public.profiles set full_name = 'pwned' where id = '${dana}'`,
  );
  await attackError(
    db,
    'escalate own account status column',
    eli,
    `update public.profiles set account_status = 'ACTIVE' where id = '${eli}'`,
  );
  await attackError(
    db,
    "read another profile's private columns",
    dana,
    `select phone from public.profiles where id = '${fay}'`,
  );

  /* ── 11. Positive controls (legitimate operations still work) ── */
  await allowed(
    db,
    'CLIENT_ADMIN reads own organization',
    dana,
    `select 1 from public.organizations where id = '${acme}'`,
  );
  await allowed(
    db,
    'CLIENT_ADMIN reads own visible project',
    dana,
    `select 1 from public.projects where id = '${IDS.acmeProject}'`,
  );
  await allowed(
    db,
    'CLIENT_ADMIN reads own client-visible deliverable',
    dana,
    `select 1 from public.deliverables where id = '${IDS.acmeDeliverableReview}'`,
  );
  await allowed(
    db,
    'CLIENT_ADMIN reads own published report',
    dana,
    `select 1 from public.reports where id = '${IDS.acmeReport}'`,
  );
  await allowed(
    db,
    'CLIENT_ADMIN reads own metrics',
    dana,
    `select 1 from public.metrics where organization_id = '${acme}'`,
  );
  await allowed(
    db,
    'CLIENT_ADMIN reads own notifications',
    dana,
    `select 1 from public.notifications where recipient_user_id = '${dana}'`,
  );
  await allowed(
    db,
    'CLIENT_ADMIN approves own CLIENT_REVIEW deliverable',
    dana,
    `select public.approve_deliverable('${IDS.acmeDeliverableReview}', 'APPROVED', null)`,
  );
  await allowed(
    db,
    'CLIENT_ADMIN invites a CLIENT_MEMBER (add_organization_member)',
    dana,
    `select public.add_organization_member('${acme}', '${fay}', 'CLIENT_MEMBER', 'new hire')`,
  );
  await allowed(
    db,
    'staff (ADMIN) elevates a client to CLIENT_ADMIN',
    ben,
    `select public.add_organization_member('${globex}', '${eli}', 'CLIENT_ADMIN', 'promotion')`,
  );
  await allowed(
    db,
    'CLIENT_ADMIN edits own organization settings',
    dana,
    `update public.organization_settings set timezone = 'America/New_York' where organization_id = '${acme}'`,
  );
  await allowed(
    db,
    'SUPER_ADMIN revokes a platform role (legitimate path)',
    ACTORS.ada,
    `select public.revoke_platform_role('${ben}', 'offboarding')`,
  );
  await allowed(
    db,
    'CLIENT_MEMBER posts a non-internal comment on a visible deliverable',
    eli,
    `insert into public.comments (organization_id, deliverable_id, author_user_id, body, is_internal)
     values ('${acme}', '${IDS.acmeDeliverableReview}', '${eli}', 'looks good', false)`,
  );
  await allowed(
    db,
    'author edits own comment',
    eli,
    `update public.comments set body = 'edited' where author_user_id = '${eli}'`,
  );
  await allowed(
    db,
    'CLIENT uploads a file to their own organization',
    dana,
    `insert into public.files
       (organization_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
     values ('${acme}', '${acme}/upload-ok.txt', 'upload-ok.txt', 'text/plain', 1, '${dana}')`,
  );

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  const width = 96;
  console.log('');
  console.log('Phase 4 authorization attack simulation — results');
  console.log('='.repeat(width));
  for (const r of results) {
    const tag = r.pass ? 'PASS' : 'FAIL';
    console.log(
      `[${tag.padEnd(4)}] ${r.label.padEnd(58)} expected=${r.expected.padEnd(14)} actual=${r.actual}`,
    );
  }
  console.log('='.repeat(width));
  const passed = results.length - failures;
  console.log(`${passed}/${results.length} checks passed.`);
  console.log('');
  if (failures > 0) {
    console.log(`FAIL — ${failures} authorization attack(s) landed (bypass confirmed).`);
    console.log('These must be fixed before PHASE 4 can be declared validated.');
  } else {
    console.log('All attacks blocked; no authorization bypass confirmed at the database layer.');
  }
  await db.close();
  process.exitCode = failures > 0 ? 1 : 0;
}

await main();
