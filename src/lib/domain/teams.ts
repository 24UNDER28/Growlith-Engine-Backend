/**
 * Internal delivery teams.
 *
 * These seven teams are the internal structure of the delivery organisation and
 * correspond to the "Twelve Pods / Four Bureaus" model on growlithacademy.com.
 * They are reference data: Phase 2 seeds them into `internal_teams`, and this
 * module remains the TypeScript source of truth so that UI labels, validation
 * and generated database enums cannot drift apart.
 *
 * A team is *who delivers*. It is deliberately distinct from a service line,
 * which is *what the client bought* — see `service-lines.ts` and ADR-0006.
 */
export const INTERNAL_TEAMS = [
  'ACCOUNT_MANAGEMENT',
  'SEO',
  'PAID_MEDIA',
  'WEB_DEVELOPMENT',
  'CRM_LIFECYCLE',
  'AI_AUTOMATION',
  'VIDEO_MULTIMEDIA',
] as const;

export type InternalTeam = (typeof INTERNAL_TEAMS)[number];

/** Human-readable labels for dashboards. Never used as an identifier. */
export const TEAM_LABELS = {
  ACCOUNT_MANAGEMENT: 'Account Management',
  SEO: 'SEO',
  PAID_MEDIA: 'Paid Media',
  WEB_DEVELOPMENT: 'Web Development',
  CRM_LIFECYCLE: 'CRM & Lifecycle',
  AI_AUTOMATION: 'AI Automation',
  VIDEO_MULTIMEDIA: 'Video & Multimedia',
} as const satisfies Record<InternalTeam, string>;

export function isInternalTeam(value: string): value is InternalTeam {
  return (INTERNAL_TEAMS as readonly string[]).includes(value);
}

export function teamLabel(team: InternalTeam): string {
  return TEAM_LABELS[team];
}
