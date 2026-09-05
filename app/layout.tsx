import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Root layout.
 *
 * Phase 1 scope: this is the minimum shell required for the repository to build
 * and serve. It contains no design system, no navigation and no dashboard
 * chrome — those arrive in Phase 9 (ADR-0001 keeps both dashboards in this one
 * app, under the `(admin)` and `(portal)` route groups).
 *
 * It deliberately imports nothing from `src/lib/env` or `src/server/**`: the root
 * layout must render even when the environment is unconfigured, so that an
 * operator sees a legible page and the health probe stays reachable while the
 * rest of the system is being brought up.
 */
export const metadata: Metadata = {
  title: {
    default: 'Growlith Engine',
    template: '%s · Growlith Engine',
  },
  description:
    'Internal portal for Growlith Academy: administration and client delivery across engagements, services, projects, deliverables and tasks.',
  // A portal holding client performance data must never be indexable.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
