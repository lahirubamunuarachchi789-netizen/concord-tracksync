import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStandardTransactionPayload,
  resolveScanTimestamp,
} from '../lib/transactionDualScan.js';
import { buildActivationDataRow } from '../lib/qrActivationDualScan.js';
import { createTransaction } from '../lib/transactionsService.js';
import { createActivation } from '../lib/qrActivationService.js';

/* ============================== fixtures ============================= */

const USER = { username: 'nimal', department: 'Finishing 01' };

// A manual override the UI produces from a datetime-local picker
// (converted to an ISO-8601 UTC instant before calling the service).
const MANUAL_ISO = '2026-09-01T06:30:00.000Z';

/** True when the value is a parseable ISO-8601 timestamp. */
function isParseableIso(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** Mock supabase-js client capturing the full query chain per table. */
function createMockSupabase(tables = {}) {
  const queries = [];
  const makeBuilder = (tableName) => {
    const record = {
      table: tableName,
      select: null,
      filters: [],
      orders: [],
      limit: null,
      insert: null,
      update: null,
    };
    queries.push(record);
    const chain = {
      select(columns) {
        record.select = columns;
        return chain;
      },
      insert(rows) {
        record.insert = rows;
        return chain;
      },
      update(values) {
        record.update = values;
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
      order(column, opts) {
        record.orders.push([column, opts]);
        return chain;
      },
      limit(n) {
        record.limit = n;
        return chain;
      },
      then(onFulfilled, onRejected) {
        const config = tables[tableName];
        const payload =
          typeof config === 'function'
            ? config(record)
            : config ?? { data: [], error: null };
        return Promise.resolve(payload).then(onFulfilled, onRejected);
      },
    };
    return chain;
  };
  return { client: { from: makeBuilder }, queries };
}

/* ---------------- resolveScanTimestamp (shared resolution) ------------- */

test('resolveScanTimestamp: a valid manual value is stored verbatim as an ISO instant', () => {
  assert.equal(resolveScanTimestamp(MANUAL_ISO), MANUAL_ISO);
  // A Date instance is normalized to its ISO instant.
  assert.equal(resolveScanTimestamp(new Date('2026-09-01T06:30:00.000Z')), MANUAL_ISO);
  // A local datetime-local string (no Z) is normalized through Date.
  const local = '2026-09-01T12:00'; // local wall time - parses, never NaN
  assert.ok(isParseableIso(resolveScanTimestamp(local)));
  assert.equal(resolveScanTimestamp(local).endsWith('Z'), true);
});

test('resolveScanTimestamp: missing / blank / invalid values fall back to the current system time', () => {
  const before = new Date().getTime();
  for (const bad of [null, undefined, '', '   ', 'not-a-date', '2026-13-99T99:99']) {
    const resolved = resolveScanTimestamp(bad);
    assert.ok(
      isParseableIso(resolved),
      `expected a parseable fallback timestamp for ${JSON.stringify(bad)}`
    );
    // Falls back to "now", not an ancient manual value.
    assert.ok(Date.parse(resolved) >= before - 1000);
  }
});

/* ------------------- standard transaction payload ------------------- */

test('payload: a manual createdAt is written to the standard transaction created_at', () => {
  const payload = buildStandardTransactionPayload({
    user: USER,
    orgQr: 'ORG-001',
    recordStatus: 'IN',
    qcStatus: 'Forward',
    innerQr: 'INNER-BOX-001',
    createdAt: MANUAL_ISO,
  });
  assert.equal(payload.created_at, MANUAL_ISO);
});

test('payload: no createdAt falls back to a valid current timestamp', () => {
  const before = Date.now();
  const payload = buildStandardTransactionPayload({
    user: USER,
    orgQr: 'ORG-001',
    recordStatus: 'IN',
    qcStatus: 'Forward',
  });
  assert.ok(isParseableIso(payload.created_at));
  assert.ok(Date.parse(payload.created_at) >= before - 1000);
});

/* --------------------- QR activation data payload ---------------------- */

test('activation payload: a manual created_at is written to the activation created_at', () => {
  const dataRow = buildActivationDataRow({
    user: USER,
    qrCode: ';566998;148925;35;RAW-SHOE-1;',
    recordStatus: 'IN',
    qcStatus: 'Forward',
    createdAt: MANUAL_ISO,
  });
  assert.equal(dataRow.created_at, MANUAL_ISO);
});
/* ---------------------- createTransaction (service) ---------------------- */

test('createTransaction: a manual date & time is included in the data_updates insert', async () => {
  const { client, queries } = createMockSupabase({
    data_updates: { data: [{ id: 7 }], error: null },
  });
  const result = await createTransaction(
    USER,
    'ORG-001',
    'IN',
    'Forward',
    null,
    MANUAL_ISO,
    client
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 'synced');
  const insert = queries.find((q) => q.table === 'data_updates' && q.insert);
  assert.ok(insert);
  assert.equal(insert.insert[0].created_at, MANUAL_ISO);
  assert.equal(result.row.created_at, MANUAL_ISO);
});

test('createTransaction: no manual date & time falls back to the current system timestamp', async () => {
  const { client, queries } = createMockSupabase({
    data_updates: { data: [{ id: 7 }], error: null },
  });
  const before = Date.now();
  const result = await createTransaction(USER, 'ORG-001', 'IN', 'Forward', null, null, client);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'synced');
  const insert = queries.find((q) => q.table === 'data_updates' && q.insert);
  assert.ok(insert);
  assert.ok(isParseableIso(insert.insert[0].created_at));
  assert.ok(Date.parse(insert.insert[0].created_at) >= before - 1000);
});

/* ---------------------- createActivation (service) ---------------------- */

test('createActivation: a manual date & time is included in the data_updates insert', async () => {
  const { client, queries } = createMockSupabase({
    // msk: gate status lookup -> Packed, duplicate-guard select -> no row,
    // activation-marking insert -> ok.
    msk: (q) =>
      q.select === 'status'
        ? { data: [{ status: 'Packed' }], error: null }
        : q.select === 'id'
          ? { data: [], error: null }
          : { data: [{ id: 1 }], error: null },
    pod: { data: [{ mqc: '566998' }], error: null },
    data_updates: { data: [{ id: 8 }], error: null },
  });
  const result = await createActivation(
    USER,
    'RAW-SHOE-1',
    '148925',
    35,
    'IN',
    'Forward',
    null,
    MANUAL_ISO,
    client
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 'synced');
  const duInsert = queries.find((q) => q.table === 'data_updates' && q.insert);
  assert.ok(duInsert);
  assert.equal(duInsert.insert[0].created_at, MANUAL_ISO);
  assert.equal(result.row.created_at, MANUAL_ISO);
});

test('createActivation: no manual date & time falls back to the current system timestamp', async () => {
  const { client, queries } = createMockSupabase({
    msk: (q) =>
      q.select === 'status'
        ? { data: [{ status: 'Packed' }], error: null }
        : q.select === 'id'
          ? { data: [], error: null }
          : { data: [{ id: 1 }], error: null },
    pod: { data: [{ mqc: '566998' }], error: null },
    data_updates: { data: [{ id: 8 }], error: null },
  });
  const before = Date.now();
  const result = await createActivation(
    USER,
    'RAW-SHOE-1',
    '148925',
    35,
    'IN',
    'Forward',
    null,
    null,
    client
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 'synced');
  const duInsert = queries.find((q) => q.table === 'data_updates' && q.insert);
  assert.ok(duInsert);
  assert.ok(
    isParseableIso(duInsert.insert[0].created_at),
    'must still contain a valid timestamp when no override is given'
  );
  assert.ok(Date.parse(duInsert.insert[0].created_at) >= before - 1000);
});