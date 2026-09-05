import { z } from 'zod';

import type { Cursor, CursorPayload } from '@/lib/types/pagination';

/**
 * Keyset cursor codec.
 *
 * Isomorphic and dependency-free: `btoa`/`atob`, `TextEncoder` and
 * `TextDecoder` are available as globals in both Node (>= 16) and browsers, so
 * the same codec runs in a route handler and in the browser client.
 *
 * Cursors are opaque to clients by contract. They are base64url-encoded so they
 * are URL-safe, and every decode is schema-validated — a client that tampers
 * with one gets `null`, which the caller maps to a 400 `VALIDATION_FAILED`
 * rather than to a database error.
 */

const MAX_CURSOR_LENGTH = 512;

const cursorPayloadSchema = z
  .object({
    key: z.union([z.string(), z.number(), z.null()]),
    id: z.string().min(1),
  })
  .strict();

export function encodeCursor(payload: CursorPayload): Cursor {
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Decode and validate a cursor.
 *
 * @returns the payload, or `null` when the input is not a cursor this system
 *          issued. Callers must treat `null` as a client error, never as
 *          "start from the beginning" — silently restarting would hide tampering
 *          and could re-expose rows the client had already paged past.
 */
export function decodeCursor(raw: string | null | undefined): CursorPayload | null {
  if (raw === null || raw === undefined || raw.length === 0) {
    return null;
  }
  if (raw.length > MAX_CURSOR_LENGTH) {
    return null;
  }

  let json: string;
  try {
    json = fromBase64Url(raw);
  } catch {
    // Not base64url. Expected for a tampered or truncated cursor; the caller
    // converts this into a 400, so it is handled rather than swallowed.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  const result = cursorPayloadSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (base64.length % 4)) % 4;
  const binary = atob(base64 + '='.repeat(padding));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
