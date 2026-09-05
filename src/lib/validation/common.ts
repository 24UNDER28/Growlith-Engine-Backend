import { z } from 'zod';

/**
 * Shared validation primitives (ADR-0017).
 *
 * Conventions every schema in this repository follows:
 *
 * 1. **One definition, three consumers.** The same Zod schema validates the
 *    request in the route handler, types the generated TypeScript via
 *    `z.infer`, and drives the browser form. There is no second copy to drift.
 * 2. **`.strict()` on every input object.** Unknown keys are rejected rather
 *    than stripped silently, which is what makes mass assignment impossible: a
 *    client cannot smuggle `organizationId` or `role` into a create payload.
 * 3. **`.trim()` on every free-text field.** Leading/trailing whitespace is a
 *    source of duplicate slugs, failed lookups and visually identical rows.
 * 4. **Explicit messages naming the field.** The message is shown to a human in
 *    an error state (Rule 20), so `Required` is not acceptable.
 *
 * Entity schemas (`organization.ts`, `engagement.ts`, …) are added in Phase 5
 * alongside their endpoints. They are deliberately NOT written now: inventing a
 * persistence model before the Phase 2 schema exists would guarantee drift
 * (Rule 14).
 */

/**
 * A UUID primary key.
 *
 * Returns `ZodType<string>` rather than `ZodString`: in Zod 4 the specialised
 * formats (`z.uuid()`, `z.iso.datetime()`) are their own types, not subclasses
 * of `ZodString`.
 */
export function uuidField(label: string): z.ZodType<string> {
  return z.uuid({ message: `${label} must be a valid UUID` });
}

/**
 * A URL-safe slug: lowercase alphanumerics separated by single hyphens.
 *
 * Used for organization identifiers that appear in `/portal/[orgSlug]`. The
 * pattern is anchored and forbids leading/trailing hyphens so a slug can never
 * collide with a route segment or produce an empty path part.
 */
export function slugField(label: string, max = 64): z.ZodString {
  return z
    .string()
    .trim()
    .min(2, `${label} must be at least 2 characters`)
    .max(max, `${label} must be at most ${max} characters`)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
      message: `${label} may contain only lowercase letters, numbers and single hyphens`,
    });
}

/** Required non-empty text with an upper bound. */
export function textField(label: string, max: number): z.ZodString {
  return z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`);
}

/** Optional non-empty text: absent, or present and valid. Never an empty string. */
export function optionalTextField(label: string, max: number): z.ZodOptional<z.ZodString> {
  return textField(label, max).optional();
}

/** An ISO-8601 timestamp in UTC. Offsets are rejected so stored times are comparable. */
export function timestampField(label: string): z.ZodType<string> {
  return z.iso.datetime({
    message: `${label} must be an ISO-8601 UTC timestamp (e.g. 2026-09-05T12:00:00Z)`,
  });
}

/** A free-text identifier supplied by a client, bounded to prevent abuse. */
export function boundedString(label: string, min: number, max: number): z.ZodString {
  return z
    .string()
    .trim()
    .min(min, `${label} must be at least ${min} characters`)
    .max(max, `${label} must be at most ${max} characters`);
}
