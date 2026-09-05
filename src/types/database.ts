/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  GENERATED FILE — DO NOT EDIT BY HAND                                     │
 * │                                                                           │
 * │  Regenerate with:  npm run db:types                                       │
 * │  (supabase gen types typescript --local --schema public)                  │
 * │                                                                           │
 * │  This file is committed so that CI can fail when the database schema and  │
 * │  the TypeScript types disagree, rather than letting the drift reach a     │
 * │  developer's machine (ADR-0004: no ORM, generated types instead).         │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * CURRENT STATE — Phase 1 (Architecture).
 *
 * The schema does not exist yet: Phase 2 creates it. Every collection below is
 * therefore empty, which is intentional and load-bearing. An empty `Tables`
 * record means a typed `SupabaseClient<Database>` will not compile any query
 * against a table that has not been created, so the client/server boundary can
 * be built and type-checked now without inventing a persistence model that
 * Phase 2 would then contradict.
 *
 * The shape below mirrors what the Supabase CLI emits, so replacing this file
 * with real generated output in Phase 2 requires no changes at the call sites.
 */

/** Any JSONB value, as emitted by the Supabase type generator. */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
