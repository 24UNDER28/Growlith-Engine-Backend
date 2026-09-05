import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor } from '@/lib/pagination/cursor';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, clampPageSize } from '@/lib/pagination/limits';

describe('cursor codec', () => {
  it('round-trips a string sort key', () => {
    const cursor = encodeCursor({ key: '2026-09-05T12:00:00Z', id: 'task-1' });
    expect(decodeCursor(cursor)).toEqual({ key: '2026-09-05T12:00:00Z', id: 'task-1' });
  });

  it('round-trips a numeric sort key', () => {
    const cursor = encodeCursor({ key: 42, id: 'task-2' });
    expect(decodeCursor(cursor)).toEqual({ key: 42, id: 'task-2' });
  });

  it('round-trips a null sort key (nullable sort columns are common)', () => {
    const cursor = encodeCursor({ key: null, id: 'task-3' });
    expect(decodeCursor(cursor)).toEqual({ key: null, id: 'task-3' });
  });

  it('round-trips non-ASCII content without corrupting it', () => {
    // btoa throws on characters outside Latin-1, so the codec must encode UTF-8
    // bytes first. A deliverable titled in Nepali or Arabic must page correctly.
    const cursor = encodeCursor({ key: 'प्रगति — تقرير', id: 'task-4' });
    expect(decodeCursor(cursor)).toEqual({ key: 'प्रगति — تقرير', id: 'task-4' });
  });

  it('produces a URL-safe string', () => {
    const cursor = encodeCursor({ key: 'a+b/c=d?f&g', id: 'task-5' });
    expect(cursor).not.toMatch(/[+/=]/);
    expect(decodeCursor(cursor)).toEqual({ key: 'a+b/c=d?f&g', id: 'task-5' });
  });

  describe('rejects anything the system did not issue', () => {
    it('returns null for empty and absent input', () => {
      expect(decodeCursor('')).toBeNull();
      expect(decodeCursor(null)).toBeNull();
      expect(decodeCursor(undefined)).toBeNull();
    });

    it('returns null for non-base64url garbage', () => {
      expect(decodeCursor('not-a-cursor!!')).toBeNull();
    });

    it('returns null for base64url that is not JSON', () => {
      expect(decodeCursor(btoa('plain text').replace(/=+$/, ''))).toBeNull();
    });

    it('returns null for JSON that fails the schema', () => {
      const encode = (value: unknown): string =>
        btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      expect(decodeCursor(encode({ id: 'x' }))).toBeNull(); // missing key
      expect(decodeCursor(encode({ key: 'k' }))).toBeNull(); // missing id
      expect(decodeCursor(encode({ key: 'k', id: '' }))).toBeNull(); // empty id
      expect(decodeCursor(encode({ key: 'k', id: 'x', extra: 1 }))).toBeNull(); // strict
      expect(decodeCursor(encode([1, 2, 3]))).toBeNull(); // wrong shape
      expect(decodeCursor(encode(null))).toBeNull();
    });

    it('returns null for an over-long cursor rather than decoding it', () => {
      const oversized = encodeCursor({ key: 'k'.repeat(4_000), id: 'task-6' });
      expect(oversized.length).toBeGreaterThan(512);
      expect(decodeCursor(oversized)).toBeNull();
    });
  });
});

describe('clampPageSize', () => {
  it('applies the default when nothing usable is supplied', () => {
    expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(null)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize('abc')).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize({})).toBe(DEFAULT_PAGE_SIZE);
  });

  it('rejects zero and negative sizes instead of returning an empty page', () => {
    expect(clampPageSize(0)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(-10)).toBe(DEFAULT_PAGE_SIZE);
  });

  it('caps the maximum so a client cannot request an unbounded page', () => {
    expect(clampPageSize(MAX_PAGE_SIZE)).toBe(MAX_PAGE_SIZE);
    expect(clampPageSize(MAX_PAGE_SIZE + 1)).toBe(MAX_PAGE_SIZE);
    expect(clampPageSize(10_000_000)).toBe(MAX_PAGE_SIZE);
  });

  it('coerces numeric strings, because query parameters always arrive as text', () => {
    expect(clampPageSize('50')).toBe(50);
    expect(clampPageSize('99999')).toBe(MAX_PAGE_SIZE);
  });

  it('truncates fractional sizes rather than rounding up past the cap', () => {
    expect(clampPageSize(3.7)).toBe(3);
    expect(clampPageSize(99.9)).toBe(99);
  });
});
