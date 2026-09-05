'use client';

/**
 * Route-level error boundary (Rule 20: error states are a first-class outcome).
 *
 * Phase 1 scope: functional and unstyled. It renders the correlation id, because
 * a user who can read out `requestId` turns an unreproducible "it broke" into a
 * single log query. It never renders `error.message` — a message can contain a
 * database error, a file path or a fragment of a query, none of which should
 * reach a browser (ADR-0017, §M).
 */

interface ErrorPageProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

export default function RouteError({ error, reset }: ErrorPageProps) {
  return (
    <main>
      <h1>Something went wrong</h1>
      <p>This section could not be loaded. Your data is unaffected.</p>
      <p>
        Reference: <code>{error.digest ?? 'unavailable'}</code>
      </p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
