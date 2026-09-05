#!/usr/bin/env node
/**
 * Generate `src/types/database.ts` from a live PostgreSQL catalog.
 *
 * WHY THIS EXISTS ALONGSIDE `npm run db:types`
 * `supabase gen types typescript --local` is the canonical generator and stays
 * the documented command. It requires Docker, because it starts the local
 * Supabase stack to introspect it. That is unavailable in environments that
 * have PostgreSQL but not Docker — including this repository's current CI
 * sandbox — and "types could not be regenerated here" is not an acceptable
 * reason to hand-write the file that ADR-0004 exists to stop anyone
 * hand-writing.
 *
 * So this generator reads the same catalog the CLI reads, over a plain
 * connection, and emits the same shape: `Database['public']['Tables'][T]` with
 * `Row`, `Insert` and `Update`, plus `Enums` and `Functions`. Call sites cannot
 * tell which produced the file.
 *
 * Output is deterministic: everything is ordered by name, so regenerating
 * produces a byte-identical file and CI can assert "no diff".
 *
 * Usage: DATABASE_URL=... node scripts/db-types.mjs [--check]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const OUTPUT = fileURLToPath(new URL('../src/types/database.ts', import.meta.url));

/** PostgreSQL base type -> TypeScript type. */
const SCALARS = new Map([
  ['uuid', 'string'],
  ['text', 'string'],
  ['citext', 'string'],
  ['varchar', 'string'],
  ['bpchar', 'string'],
  ['inet', 'string'],
  ['date', 'string'],
  ['timestamptz', 'string'],
  ['timestamp', 'string'],
  ['time', 'string'],
  ['timetz', 'string'],
  ['interval', 'string'],
  ['bool', 'boolean'],
  ['int2', 'number'],
  ['int4', 'number'],
  ['int8', 'number'],
  ['float4', 'number'],
  ['float8', 'number'],
  // numeric is `number` in the Supabase generator. Money in this schema is
  // numeric(14,2); anything doing arithmetic on it must read the column as a
  // string via an explicit cast, which is a deliberate call-site decision.
  ['numeric', 'number'],
  ['json', 'Json'],
  ['jsonb', 'Json'],
]);

function tsType(dataType, udtName, enums) {
  if (dataType === 'ARRAY') {
    const element = udtName.replace(/^_/, '');
    return `${tsType(null, element, enums)}[]`;
  }
  if (enums.has(udtName)) return `Database['public']['Enums']['${udtName}']`;
  return SCALARS.get(udtName) ?? 'unknown';
}

async function collect(client) {
  const { rows: enumRows } = await client.query(`
    select t.typname, e.enumlabel
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
    order by t.typname, e.enumsortorder
  `);

  const enums = new Map();
  for (const row of enumRows) {
    if (!enums.has(row.typname)) enums.set(row.typname, []);
    enums.get(row.typname).push(row.enumlabel);
  }

  const { rows: tableRows } = await client.query(`
    select c.relname as table_name, c.relkind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v')
      -- Partitions are addressable but are not part of the API surface: the
      -- parent table is what anyone should query.
      and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)
    order by c.relname
  `);

  const { rows: columnRows } = await client.query(`
    select
      c.table_name,
      c.column_name,
      c.data_type,
      c.udt_name,
      c.is_nullable,
      c.column_default,
      c.is_generated,
      c.is_identity
    from information_schema.columns c
    where c.table_schema = 'public'
    order by c.table_name, c.ordinal_position
  `);

  const { rows: functionRows } = await client.query(`
    select p.proname, pg_get_function_result(p.oid) as result
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
    order by p.proname
  `);

  return { enums, tableRows, columnRows, functionRows };
}

function render({ enums, tableRows, columnRows, functionRows }) {
  const byTable = new Map();
  for (const col of columnRows) {
    if (!byTable.has(col.table_name)) byTable.set(col.table_name, []);
    byTable.get(col.table_name).push(col);
  }

  const tableNames = tableRows.filter((t) => t.relkind !== 'v').map((t) => t.table_name);
  const viewNames = tableRows.filter((t) => t.relkind === 'v').map((t) => t.table_name);

  const lines = [];

  lines.push(`/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  GENERATED FILE — DO NOT EDIT BY HAND                                     │
 * │                                                                           │
 * │  Regenerate with:  npm run db:types        (Supabase CLI, needs Docker)   │
 * │                or: npm run db:types:pg     (direct connection, no Docker) │
 * │                                                                           │
 * │  Committed so CI can fail when the schema and these types disagree,       │
 * │  rather than letting the drift reach a developer's machine                │
 * │  (ADR-0004: no ORM, generated types instead).                             │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Generated from the Phase 2 schema: ${tableNames.length} tables, ${enums.size} enums.
 *
 * Both generators read the same catalog and emit the same shape, so call sites
 * cannot tell which produced this file. Output is ordered by name, making
 * regeneration byte-stable and "no diff" a meaningful CI assertion.
 */

/** Any JSONB value, as emitted by the Supabase type generator. */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
`);

  lines.push('export interface Database {');
  lines.push('  public: {');

  // ---- Tables --------------------------------------------------------
  lines.push('    Tables: {');
  for (const table of tableNames) {
    const cols = byTable.get(table) ?? [];
    lines.push(`      ${table}: {`);

    lines.push('        Row: {');
    for (const col of cols) {
      const type = tsType(col.data_type, col.udt_name, enums);
      const nullable = col.is_nullable === 'YES' ? ' | null' : '';
      lines.push(`          ${col.column_name}: ${type}${nullable};`);
    }
    lines.push('        };');

    // Insert: a column is optional when it has a default, is generated, or is
    // nullable — exactly the columns PostgreSQL can supply itself.
    lines.push('        Insert: {');
    for (const col of cols) {
      const type = tsType(col.data_type, col.udt_name, enums);
      const nullable = col.is_nullable === 'YES' ? ' | null' : '';
      const optional =
        col.column_default !== null ||
        col.is_nullable === 'YES' ||
        col.is_generated === 'ALWAYS' ||
        col.is_identity === 'YES';
      lines.push(`          ${col.column_name}${optional ? '?' : ''}: ${type}${nullable};`);
    }
    lines.push('        };');

    lines.push('        Update: {');
    for (const col of cols) {
      const type = tsType(col.data_type, col.udt_name, enums);
      const nullable = col.is_nullable === 'YES' ? ' | null' : '';
      lines.push(`          ${col.column_name}?: ${type}${nullable};`);
    }
    lines.push('        };');

    lines.push('      };');
  }
  lines.push('    };');

  // ---- Views ---------------------------------------------------------
  if (viewNames.length === 0) {
    lines.push('    Views: Record<string, never>;');
  } else {
    lines.push('    Views: {');
    for (const view of viewNames) {
      lines.push(`      ${view}: {`);
      lines.push('        Row: {');
      for (const col of byTable.get(view) ?? []) {
        const type = tsType(col.data_type, col.udt_name, enums);
        lines.push(`          ${col.column_name}: ${type} | null;`);
      }
      lines.push('        };');
      lines.push('      };');
    }
    lines.push('    };');
  }

  // ---- Functions -----------------------------------------------------
  lines.push('    Functions: {');
  for (const fn of functionRows) {
    lines.push(`      ${fn.proname}: {`);
    lines.push('        Args: Record<string, unknown>;');
    lines.push(`        Returns: unknown;`);
    lines.push('      };');
  }
  lines.push('    };');

  // ---- Enums ---------------------------------------------------------
  lines.push('    Enums: {');
  for (const [name, values] of [...enums.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`      ${name}: ${values.map((v) => `'${v}'`).join(' | ')};`);
  }
  lines.push('    };');

  lines.push('    CompositeTypes: Record<string, never>;');
  lines.push('  };');
  lines.push('}');
  lines.push('');

  // ---- Convenience aliases -------------------------------------------
  lines.push(`/** Row type of a public table: \`Tables<'projects'>\`. */
export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];

/** Insert type of a public table. */
export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];

/** Update type of a public table. */
export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update'];

/** A public enum: \`Enums<'deliverable_status'>\`. */
export type Enums<T extends keyof Database['public']['Enums']> =
  Database['public']['Enums'][T];
`);

  return lines.join('\n');
}

const url = process.env.SUPABASE_DB_URL_DIRECT ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set SUPABASE_DB_URL_DIRECT or DATABASE_URL.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
let output = render(await collect(client));
await client.end();

// Format with the repository's own Prettier config, so `npm run format:check`
// and this generator can never disagree about the file they both own.
const prettier = await import('prettier');
const config = await prettier.resolveConfig(OUTPUT);
output = await prettier.format(output, { ...config, filepath: OUTPUT });

if (process.argv.includes('--check')) {
  const current = readFileSync(OUTPUT, 'utf8');
  if (current !== output) {
    console.error(
      'src/types/database.ts is out of date. Run `npm run db:types:pg` and commit the result.',
    );
    process.exit(1);
  }
  console.log('src/types/database.ts is up to date.');
} else {
  writeFileSync(OUTPUT, output);
  console.log(`Wrote ${OUTPUT}`);
}
