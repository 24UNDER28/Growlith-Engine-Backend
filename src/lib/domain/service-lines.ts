import { type InternalTeam } from '@/lib/domain/teams';

/**
 * Service lines — what a client buys.
 *
 * ADR-0006 resolves an ambiguity in the stated hierarchy
 * (Organization → Engagement → **Service** → Project → Deliverable → Task):
 * "Service" could mean the fixed catalogue of offerings, or a purchased instance
 * scoped to an engagement. Both are needed, so they are modelled separately:
 *
 * - `service_lines` (this module) — the stable catalogue. Reference data, one
 *   row per offering, identical for every client.
 * - `services` (Phase 2) — the purchased instance, a child of `engagement`,
 *   carrying scope, fee, dates, status and the team actually delivering it.
 *
 * Collapsing the two would force per-client duplication of the catalogue and
 * make reporting across clients impossible.
 */
export const SERVICE_LINES = [
  'PROGRAMMATIC_SEO',
  'PRECISION_PAID_MEDIA',
  'WEB_CORE',
  'LIFECYCLE_CRM',
  'AI_AUTOMATIONS',
  'VIDEO_MULTIMEDIA',
  'ACCOUNT_MANAGEMENT',
] as const;

export type ServiceLine = (typeof SERVICE_LINES)[number];

export const SERVICE_LINE_LABELS = {
  PROGRAMMATIC_SEO: 'Programmatic SEO',
  PRECISION_PAID_MEDIA: 'Precision Paid Media',
  WEB_CORE: 'Sub-Second Web Core',
  LIFECYCLE_CRM: 'Lifecycle CRM',
  AI_AUTOMATIONS: 'AI Automations',
  VIDEO_MULTIMEDIA: 'Video & Multimedia',
  ACCOUNT_MANAGEMENT: 'Account Management',
} as const satisfies Record<ServiceLine, string>;

/**
 * Default delivering team per service line (ADR-0006).
 *
 * The correspondence is 1:1 today, and that is a real domain invariant rather
 * than a coincidence — the public service pages map directly onto the internal
 * teams. It is expressed as a mapping rather than a merged enum because the
 * relationship is expected to become N:M: a Web Core engagement may later be
 * delivered jointly by WEB_DEVELOPMENT and SEO.
 *
 * Seeded as a default in Phase 2. A `services` row may override it, so the
 * mapping constrains nothing that the business needs to vary.
 */
export const SERVICE_LINE_DEFAULT_TEAM = {
  PROGRAMMATIC_SEO: 'SEO',
  PRECISION_PAID_MEDIA: 'PAID_MEDIA',
  WEB_CORE: 'WEB_DEVELOPMENT',
  LIFECYCLE_CRM: 'CRM_LIFECYCLE',
  AI_AUTOMATIONS: 'AI_AUTOMATION',
  VIDEO_MULTIMEDIA: 'VIDEO_MULTIMEDIA',
  ACCOUNT_MANAGEMENT: 'ACCOUNT_MANAGEMENT',
} as const satisfies Record<ServiceLine, InternalTeam>;

export function isServiceLine(value: string): value is ServiceLine {
  return (SERVICE_LINES as readonly string[]).includes(value);
}

export function defaultTeamForServiceLine(line: ServiceLine): InternalTeam {
  return SERVICE_LINE_DEFAULT_TEAM[line];
}
