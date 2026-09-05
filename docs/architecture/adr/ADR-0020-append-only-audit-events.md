# ADR-0020: Append-Only, Partitioned `audit_events` With One Justified JSONB Column

**Status:** Accepted
**Phase:** 2

## Context

`updated_at` and `updated_by` record only the _last_ writer, and nothing about
what changed or why. Contractual retention obligations and any credible access
review need more: who did what, to which row, when, from where, and what the row
looked like before.

Three design questions had defensible answers in both directions.

## Decision

**No foreign keys on `organization_id`, `actor_user_id` or `entity_id`.** An
audit event must outlive the row it describes — the most important event in the
table is often the deletion itself. A foreign key would make the evidence
cascade away with the act it records. The columns are typed `uuid` and indexed;
they are simply not constrained.

**`before`/`after` are `jsonb`, and this is the only JSON column in the schema.**
The rejected alternative is a typed shadow table per entity: fifteen tables to
migrate in lockstep, forever, so that a write-once payload can have a schema
nobody queries by key. Audit payloads are written once, read rarely, never
joined and never filtered on an individual key. Every dimension anyone actually
queries — `organization_id`, `actor_user_id`, `entity_kind`, `entity_id`,
`action`, `severity`, `changed_fields`, `request_id` — is a real typed column.
The jsonb holds the diff body and nothing else. This is the justification the
Phase 2 brief demands for a JSON column; it does not generalize to any other
table.

**Partitioned monthly from day one**, by range on `occurred_at`, with a DEFAULT
partition so an insert can never fail for want of one. Thirteen months are
created up front, so no scheduled job is needed in the first year and a missed
job is never an incident. Retrofitting partitioning onto a live audit table is a
maintenance window and a full rewrite; doing it now costs one clause.

**Immutable for everyone.** `UPDATE` and `DELETE` are rejected by a trigger, not
a policy — `service_role` bypasses RLS but not triggers. The single escape hatch
is a transaction that has set `growlith.allow_purge = on`, which only the
SUPER_ADMIN purge RPC does, and which writes a `HARD_DELETE` event first.
PostgREST callers cannot issue `set_config`.

**Severity is derived, not supplied.** The generic trigger reads the diff:
`deleted_at` transitions become `SOFT_DELETE`/`RESTORE`, a `status` change
becomes `STATUS_CHANGE`, and any write to `organization_memberships` or
`platform_role_grants` is `CRITICAL` because those two tables are the entire
privilege-escalation surface.

## Consequences

- `changed_fields` excludes `updated_at`, which would otherwise appear in every
  diff and make the column noise. An update that changes nothing else writes no
  event at all.
- `token_hash` and `checksum_sha256` are redacted from payloads, mirroring the
  Phase 1 logger's redaction list. An audit row is still a row somebody can read.
- `request_id` joins an audit event to the Phase 1 structured log, so a database
  change and the HTTP request that caused it can be correlated without guessing.
- The PK is `(id, occurred_at)` — bigint identity plus the partition key, which
  every unique constraint on a partitioned table must include. Monotonic
  ordering matters more than opacity here, and nothing references an audit event.
