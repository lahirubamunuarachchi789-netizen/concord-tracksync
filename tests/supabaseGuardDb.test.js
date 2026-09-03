import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseGuardDb } from '../lib/transactionGuards.js';

/**
 * Minimal thenable mock of the supabase-js PostgREST query builder:
 * every await on a chain resolves with the data configured per table
 * while recording the exact table / select / filter calls.
 */
function createMockSupabase(tables = {}) {
  const queries = [];
  const makeBuilder = (tableName) => {
    const record = { table: tableName, select: null, filters: [] };
    queries.push(record);
    const chain = {
      select(columns) {
        record.select = columns;
        return chain;
      },
      eq(column, value) {
        record.filters.push(['eq', column, value]);
        return chain;
      },
      in(column, values) {
        record.filters.push(['in', column, values]);
        return chain;
      },
      then(onFulfilled, onRejected) {
        const payload = tables[tableName] ?? { data: [], error: null };
        return Promise.resolve(payload).then(onFulfilled, onRejected);
      },
    };
    return chain;
  };
  return { client: { from: makeBuilder }, queries };
}

test('listMskRowsByMskQr queries msk for org_qr + status by msk_qr', async () => {
  const { client, queries } = createMockSupabase({
    msk: { data: [{ org_qr: 'ORG-1', status: 'Active' }], error: null },
  });
  const db = createSupabaseGuardDb(client);
  const rows = await db.listMskRowsByMskQr('MSK-9');
  assert.deepEqual(rows, [{ org_qr: 'ORG-1', status: 'Active' }]);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].table, 'msk');
  assert.equal(queries[0].select, 'org_qr, status');
  assert.deepEqual(queries[0].filters, [['eq', 'msk_qr', 'MSK-9']]);
});

test('listDepartments reads id, department and sequence', async () => {
  const departments = [
    { id: 1, department: 'Lasting 01', sequence: 3 },
    { id: 2, department: 'Lasting 02', sequence: 3 },
  ];
  const { client, queries } = createMockSupabase({
    departments: { data: departments, error: null },
  });
  const db = createSupabaseGuardDb(client);
  const rows = await db.listDepartments();
  assert.deepEqual(rows, departments);
  assert.equal(queries[0].table, 'departments');
  assert.equal(queries[0].select, 'id, department, sequence');
  assert.deepEqual(queries[0].filters, []);
});

test('getNetCount sums count rows for one qr_code across departments', async () => {
  const { client, queries } = createMockSupabase({
    data_updates: { data: [{ count: 1 }, { count: -1 }, { count: 1 }], error: null },
  });
  const db = createSupabaseGuardDb(client);
  const net = await db.getNetCount('ORG-1', ['Lasting 01', 'Lasting 02']);
  assert.equal(net, 1);
  assert.equal(queries[0].table, 'data_updates');
  assert.equal(queries[0].select, 'count');
  assert.deepEqual(queries[0].filters, [
    ['eq', 'qr_code', 'ORG-1'],
    ['in', 'department', ['Lasting 01', 'Lasting 02']],
  ]);
});

test('getNetCount returns 0 without querying when the department list is empty', async () => {
  const { client, queries } = createMockSupabase();
  const db = createSupabaseGuardDb(client);
  const net = await db.getNetCount('ORG-1', []);
  assert.equal(net, 0);
  assert.equal(queries.length, 0);
});

test('getNetCount treats non-numeric count values as 0', async () => {
  const { client } = createMockSupabase({
    data_updates: { data: [{ count: 2 }, { count: null }, { count: 'x' }], error: null },
  });
  const db = createSupabaseGuardDb(client);
  assert.equal(await db.getNetCount('ORG-1', ['D1']), 2);
});

test('every adapter method rethrows PostgREST errors for the guards to block on', async () => {
  const { client } = createMockSupabase({
    msk: { data: null, error: new Error('relation "msk" does not exist') },
    departments: { data: null, error: new Error('permission denied') },
    data_updates: { data: null, error: new Error('network error') },
  });
  const db = createSupabaseGuardDb(client);
  await assert.rejects(() => db.listMskRowsByMskQr('MSK-1'), /does not exist/);
  await assert.rejects(() => db.listDepartments(), /permission denied/);
  await assert.rejects(() => db.getNetCount('ORG-1', ['D1']), /network error/);
});
