import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Filesystem helpers for the architecture tests.
 *
 * Those tests assert properties of the *repository* rather than of a running
 * program — that every server module declares its boundary, that no isomorphic
 * module reaches a secret, that the environment template matches the code. Such
 * invariants can only be checked by reading source, so these helpers exist.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repository root. */
export const REPO_ROOT = resolve(here, '..', '..');

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  'coverage',
  'dist',
  'build',
  '.turbo',
  '.temp',
]);

export interface WalkOptions {
  /** Only descend into these root-relative directories. */
  readonly roots?: readonly string[];
  /** Only return files whose extension is in this set. */
  readonly extensions?: ReadonlySet<string>;
}

/** Recursively list repository files, POSIX-style relative paths. */
export function walkRepository(options: WalkOptions = {}): string[] {
  const roots = options.roots ?? ['.'];
  const collected: string[] = [];

  for (const root of roots) {
    const absolute = join(REPO_ROOT, root);
    if (!exists(absolute)) {
      continue;
    }
    collect(absolute, options.extensions, collected);
  }

  return collected.map((file) => relative(REPO_ROOT, file).split(sep).join('/')).sort();
}

function collect(
  directory: string,
  extensions: ReadonlySet<string> | undefined,
  out: string[],
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      collect(fullPath, extensions, out);
      continue;
    }

    if (extensions === undefined || extensions.has(extensionOf(entry.name))) {
      out.push(fullPath);
    }
  }
}

export function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Read a repository file by root-relative POSIX path. */
export function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

export function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index === -1 ? '' : fileName.slice(index);
}

/**
 * Extract every module specifier from `import`/`export … from` statements.
 *
 * A deliberate, dependency-free approximation: it does not build an AST, but it
 * is sufficient for detecting the import shapes this codebase uses, and being
 * readable matters more here than being exhaustive.
 */
export function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }

  return specifiers;
}

/**
 * Remove comments from TypeScript source so a scan matches *code*, not prose.
 *
 * Without this, a rule documented in a comment — "nothing here may touch
 * `document`" — would trip the very test that enforces it.
 *
 * A deliberate approximation, like `extractImportSpecifiers`: it does not
 * tokenize, so a comment marker inside a string literal can confuse it. That is
 * an acceptable trade here, because the patterns these scans look for are far
 * more likely to appear in an explanatory comment than in a string, and the
 * `[^:]` guard keeps URLs such as `https://` intact.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** True when the file begins with a React `"use client"` directive. */
export function hasUseClientDirective(source: string): boolean {
  return /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]\s*;?/m.test(source);
}

/**
 * The first `import` statement in a module, ignoring leading comments.
 * Returns `null` when the module has no imports.
 */
export function firstImportStatement(source: string): string | null {
  const match = /^\s*import\s+[^;]*;/m.exec(source);
  return match ? match[0].trim() : null;
}
