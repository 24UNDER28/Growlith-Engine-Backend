import Link from 'next/link';

/**
 * 404 page.
 *
 * Note the deliberate absence of detail. A 404 in this system means either "this
 * does not exist" or "this exists in another tenant and RLS hid it from you".
 * Those two cases must remain indistinguishable to the caller (ADR-0019), and
 * that applies to navigation as well as to the API — so this page confirms
 * nothing about what was requested.
 */
export default function NotFound() {
  return (
    <main>
      <h1>Not found</h1>
      <p>The page you requested does not exist, or you do not have access to it.</p>
      <p>
        <Link href="/">Return to the start</Link>
      </p>
    </main>
  );
}
