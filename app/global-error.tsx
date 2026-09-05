'use client';

/**
 * Root error boundary — the last resort when `app/layout.tsx` itself throws.
 *
 * Next.js requires this component to render its own `<html>` and `<body>`,
 * because the ones from the root layout are no longer usable at this point.
 */

interface GlobalErrorProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  return (
    <html lang="en">
      <body>
        <main>
          <h1>Application error</h1>
          <p>The portal failed to render. Please reload; if it persists, contact support.</p>
          <p>
            Reference: <code>{error.digest ?? 'unavailable'}</code>
          </p>
          <button type="button" onClick={reset}>
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
