#!/usr/bin/env node
/**
 * Post-build client exposure scan.
 *
 * THE CONTROL THIS IMPLEMENTS
 * Supabase's `service_role` key carries the PostgreSQL BYPASSRLS attribute: a
 * single leaked key removes tenant isolation for every client organization
 * simultaneously, and a secret in a shipped JavaScript bundle is public to
 * anyone with devtools. Three other controls already exist (the `server-only`
 * import barrier, the ESLint wall, and the architecture tests). This script is
 * the fourth and the only one that inspects the *actual emitted artifact* rather
 * than the source that produced it — which is what catches a misconfigured
 * bundler, a transitive re-export, or an inlined environment value.
 *
 * Run after `next build`:  npm run check:client-exposure
 * Exits non-zero on any finding so CI fails closed.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const BUILD_OUTPUT = '.next';
const CLIENT_OUTPUT = join(BUILD_OUTPUT, 'static');
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css', '.json', '.map']);

/**
 * Patterns that must never appear in a client artifact.
 *
 * Each entry names what it detects so a failure explains itself to whoever is
 * paged at 3am.
 */
const FORBIDDEN = [
  {
    id: 'service-role-env-name',
    pattern: /SUPABASE_SERVICE_ROLE_KEY/,
    meaning: 'the server-only environment variable name reached the client bundle',
  },
  {
    id: 'supabase-secret-key-prefix',
    pattern: /sb_secret_[A-Za-z0-9_-]{4,}/,
    meaning: 'a Supabase secret API key value is present',
  },
  {
    id: 'service-role-string',
    pattern: /service_role/,
    meaning: 'a service_role reference is present',
  },
  {
    id: 'service-client-marker',
    pattern: /growlith-engine-service-role/,
    meaning: 'the service-role Supabase client was bundled for the browser',
  },
  {
    id: 'service-client-symbol',
    pattern: /getSupabaseServiceClient|__resetServiceClientForTests/,
    meaning: 'a function from src/server/supabase/client-service.ts was bundled for the browser',
  },
  {
    id: 'server-only-throw-text',
    pattern: /cannot be imported from a Client Component/,
    meaning:
      'the throwing branch of the `server-only` package was bundled instead of its inert branch',
  },
  {
    id: 'postgres-connection-string',
    pattern: /postgres(?:ql)?:\/\/[^\s'"`]+:[^\s'"`]+@/,
    meaning: 'a PostgreSQL connection string with embedded credentials is present',
  },
];

async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function collectFiles(directory) {
  const found = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectFiles(fullPath)));
      continue;
    }
    const extension = entry.name.slice(entry.name.lastIndexOf('.'));
    if (SCANNED_EXTENSIONS.has(extension)) {
      found.push(fullPath);
    }
  }

  return found;
}

function withContext(content, index, radius = 60) {
  const start = Math.max(0, index - radius);
  const end = Math.min(content.length, index + radius);
  return content.slice(start, end).replace(/\s+/g, ' ');
}

async function main() {
  if (!(await directoryExists(CLIENT_OUTPUT))) {
    console.error(
      `[check-client-exposure] No client build output at ${CLIENT_OUTPUT}.\n` +
        'Run `npm run build` first — this scan inspects emitted artifacts, not source.',
    );
    process.exit(2);
  }

  const files = await collectFiles(CLIENT_OUTPUT);
  if (files.length === 0) {
    console.error(
      `[check-client-exposure] ${CLIENT_OUTPUT} contains no scannable files. Build output looks incomplete.`,
    );
    process.exit(2);
  }

  // A real secret value, when one is configured, is the highest-signal pattern
  // there is — so it is added dynamically rather than hardcoded.
  const configuredSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const checks = [...FORBIDDEN];
  if (configuredSecret && configuredSecret.length >= 16) {
    checks.push({
      id: 'configured-service-role-value',
      pattern: new RegExp(configuredSecret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      meaning: 'the literal SUPABASE_SERVICE_ROLE_KEY value from this environment is present',
    });
  }

  const findings = [];
  let bytesScanned = 0;

  for (const file of files) {
    const content = await readFile(file, 'utf8');
    bytesScanned += content.length;

    for (const check of checks) {
      const match = check.pattern.exec(content);
      if (match) {
        findings.push({
          checkId: check.id,
          meaning: check.meaning,
          file: relative(process.cwd(), file).split(sep).join('/'),
          context: withContext(content, match.index),
        });
      }
    }
  }

  console.log(
    `[check-client-exposure] scanned ${files.length} client artifact(s), ` +
      `${(bytesScanned / 1024).toFixed(1)} KiB, against ${checks.length} pattern(s).`,
  );

  if (findings.length > 0) {
    console.error(`\n[check-client-exposure] FAILED — ${findings.length} finding(s):\n`);
    for (const finding of findings) {
      console.error(`  ✗ ${finding.checkId}`);
      console.error(`    meaning: ${finding.meaning}`);
      console.error(`    file:    ${finding.file}`);
      console.error(`    context: …${finding.context}…\n`);
    }
    console.error(
      'Remediation: the offending module is reachable from a client graph. Check for a barrel\n' +
        'file re-exporting src/server/**, a `use client` component importing @/server/*, or a\n' +
        'secret placed in a NEXT_PUBLIC_* variable. See docs/architecture/README.md §M.',
    );
    process.exit(1);
  }

  console.log('[check-client-exposure] PASSED — no server-only material in client artifacts.');
}

await main();
