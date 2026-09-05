# ADR-0006: The Service Catalogue Is Separate From Purchased Service Instances

**Status:** Accepted
**Phase:** 2

## Context

Growlith publishes seven service lines, and runs seven internal delivery teams.
Today the correspondence is one-to-one. Two collapses are tempting:

1. merge "service line" and "team" into a single enum, since they match;
2. merge the catalogue into the per-client record, since a client's services are
   the only ones anyone queries.

Both trade a real future cost for a small present saving.

## Decision

Model three things, not one.

**`service_line` and `team` stay separate enums**, related by
`service_lines.default_team`. A service line is _what the client bought_; a team
is _who delivers it_. The 1:1 mapping is seeded as the default and
`services.delivering_team` may override it — a Web Core engagement delivered
jointly by `WEB_DEVELOPMENT` and `SEO` costs nothing to express. A merged enum
would make that a migration touching every row.

**`service_lines` (catalogue) stays separate from `services` (instance).**
`service_lines` is seven global rows, identical for every tenant.
`services` is a child of `engagement` carrying scope, fee, dates, status and the
delivering team. Collapsing them would duplicate the catalogue per client and
make cross-client reporting — "blended ROAS across all Precision Paid Media
clients" — impossible without string matching.

**Both vocabularies are enums _and_ lookup tables.** The enum gives type safety
in columns and FKs; the table keyed by that enum carries the attributes an enum
cannot: label, description, sort order, active flag, team lead. One source of
truth, two representations, no duplication — display data is editable without a
type rewrite.

## Consequences

- Seven catalogue rows and seven team rows ship inside migration 03, not in
  `seed.sql`. They are reference data the schema depends on: `services` has a
  NOT NULL FK to `service_lines`.
- `SERVICE_LINE_DEFAULT_TEAM` in `src/lib/domain/service-lines.ts` and
  `service_lines.default_team` must agree. `tests/unit/schema.spec.ts` asserts
  the enum halves match; the mapping itself is asserted by the domain suite.
- Deactivating a service line is `is_active = false`, never a delete: historical
  `services` rows reference it and the FK is RESTRICT.
