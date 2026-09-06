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

/**
 * A free-text search term (`?q=…`). Services interpolate `q` into a
 * PostgREST `or(...)` filter (`full_name.ilike.%q%,…`), where `,`, `(`, `)`
 * and `"` are filter-grammar characters and control characters have no
 * business in a name. Anything the grammar would treat as structure is
 * rejected up front (422) so a malformed search can never reach PostgREST as
 * a filter rewrite or a parse error; every other printable character —
 * including PostgREST's `%`/`_` ilike wildcards — passes through unchanged.
 */
export function searchQueryField(label: string, max = 200): z.ZodString {
  return z
    .string()
    .trim()
    .min(1, `${label} must not be empty`)
    .max(max, `${label} must be at most ${max} characters`)
    .refine((value) => !/[(),"\u0000-\u001f\u007f]/.test(value), {
      message: `${label} contains characters that are not allowed in a search`,
    });
}

/**
 * Organization slugs appear in `/portal/[orgSlug]` and must match the
 * `organizations_slug_shape` CHECK (min 3, max 64, no leading/trailing hyphen).
 */
export function organizationSlugField(): z.ZodString {
  return z
    .string()
    .trim()
    .min(3, 'slug must be at least 3 characters')
    .max(64, 'slug must be at most 64 characters')
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
      message: 'slug may contain only lowercase letters, numbers and single hyphens',
    });
}

/** A calendar date (YYYY-MM-DD), never a timestamp. */
export function dateField(label: string): z.ZodType<string> {
  return z.iso.date({ message: `${label} must be a calendar date (YYYY-MM-DD)` });
}

/** Closed vocabulary. The message names the allowed values so a 422 is actionable. */
export function enumField<T extends string>(label: string, values: readonly T[]): z.ZodType<T> {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error(`${label} enum must have at least one value`);
  }
  return z.enum([first, ...rest], {
    message: `${label} must be one of: ${values.join(', ')}`,
  }) as unknown as z.ZodType<T>;
}

/**
 * Comma-separated query values. Duplicates are dropped, empties ignored, and
 * the cap prevents `?status=a,a,a…` from becoming a denial-of-service vector.
 */
export function csvField<T>(inner: z.ZodType<T>, max = 20): z.ZodType<readonly T[]> {
  return z.string().transform((raw, ctx) => {
    const parts = [
      ...new Set(
        raw
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0),
      ),
    ];
    if (parts.length > max) {
      ctx.addIssue({ code: 'custom', message: `at most ${max} values` });
      return z.NEVER;
    }
    const out: T[] = [];
    for (const part of parts) {
      const parsed = inner.safeParse(part);
      if (!parsed.success) {
        ctx.addIssue({
          code: 'custom',
          message: parsed.error.issues[0]?.message ?? 'invalid value',
        });
        return z.NEVER;
      }
      out.push(parsed.data);
    }
    return out;
  });
}

/** Non-negative money stored as `numeric(14,2)`. Floats are rejected. */
export function moneyField(label: string): z.ZodNumber {
  return z
    .number({ message: `${label} must be a number` })
    .finite(`${label} must be finite`)
    .min(0, `${label} must be at least 0`)
    .max(99_999_999_999_999, `${label} is too large`);
}

/** Hex colour `#RRGGBB` as stored on organization_settings. */
export function hexColorField(label: string): z.ZodString {
  return z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, { message: `${label} must be a #RRGGBB hex colour` });
}

/** http(s) URL with an upper bound so a client cannot store a novel. */
export function httpUrlField(label: string, max = 2048): z.ZodString {
  return z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters`)
    .url({ message: `${label} must be a valid URL` })
    .refine((value) => /^https?:\/\//i.test(value), {
      message: `${label} must be an http(s) URL`,
    });
}
