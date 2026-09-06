#!/usr/bin/env node
/**
 * Phase 6 (M-7): Secret scan — lightweight grep-based check for committed secrets.
 * This is a complement to external scanners (gitleaks/trufflehog) that should run in CI.
 * It fails the build if obvious secret patterns appear in tracked source (not in .env.example).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'coverage',
  '.turbo',
  '.vercel',
]);
const IGNORE_FILES = new Set(['secret-scan.mjs', 'gitleaks.toml']);
const EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.toml',
  '.sql',
  '.md',
  '.yml',
  '.yaml',
]);

const PATTERNS = [
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY value',
    re: /SUPABASE_SERVICE_ROLE_KEY\s*=\s*["'][A-Za-z0-9_\-]{20,}["']/,
  },
  {
    name: 'Generic secret assignment',
    re: /(?:api_key|apikey|secret|password)\s*[:=]\s*["'][^"']{8,}["']/i,
  },
  { name: 'AWS key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private key header', re: /-----BEGIN (?:RSA )?PRIVATE KEY-----/ },
  {
    name: 'Supabase JWT (eyJ)',
    re: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/,
  },
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    if (IGNORE_FILES.has(entry)) continue;
    // M-7: tests are exempt (they contain fixture passwords like 'correct-horse')
    if (dir === ROOT && entry === 'tests') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (st.isFile()) {
      const ext = entry.includes('.') ? `.${entry.split('.').pop()}` : '';
      if (EXTENSIONS.has(ext) || entry === '.env.example') files.push(full);
      else if (!entry.startsWith('.')) files.push(full);
    }
  }
  return files;
}

let found = 0;
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  // Allow example placeholders
  if (rel === '.env.example' || rel.startsWith('supabase/templates/')) continue;
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const { name, re } of PATTERNS) {
    const match = content.match(re);
    if (match) {
      // Allow placeholder values like "anon-test-key" or "xxx"
      if (/anon-test-key|test|example|placeholder|xxx/i.test(match[0])) continue;
      // Allow references to process.env without hardcoded value
      if (
        /process\.env/.test(
          content.slice(
            Math.max(0, content.indexOf(match[0]) - 50),
            content.indexOf(match[0]) + 100,
          ),
        )
      )
        continue;
      console.error(`[secret-scan] ${name} in ${rel}: ${match[0].slice(0, 80)}`);
      found++;
    }
  }
}

if (found > 0) {
  console.error(
    `\n[secret-scan] Found ${found} potential secret(s). Review and remove before committing.`,
  );
  process.exit(1);
} else {
  console.log('[secret-scan] No obvious secrets found.');
}
