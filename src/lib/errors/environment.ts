/**
 * Environment configuration failure.
 *
 * Lives in `src/lib` rather than `src/server` because both the server env
 * contract (`src/server/env.ts`) and the browser env contract
 * (`src/lib/env/client-env.ts`) raise it, and `src/lib` may not import from
 * `src/server` (ADR-0002 — the client/server wall).
 */
export class EnvironmentError extends Error {
  /** Human-readable, multi-line description of every configuration problem. */
  readonly report: string;

  constructor(report: string) {
    super(`Environment configuration is invalid:\n${report}`);
    this.name = 'EnvironmentError';
    this.report = report;
  }
}
