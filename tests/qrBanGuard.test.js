import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BANNED_STATUS,
  isBannedStatus,
  isActiveStatus,
  normalizeMskStatus,
  pickBannedMskRow,
  BLOCK_QR_BANNED_TRANSACTION,
  BLOCK_QR_BANNED_ACTIVATION,
  BLOCK_BAN_STATUS_UNREACHABLE,
} from '../lib/qrBanGuard.js';
import { searchMskQr, banMskQr, describeMskOrgQr } from '../lib/qrBanService.js';
import { createSupabaseGuardDb, validateStandardScan } from '../lib/transactionGuards.js';
import { checkActivationMskStatus, createActivation } from '../lib/qrActivationService.js';
import { BLOCK_NOT_PACKED } from '../lib/qrActivationDualScan.js';

/* ----------------------------- fixtures ----------------------------- */

const USER = { username: 'nimal', department: 'Lasting 01' };

// Activation-formatted org_qr (PO 148925, size 35, MQC 566998).
const ACTIVATION_ORG_QR = ';566998;148925;35;RAW-SHOE-1;';

/**
 * Minimal thenable mock of the supabase-js PostgREST query builder
 * (same contract as the other test suites): every await resolves with
 * the configured payload per table - a static object or a (query) =>
 * payload function - while recording the full chain.
 */
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
        const config = tables[tableName] ?? { data: [], error: null };
        const payload = typeof config === 'function' ? config(record) : config;
        return Promise.resolve(payload).then(onFulfilled, onRejected);
      },
    };
    return chain;
  };
  return { client: { from: makeBuilder }, queries };
}

/** In-memory fake of the guard db adapter for the ban-guard rules. */
function createFakeDb({
  mskRows = {},
  mskStatusesByOrgQr = {},
  departments = [],
  failMsk = false,
} = {}) {
  const calls = {
    mskLookups: [],
    mskOrgQrStatusLookups: [],
    departmentFetches: 0,
    netCountQueries: [],
  };
  return {
    calls,
    async listMskRowsByMskQr(mskQr) {
      calls.mskLookups.push(mskQr);
      if (failMsk) throw new Error('fetch failed');
      return mskRows[mskQr] || [];
    },
    async listMskStatusesByOrgQr(orgQr) {
      calls.mskOrgQrStatusLookups.push(orgQr);
      if (failMsk) throw new Error('fetch failed');
      return mskStatusesByOrgQr[orgQr] || [];
    },
    async listDepartments() {
      calls.departmentFetches += 1;
      return departments;
    },
    async getNetCount(qrCode, departmentNames) {
      calls.netCountQueries.push({ qrCode, departmentNames });
      return 0;
    },
    async getCutQtyForPoSize() {
      return Number.MAX_SAFE_INTEGER;
    },
    async getDeptPoSizeSum() {
      return 0;
    },
  };
}

/* -------------------- 1. pure status comparison --------------------- */

test('ban status helpers: case-insensitive trim comparisons', () => {
  for (const value of ['ban', 'BAN', 'Ban', '  ban  ']) {
    assert.equal(isBannedStatus(value), true, value);
  }
  for (const value of ['Active', 'Packed', 'PICKED', '', '   ', null, undefined]) {
    assert.equal(isBannedStatus(value), false, String(value));
  }
  for (const value of ['active', 'ACTIVE', '  Active ']) {
    assert.equal(isActiveStatus(value), true, value);
  }
  for (const value of ['ban', 'Packed', '', null, undefined]) {
    assert.equal(isActiveStatus(value), false, String(value));
  }
  assert.equal(normalizeMskStatus('  Packed  '), 'packed');
  assert.equal(BANNED_STATUS, 'ban');
});

test('pickBannedMskRow: picks the first banned row, ignores every other status', () => {
  const banned = pickBannedMskRow([
    { msk_qr: 'A', org_qr: 'ORG-A', status: 'Active' },
    { msk_qr: 'B', org_qr: 'ORG-B', status: 'ban' },
    { msk_qr: 'C', org_qr: 'ORG-C', status: 'BAN' },
  ]);
  assert.deepEqual(banned, { msk_qr: 'B', org_qr: 'ORG-B', status: 'ban' });
  assert.equal(pickBannedMskRow([{ msk_qr: 'A', org_qr: 'ORG-A', status: 'Packed' }]), null);
  assert.equal(pickBannedMskRow([{ msk_qr: 'A', status: null }]), null);
  assert.equal(pickBannedMskRow([]), null);
  assert.equal(pickBannedMskRow(null), null);
  assert.equal(pickBannedMskRow(undefined), null);
});

/* -------------------- 2. org_qr detail parsing ---------------------- */

test('describeMskOrgQr: parses the activation org_qr into style/PO/size details', () => {
  assert.deepEqual(describeMskOrgQr(ACTIVATION_ORG_QR), {
    mqc: '566998',
    po: '148925',
    size: '35',
    scanned: 'RAW-SHOE-1',
  });
  // Legacy plain value: no semicolon structure -> PO = the whole value.
  assert.deepEqual(describeMskOrgQr('LEGACY-001'), {
    mqc: null,
    po: 'LEGACY-001',
    size: null,
    scanned: null,
  });
  assert.deepEqual(describeMskOrgQr(null), {
    mqc: null,
    po: null,
    size: null,
    scanned: null,
  });
});

/* --------------------- 3. searchMskQr (service) --------------------- */

test('searchMskQr: queries msk by msk_qr (latest row) and returns row + details', async () => {
  const { client, queries } = createMockSupabase({
    msk: {
      data: [{ id: 7, msk_qr: 'MSK-1', org_qr: ACTIVATION_ORG_QR, status: 'Active' }],
      error: null,
    },
  });
  const result = await searchMskQr(' MSK-1 ', client);
  assert.equal(result.found, true);
  assert.equal(result.offline, false);
  assert.deepEqual(result.row, {
    id: 7,
    msk_qr: 'MSK-1',
    org_qr: ACTIVATION_ORG_QR,
    status: 'Active',
  });
  assert.deepEqual(result.details, {
    mqc: '566998',
    po: '148925',
    size: '35',
    scanned: 'RAW-SHOE-1',
  });
  assert.equal(queries.length, 1);
  assert.equal(queries[0].table, 'msk');
  assert.equal(queries[0].select, 'id, msk_qr, org_qr, status');
  assert.deepEqual(queries[0].filters, [['eq', 'msk_qr', 'MSK-1']]);
  assert.deepEqual(queries[0].orders, [['id', { ascending: false }]]);
  assert.equal(queries[0].limit, 1);
});

test('searchMskQr: not found / offline / blank input', async () => {
  const missing = createMockSupabase({ msk: { data: [], error: null } });
  const notFound = await searchMskQr('UNKNOWN-QR', missing.client);
  assert.deepEqual(notFound, { found: false, offline: false, row: null, details: null });

  const offline = createMockSupabase({
    msk: { data: null, error: { message: 'fetch failed' } },
  });
  const failed = await searchMskQr('MSK-1', offline.client);
  assert.deepEqual(failed, { found: false, offline: true, row: null, details: null });

  const blank = createMockSupabase();
  const empty = await searchMskQr('   ', blank.client);
  assert.deepEqual(empty, { found: false, offline: false, row: null, details: null });
  assert.equal(blank.queries.length, 0); // blank never touches the database
});

/* --------------------- 4. banMskQr (service) ------------------------ */

test('banMskQr: VERIFIED update writes status ban and reports the row count', async () => {
  const { client, queries } = createMockSupabase({
    msk: { data: [{ id: 1 }, { id: 2 }], error: null },
  });
  const result = await banMskQr(' MSK-1 ', client);
  assert.deepEqual(result, { ok: true, rows: 2 });
  const updateQuery = queries.find((q) => q.update);
  assert.equal(updateQuery.table, 'msk');
  assert.deepEqual(updateQuery.update, { status: 'ban' });
  assert.equal(updateQuery.select, 'id');
  assert.deepEqual(updateQuery.filters, [['eq', 'msk_qr', 'MSK-1']]);
});

test('banMskQr: a silent no-op (RLS) and a database error are explicit failures', async () => {
  const noRows = createMockSupabase({ msk: { data: [], error: null } });
  const noOp = await banMskQr('MSK-1', noRows.client);
  assert.equal(noOp.ok, false);
  assert.match(noOp.error, /No msk record was updated/);

  const broken = createMockSupabase({
    msk: { data: null, error: { message: 'permission denied' } },
  });
  const failed = await banMskQr('MSK-1', broken.client);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Could not ban the QR code/);

  const blank = createMockSupabase();
  const empty = await banMskQr('   ', blank.client);
  assert.equal(empty.ok, false);
  assert.equal(blank.queries.length, 0);
});

/* --------------- 5. Supabase guard adapter: ban lookup -------------- */

test('adapter listMskStatusesByOrgQr: queries msk.status by org_qr and rethrows errors', async () => {
  const ok = createMockSupabase({
    msk: { data: [{ status: 'Active' }], error: null },
  });
  const db = createSupabaseGuardDb(ok.client);
  const rows = await db.listMskStatusesByOrgQr('ORG-1');
  assert.deepEqual(rows, [{ status: 'Active' }]);
  assert.equal(ok.queries[0].table, 'msk');
  assert.equal(ok.queries[0].select, 'status');
  assert.deepEqual(ok.queries[0].filters, [['eq', 'org_qr', 'ORG-1']]);

  const broken = createMockSupabase({
    msk: { data: null, error: new Error('relation "msk" does not exist') },
  });
  const failingDb = createSupabaseGuardDb(broken.client);
  await assert.rejects(() => failingDb.listMskStatusesByOrgQr('ORG-1'), /does not exist/);
});

/* ------------- 6. Ban Guard in validateStandardScan (standard) ------ */

test('Ban Guard (scanned mode): a banned msk_qr blocks with the exact message first', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-1': [{ msk_qr: 'MSK-1', org_qr: 'ORG-1', status: 'ban' }] },
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-1', user: USER, db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_QR_BANNED_TRANSACTION);
  // Blocked at the ban gate - no department or net-count query ran.
  assert.equal(db.calls.departmentFetches, 0);
  assert.deepEqual(db.calls.netCountQueries, []);
});

test('Ban Guard (scanned mode): a banned row wins over an Active row', async () => {
  const db = createFakeDb({
    mskRows: {
      'MSK-1': [
        { msk_qr: 'MSK-1', org_qr: 'ORG-ACTIVE', status: 'Active' },
        { msk_qr: 'MSK-1', org_qr: 'ORG-BANNED', status: 'ban' },
      ],
    },
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-1', user: USER, db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_QR_BANNED_TRANSACTION);
});

test('Ban Guard (Packing lookup mode): a banned org_qr blocks the pre-resolved scan', async () => {
  const db = createFakeDb({
    mskStatusesByOrgQr: { 'ORG-1': [{ status: 'ban' }] },
  });
  const result = await validateStandardScan({
    scannedQr: null,
    user: { username: 'p-user', department: 'Packing' },
    db,
    orgQr: 'ORG-1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_QR_BANNED_TRANSACTION);
  assert.deepEqual(db.calls.mskOrgQrStatusLookups, ['ORG-1']);
  assert.deepEqual(db.calls.netCountQueries, []);
});

test('Ban Guard (Packing lookup mode): unreachable msk blocks fail-safe', async () => {
  const db = createFakeDb({ failMsk: true });
  const result = await validateStandardScan({
    scannedQr: null,
    user: { username: 'p-user', department: 'Packing' },
    db,
    orgQr: 'ORG-1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_BAN_STATUS_UNREACHABLE);
});

/* ------------- 7. Ban Gate in the QR Activation flow ---------------- */

test('checkActivationMskStatus: a banned QR gets the dedicated activation message', async () => {
  const { client } = createMockSupabase({
    msk: { data: [{ status: 'ban' }], error: null },
  });
  const failure = await checkActivationMskStatus('RAW-SHOE-1', client);
  assert.deepEqual(failure, {
    reason: BLOCK_QR_BANNED_ACTIVATION,
    status: 'ban',
  });
});

test('checkActivationMskStatus: Packed still passes, Active still gets the not-packed gate', async () => {
  const packed = createMockSupabase({
    msk: { data: [{ status: 'Packed' }], error: null },
  });
  assert.equal(await checkActivationMskStatus('RAW-SHOE-1', packed.client), null);

  const active = createMockSupabase({
    msk: { data: [{ status: 'Active' }], error: null },
  });
  const failure = await checkActivationMskStatus('RAW-SHOE-1', active.client);
  assert.equal(failure.reason, BLOCK_NOT_PACKED.replace('{status}', 'Active'));

  // Case-insensitive: 'BAN' is a ban too.
  const upper = createMockSupabase({
    msk: { data: [{ status: 'BAN' }], error: null },
  });
  const upperFailure = await checkActivationMskStatus('RAW-SHOE-1', upper.client);
  assert.equal(upperFailure.reason, BLOCK_QR_BANNED_ACTIVATION);
});

test('createActivation: a banned QR is blocked and NOTHING is written', async () => {
  const { client, queries } = createMockSupabase({
    msk: (q) =>
      q.select === 'status'
        ? { data: [{ status: 'ban' }], error: null }
        : { data: [], error: null },
  });
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
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, BLOCK_QR_BANNED_ACTIVATION);
  assert.equal(result.row, null);
  // NOTHING was written: no msk insert, no data_updates insert.
  assert.equal(queries.find((q) => q.insert), undefined);
  // Only the gate's status lookup ran - no MQC fetch, no duplicate check.
  assert.equal(queries.length, 1);
  assert.equal(queries[0].select, 'status');
});
