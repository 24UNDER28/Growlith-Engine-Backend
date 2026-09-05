#!/usr/bin/env node
/**
 * Drop and recreate the local validation database, then apply the Supabase
 * compatibility shim.
 *
 * This is the "clean environment" half of the determinism claim: the migration
 * set is only trustworthy if it can be applied from nothing, repeatedly, with
 * the same result. Never point this at anything but a local database — it
 * drops without asking.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/db-reset-local.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const BOOTSTRAP = fileURLToPath(new URL('./db-bootstrap-local.sql', import.meta.url));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL to a LOCAL database. This script drops it.');
  process.exit(1);
}

const target = new URL(url);
const dbName = target.pathname.replace(/^\//, '');
if (!dbName) {
  console.error('DATABASE_URL must name a database.');
  process.exit(1);
}

// Guard: refuse to run against anything that looks remote. A dropped
// production database is not recoverable from a script's apology.
const host = target.searchParams.get('host') ?? target.hostname;
if (!/^(localhost|127\.0\.0\.1|\/|::1)/.test(host)) {
  console.error(`Refusing to reset a non-local host: ${host}`);
  process.exit(1);
}

const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';

const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(
  `drop database if exists ${JSON.stringify(dbName).replace(/"/g, '"')} with (force)`,
);
await admin.query(`create database "${dbName}"`);
await admin.end();

const target_client = new pg.Client({ connectionString: url });
await target_client.connect();
await target_client.query(readFileSync(BOOTSTRAP, 'utf8'));
await target_client.end();

console.log(`Reset ${dbName} and applied the local Supabase shim.`);
