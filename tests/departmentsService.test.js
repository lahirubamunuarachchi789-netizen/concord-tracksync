import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDepartmentsFetcher,
  normalizeDepartmentOptions,
} from '../lib/departmentsService.js';

/** Mock supabase-js client capturing the query chain for one table. */
function createMockSupabase(tables = {}) {
  const queries = [];
  const makeBuilder = (tableName) => {
    const record = { table: tableName, select: null, orders: [] };
    queries.push(record);
    const chain = {
      select(columns) {
        record.select = columns;
        return chain;
      },
      order(column, opts) {
        record.orders.push([column, opts]);
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

test('normalizeDepartmentOptions keeps exact casing/format from the table', () => {
  const rows = [
    { department: 'Upper Line 01' },
    { department: 'Lasting 01' },
    { department: 'Quality Control' },
  ];
  assert.deepEqual(normalizeDepartmentOptions(rows), [
    'Upper Line 01',
    'Lasting 01',
    'Quality Control',
  ]);
});

test('normalizeDepartmentOptions drops blanks and collapses exact duplicates', () => {
  const rows = [
    { department: 'Desma' },
    { department: '   ' },
    { department: 'Desma' },
    { department: null },
    { department: 'Cutting' },
  ];
  assert.deepEqual(normalizeDepartmentOptions(rows), ['Desma', 'Cutting']);
  // Whitespace-padded variants are DISTINCT values (exact match preserved).
  const padded = normalizeDepartmentOptions([{ department: 'Desma' }, { department: 'Desma ' }]);
  assert.deepEqual(padded, ['Desma', 'Desma ']);
});

test('normalizeDepartmentOptions accepts plain strings and non-arrays', () => {
  assert.deepEqual(normalizeDepartmentOptions(['A', 'B']), ['A', 'B']);
  assert.deepEqual(normalizeDepartmentOptions(null), []);
  assert.deepEqual(normalizeDepartmentOptions('nope'), []);
});

test('fetcher runs SELECT department ORDER BY sequence ASC, department ASC', async () => {
  const { client, queries } = createMockSupabase({
    departments: {
      data: [{ department: 'Upper Line 01' }, { department: 'Lasting 01' }],
      error: null,
    },
  });
  const fetchDepartments = createDepartmentsFetcher(client);
  const result = await fetchDepartments();
  assert.equal(result.ok, true);
  assert.deepEqual(result.departments, ['Upper Line 01', 'Lasting 01']);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].table, 'departments');
  assert.equal(queries[0].select, 'department');
  assert.deepEqual(queries[0].orders, [
    ['sequence', { ascending: true }],
    ['department', { ascending: true }],
  ]);
});

test('fetcher returns ok:false with a friendly message on RLS errors (never throws)', async () => {
  const { client } = createMockSupabase({
    departments: { data: null, error: new Error('row-level security policy') },
  });
  const fetchDepartments = createDepartmentsFetcher(client);
  const result = await fetchDepartments();
  assert.equal(result.ok, false);
  assert.equal(result.departments.length, 0);
  assert.match(result.message, /Row Level Security/);
});

test('fetcher reports a missing table and network failures gracefully', async () => {
  const missing = createDepartmentsFetcher(
    createMockSupabase({
      departments: { data: null, error: new Error("relation 'departments' does not exist") },
    }).client
  );
  const missingResult = await missing();
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.message, /departments-schema\.sql/);

  const network = createDepartmentsFetcher(
    createMockSupabase({
      departments: { data: null, error: new Error('TypeError: failed to fetch') },
    }).client
  );
  const networkResult = await network();
  assert.equal(networkResult.ok, false);
  assert.match(networkResult.message, /Network unavailable/);
});

test('fetcher resolves to an empty list when the table has no rows', async () => {
  const fetchDepartments = createDepartmentsFetcher(createMockSupabase().client);
  const result = await fetchDepartments();
  assert.equal(result.ok, true);
  assert.deepEqual(result.departments, []);
});