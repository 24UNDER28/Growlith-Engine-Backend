import { describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@/lib/types/error-codes';
import { decodeCursor, encodeCursor } from '@/lib/pagination/cursor';
import { listLive } from '@/server/services/crud';

/**
 * Regression tests for the keyset pagination shared by every list endpoint
 * (Phase 5 API audit).
 *
 * These pin the contract that alternate sorts and NULL sort values were
 * violating before the fix:
 *
 *  1. the keyset key is the value of the SORT COLUMN of the last row —
 *     never a hard-coded `created_at` (a cursor issued for `sort=dueDate`
 *     must continue from a due-date, not from a created-at);
 *  2. the SQL column ordered is a REAL column of the queried table (lists may
 *     only offer sorts whose columns exist — `sort=name` on `profiles`, which
 *     has no `name` column, previously reached the database and 500'd);
 *  3. a tampered cursor cannot smuggle PostgREST `or(...)` grammar into the
 *     filter clause through the key value;
 *  4. a page boundary inside the NULL tail of a nullable sort column pages
 *     onward with an `is null AND id < …` bound instead of repeating page one.
 */

interface ChainEvent {
  readonly op: string;
  readonly args: readonly unknown[];
}

/** A PostgREST-shaped chain that records every call and resolves `rows`. */
function makeChain(rows: readonly Record<string, unknown>[]): {
  readonly events: ChainEvent[];
  readonly from: ReturnType<typeof vi.fn>;
} {
  const events: ChainEvent[] = [];
  const chain: Record<string, unknown> = {};
  const push =
    (op: string) =>
    (...args: unknown[]) => {
      events.push({ op, args });
      return chain;
    };
  for (const op of [
    'select',
    'eq',
    'is',
    'in',
    'gte',
    'lte',
    'lt',
    'or',
    'ilike',
    'order',
    'limit',
  ]) {
    chain[op] = push(op);
  }
  chain.then = (
    onFulfilled?: (value: { data: readonly Record<string, unknown>[]; error: null }) => unknown,
  ): Promise<unknown> =>
    Promise.resolve({ data: rows, error: null }).then((value) =>
      onFulfilled === undefined ? value : onFulfilled(value),
    );
  return { events, from: vi.fn(() => chain) };
}

const { clientMock } = vi.hoisted(() => ({ clientMock: vi.fn() }));

vi.mock('@/server/supabase/client-server', () => ({
  createSupabaseServerClient: (...args: unknown[]) => clientMock(...args),
}));

function iso(day: number, hour = 12): string {
  return `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
}

/** Deterministic UUID-shaped ids (keyset filters constrain ids to UUIDs). */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function row(id: string, created: string, dueDate: string | null): Record<string, unknown> {
  return { id, created_at: created, due_date: dueDate };
}

function orderCalls(events: ChainEvent[]): ChainEvent[] {
  return events.filter((event) => event.op === 'order');
}

const TASK_SORTS = ['createdAt', 'dueDate', 'position'] as const;

describe('listLive keyset pagination', () => {
  it('orders DESC with NULLs last and probes limit+1 (default createdAt sort)', async () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      row(uuid(index), iso(30 - Math.trunc(index / 2), 8 + index), null),
    );
    const fake = makeChain(rows);
    clientMock.mockResolvedValue({ from: fake.from });

    const result = await listLive({
      table: 'tasks',
      query: {},
      allowedSorts: [...TASK_SORTS],
      apply: (q) => q,
    });

    const orders = orderCalls(fake.events);
    expect(orders[0]!.args).toEqual(['created_at', { ascending: false, nullsFirst: false }]);
    expect(orders[1]!.args).toEqual(['id', { ascending: false }]);
    const limit = fake.events.find((event) => event.op === 'limit');
    expect(limit?.args).toEqual([26]); // default page 25 + 1 probe
    expect(result.data).toHaveLength(25);
    expect(result.pagination.hasMore).toBe(true);
  });

  it('keys a cursor on the SORT COLUMN value, not on created_at', async () => {
    // Rows as the database would return them for due_date DESC ordering.
    const rows = Array.from({ length: 30 }, (_, index) =>
      row(uuid(index), iso(1, 8), iso(30 - index)),
    );
    const fake = makeChain(rows);
    clientMock.mockResolvedValue({ from: fake.from });

    const result = await listLive({
      table: 'tasks',
      query: { sort: 'dueDate' },
      allowedSorts: [...TASK_SORTS],
      apply: (q) => q,
    });

    const orders = orderCalls(fake.events);
    expect(orders[0]!.args[0]).toBe('due_date');
    const decoded = decodeCursor(result.pagination.nextCursor);
    // Continue from the DUE DATE of the 25th row — never its created_at.
    expect(decoded?.key).toBe(rows[24]!.due_date);
    expect(decoded?.id).toBe(rows[24]!.id);
  });

  it('continues an alternate-sort page from the sort-column bound', async () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      row(uuid(index), iso(1, 8), iso(30 - index)),
    );
    const fake = makeChain(rows);
    clientMock.mockResolvedValue({ from: fake.from });

    const cursor = encodeCursor({
      key: rows[24]!.due_date as string,
      id: rows[24]!.id as string,
      sort: 'dueDate',
    });

    await listLive({
      table: 'tasks',
      query: { cursor, sort: 'dueDate' },
      allowedSorts: [...TASK_SORTS],
      apply: (q) => q,
    });

    const orEvent = fake.events.find((event) => event.op === 'or');
    expect(orEvent?.args[0]).toBe(
      `due_date.lt.${rows[24]!.due_date},and(due_date.eq.${rows[24]!.due_date},id.lt.${rows[24]!.id})`,
    );
  });

  it('rejects a cursor key that smuggles PostgREST filter grammar', async () => {
    const fake = makeChain([]);
    clientMock.mockResolvedValue({ from: fake.from });

    // The shape an attacker needs to rewrite the predicate inside or(...).
    const cursor = encodeCursor({
      key: '2026-09-05,id.lt.00000000-0000-0000-0000-000000000000',
      id: uuid(0),
      sort: 'createdAt',
    });

    await expect(
      listLive({
        table: 'tasks',
        query: { cursor },
        allowedSorts: [...TASK_SORTS],
        apply: (q) => q,
      }),
    ).rejects.toMatchObject({ status: 422, code: ErrorCode.ValidationFailed });
    // The poisoned filter never reached the database.
    expect(fake.events.some((event) => event.op === 'or')).toBe(false);
  });

  it('pages through the NULL tail of a nullable sort column instead of repeating page one', async () => {
    const fake = makeChain([]);
    clientMock.mockResolvedValue({ from: fake.from });

    // The previous page ended inside the NULL group (key null).
    const cursor = encodeCursor({ key: null, id: uuid(24), sort: 'dueDate' });

    await listLive({
      table: 'tasks',
      query: { cursor, sort: 'dueDate' },
      allowedSorts: [...TASK_SORTS],
      apply: (q) => q,
    });

    const orEvent = fake.events.find((event) => event.op === 'or');
    expect(orEvent?.args[0]).toBe(`and(due_date.is.null,id.lt.${uuid(24)})`);
  });

  it('answers 422 for a sort key whose column does not exist on the table', async () => {
    const fake = makeChain([]);
    clientMock.mockResolvedValue({ from: fake.from });

    // `profiles` has no `name` column; `sort=name` must be rejected before
    // it can reach PostgreSQL (previously: PostgREST error -> 500/503).
    await expect(
      listLive({
        table: 'profiles',
        query: { sort: 'name' },
        allowedSorts: ['createdAt'],
        apply: (q) => q,
      }),
    ).rejects.toMatchObject({ status: 422, code: ErrorCode.ValidationFailed });
    expect(fake.from).not.toHaveBeenCalled();
  });

  it('orders ASCENDING keys with an id tie-break in the same direction', async () => {
    const rows = Array.from({ length: 26 }, (_, index) => row(uuid(index), iso(index), null));
    const fake = makeChain(rows);
    clientMock.mockResolvedValue({ from: fake.from });

    await listLive({
      table: 'tasks',
      query: {},
      allowedSorts: [...TASK_SORTS],
      ascendingKeys: ['dueDate', 'position'],
      apply: (q) => q,
    });

    const orders = orderCalls(fake.events);
    expect(orders[0]?.args).toEqual(['created_at', { ascending: false, nullsFirst: false }]);
    expect(orders[1]?.args).toEqual(['id', { ascending: false }]);

    const fake2 = makeChain(rows);
    clientMock.mockResolvedValue({ from: fake2.from });
    await listLive({
      table: 'tasks',
      query: { sort: 'position' },
      allowedSorts: [...TASK_SORTS],
      ascendingKeys: ['dueDate', 'position'],
      apply: (q) => q,
    });
    const ascOrders = orderCalls(fake2.events);
    // Board order: position 1 first; NULLs last even when ascending.
    expect(ascOrders[0]?.args).toEqual(['position', { ascending: true, nullsFirst: false }]);
    expect(ascOrders[1]?.args).toEqual(['id', { ascending: true }]);
  });

  it('keysets an ASCENDING sort with a `gt` bound', async () => {
    const fake = makeChain([]);
    clientMock.mockResolvedValue({ from: fake.from });
    const cursor = encodeCursor({ key: '2026-09-05', id: uuid(24), sort: 'dueDate' });

    await listLive({
      table: 'deliverables',
      query: { cursor, sort: 'dueDate' },
      allowedSorts: ['createdAt', 'dueDate'],
      ascendingKeys: ['dueDate'],
      apply: (q) => q,
    });

    const orEvent = fake.events.find((event) => event.op === 'or');
    expect(orEvent?.args[0]).toBe(
      `due_date.gt.2026-09-05,and(due_date.eq.2026-09-05,id.gt.${uuid(24)})`,
    );
  });

  it('pages the NULL tail of an ASCENDING sort with `is null AND id.gt`', async () => {
    const fake = makeChain([]);
    clientMock.mockResolvedValue({ from: fake.from });
    const cursor = encodeCursor({ key: null, id: uuid(24), sort: 'dueDate' });

    await listLive({
      table: 'tasks',
      query: { cursor, sort: 'dueDate' },
      allowedSorts: [...TASK_SORTS],
      ascendingKeys: ['dueDate'],
      apply: (q) => q,
    });

    const orEvent = fake.events.find((event) => event.op === 'or');
    expect(orEvent?.args[0]).toBe(`and(due_date.is.null,id.gt.${uuid(24)})`);
  });
});
