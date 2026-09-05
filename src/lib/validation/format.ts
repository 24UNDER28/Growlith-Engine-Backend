import type { ZodIssue } from 'zod';

import type { ValidationIssue } from '@/lib/types/api-envelope';

/**
 * Render Zod issues as a deterministic, human-readable report.
 *
 * Used by the environment contracts, which must fail loudly and completely:
 * listing every problem at once means an operator fixes configuration in one
 * pass instead of one restart per missing variable.
 */
export function formatValidationIssues(issues: readonly ZodIssue[]): string {
  if (issues.length === 0) {
    return '(no issues reported)';
  }

  return issues
    .map((issue) => `  - ${describePath(issue.path)}: ${issue.message} [${issue.code}]`)
    .join('\n');
}

/**
 * Convert Zod issues into the wire format shared with API clients.
 *
 * Only `path`, `message` and `code` cross the boundary. Zod issues may carry
 * additional context (including, for nested schemas, fragments of the input),
 * so the raw issue objects are never serialized to a response (ADR-0017).
 */
export function toValidationIssues(issues: readonly ZodIssue[]): ValidationIssue[] {
  return issues.map((issue) => ({
    path: describePath(issue.path),
    message: issue.message,
    code: issue.code,
  }));
}

function describePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return '(root)';
  }

  return path
    .map((segment) => (typeof segment === 'symbol' ? segment.toString() : String(segment)))
    .join('.');
}
