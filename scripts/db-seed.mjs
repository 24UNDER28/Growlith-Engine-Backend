#!/usr/bin/env node
/**
 * Apply `supabase/seed.sql` to the database named by DATABASE_URL.
 *
 * Exists so `npm run db:seed` works without the Supabase CLI (which needs
 * Docker). The file it applies is the same one `supabase db reset` uses, so
 * there is one seed, not two.
 *
 * Runs in a single transaction: a partially seeded database is worse than an
 * empty one, because the failure is invisible until a screen renders wrong.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const SEED = fileURLToPath(new URL('../supabase/seed.sql', import.meta.url));

const url = process.env.SUPABASE_DB_URL_DIRECT ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set SUPABASE_DB_URL_DIRECT or DATABASE_URL.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  // seed.sql opens and commits its own transaction.
  await client.query(readFileSync(SEED, 'utf8'));
  const { rows } = await client.query(`
    select
      (select count(*) from public.organizations) as organizations,
      (select count(*) from public.profiles)      as profiles,
      (select count(*) from public.deliverables)  as deliverables,
      (select count(*) from public.metrics)       as metrics,
      (select count(*) from public.audit_events)  as audit_events
  `);
  console.log('Seeded:', rows[0]);
} catch (error) {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
