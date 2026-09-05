#!/usr/bin/env node
/**
 * Apply every migration in `supabase/migrations` in filename order, inside one
 * transaction, against SUPABASE_DB_URL_DIRECT (or DATABASE_URL).
 *
 * Why this exists rather than `supabase db push`: the Supabase CLI needs Docker
 * or a hosted project. This runner needs only a PostgreSQL connection string,
 * so the same migrations can be validated in CI, in a sandbox, or against a
 * real project without a second code path. `supabase db push` remains the
 * production mechanism; the file set is identical either way.
 *
 * DDL in PostgreSQL is transactional, so a failure anywhere leaves the database
 * exactly as it was. That is what makes "deterministic in a clean environment"
 * a testable claim rather than an aspiration.
 *
 * Usage:
 *   node scripts/db-apply.mjs                 apply pending migrations
 *   node scripts/db-apply.mjs --dry-run       list what would run
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../supabase/migrations', import.meta.url));

function connectionString() {
  const url = process.env.SUPABASE_DB_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'No connection string. Set SUPABASE_DB_URL_DIRECT (session mode, port 5432) ' +
        'or DATABASE_URL.',
    );
    process.exit(1);
  }
  return url;
}

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const files = migrationFiles();

  if (files.length === 0) {
    console.error('No migrations found.');
    process.exit(1);
  }

  if (dryRun) {
    for (const file of files) console.log(file);
    return;
  }

  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();

  try {
    await client.query('begin');

    // Ledger of what has been applied. Lives in its own schema so it never
    // appears in generated types or in the RLS coverage assertion.
    await client.query(`
      create schema if not exists growlith_migrations;
      create table if not exists growlith_migrations.applied (
        filename    text primary key,
        checksum    text        not null,
        applied_at  timestamptz not null default now()
      );
    `);

    const { rows } = await client.query(
      'select filename, checksum from growlith_migrations.applied',
    );
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

    const { createHash } = await import('node:crypto');

    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');

      if (applied.has(file)) {
        // Migrations are forward-only: editing an applied file is a mistake
        // that would otherwise surface as an environment-specific bug months
        // later.
        if (applied.get(file) !== checksum) {
          throw new Error(
            `${file} has changed since it was applied. Migrations are ` +
              `forward-only — write a new migration instead of editing this one.`,
          );
        }
        console.log(`  skip  ${file}`);
        continue;
      }

      process.stdout.write(`  apply ${file} ... `);
      await client.query(sql);
      await client.query(
        'insert into growlith_migrations.applied (filename, checksum) values ($1, $2)',
        [file, checksum],
      );
      console.log('ok');
    }

    await client.query('commit');
    console.log(`\n${files.length} migration(s) reconciled.`);
  } catch (error) {
    await client.query('rollback');
    console.error('\nMigration failed; the transaction was rolled back.');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

await main();
