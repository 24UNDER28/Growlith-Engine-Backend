import { describe, expect, it } from 'vitest';

import { REQUEST_ID_HEADER, createRequestId, resolveRequestId } from '@/lib/utils/request-id';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function headersWith(value: string | null): Headers {
  const headers = new Headers();
  if (value !== null) {
    headers.set(REQUEST_ID_HEADER, value);
  }
  return headers;
}

describe('createRequestId', () => {
  it('produces a canonical UUID', () => {
    expect(createRequestId()).toMatch(CANONICAL_UUID);
  });

  it('produces a distinct id per call', () => {
    const ids = new Set(Array.from({ length: 1_000 }, () => createRequestId()));
    expect(ids.size).toBe(1_000);
  });
});

describe('resolveRequestId', () => {
  it('mints an id when the client sent none', () => {
    expect(resolveRequestId(new Headers())).toMatch(CANONICAL_UUID);
  });

  it('reuses a well-formed inbound id so proxy correlation survives', () => {
    const inbound = '3f2b8c1a-9d4e-4a7b-8c2f-1e6d5b4a3920';
    expect(resolveRequestId(headersWith(inbound))).toBe(inbound);
  });

  it('normalises case, so the same id correlates regardless of sender casing', () => {
    const inbound = '3F2B8C1A-9D4E-4A7B-8C2F-1E6D5B4A3920';
    expect(resolveRequestId(headersWith(inbound))).toBe(inbound.toLowerCase());
  });

  describe('log-injection resistance', () => {
    // An attacker-controlled header is written verbatim into structured logs.
    // Accepting anything other than a UUID would let a client forge additional
    // log lines or corrupt a log parser.
    const hostile = [
      'abc123',
      '3f2b8c1a-9d4e-4a7b-8c2f-1e6d5b4a3920 injected',
      '\u001b[31mred\u001b[0m', // ANSI escapes survive Headers validation
      'x'.repeat(400),
      '3f2b8c1a9d4e4a7b8c2f1e6d5b4a3920', // right characters, wrong shape
      'not-a-uuid',
    ];

    it.each(hostile)('rejects %j and mints a fresh id', (value) => {
      const resolved = resolveRequestId(headersWith(value));
      expect(resolved).toMatch(CANONICAL_UUID);
      expect(resolved).not.toBe(value.toLowerCase());
    });

    it('cannot be reached by newline forgery, because Headers rejects the value first', () => {
      // Defence at two layers: the Fetch implementation refuses CR/LF in a
      // header value, and the UUID pattern would refuse it anyway. Asserting the
      // platform behaviour documents why the newline case is absent above.
      expect(() => headersWith('id\n{"level":"error","msg":"forged"}')).toThrow();
    });
  });
});
