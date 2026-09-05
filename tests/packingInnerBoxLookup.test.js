import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveOrgQrFromInnerBox,
  createTransaction,
  syncMskStatusForPackingTransaction,
  updateMskStatusForOrgQr,
  isPackingDepartment,
  PACKING_UNLINKED_INNER_BOX_TITLE,
  PACKING_UNLINKED_INNER_BOX_MESSAGE,
} from '../lib/transactionsService.js';
import {
  validateStandardScan,
  BLOCK_CURRENT_SEQ,
  BLOCK_CURRENT_SEQ_NEGATIVE,
  BLOCK_PREVIOUS_SEQ,
  BLOCK_PARALLEL_SEQ,
  BLOCK_DOWNSTREAM_DEPT,
} from '../lib/transactionGuards.js';
import { buildStandardTransactionPayload } from '../lib/transactionDualScan.js';

/* ============================== fixtures ============================= */

// Department sequence with a Packing department at sequence 5 and a
// downstream Warehouse at sequence 6 (Rule 5 target).
const DEPARTMENTS = [
  { id: 1, department: 'Cutting', sequence: 1 },
  { id: 2, department: 'Stitching', sequence: 2 },
  { id: 3, department: 'Lasting', sequence: 3 },
  { id: 4, department: 'Finishing 01', sequence: 4 },
  { id: 5, department: 'Packing', sequence: 5 },
  { id: 6, department: 'Warehouse', sequence: 6 },
];

// A parallel Packing line on the SAME sequence (Rule 4 target).
const DEPARTMENTS_WITH_PARALLEL_PACKING = [
  ...DEPARTMENTS,
  { id: 7, department: 'Packing 02', sequence: 5 },
];

const PACKING_USER = { username: 'packer01', department: 'Packing' };

// The Shoe QR (org_qr) - the activation-formatted ';mqc;po;size;scanned;'
// string, exactly what data_updates.qr_code stores for an activated shoe.
const SHOE_ORG = ';566998;148925;35;RAW-SHOE-1;';

// The Inner Box QR the Packing user scans (any label shape - the
// Finishing V1-V3 pair checks do NOT apply in Packing single-scan mode).
const INNER_QR =
  'http://blaklader.com/010733050996397521028002291\u001d10148925\u001d8200http://blaklader.com';

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
        const payload = tables[tableName] ?? { data: [], error: null };
        return Promise.resolve(payload).then(onFulfilled, onRejected);
      },
    };
    return chain;
  };
  return { client: { from: makeBuilder }, queries };
}

/**
 * In-memory fake of the guard db adapter recording every query. The
 * srl_num lookup always returns null and the Duplicate Inner Box Guard
 * always reports the box as REGISTERED - in Packing single-scan mode
 * neither may run (the scanned box is registered by definition).
 */
function createFakeGuardDb({
  departments = DEPARTMENTS,
  counts = {},
  innerExists = true,
} = {}) {
  const calls = {
    mskLookups: [],
    departmentFetches: 0,
    netCountQueries: [],
    srlLookups: [],
    innerExistsChecks: [],
  };
  return {
    calls,
    async listMskRowsByMskQr(mskQr) {
      calls.mskLookups.push(mskQr);
      return [];
    },
    async listDepartments() {
      calls.departmentFetches += 1;
      return departments;
    },
    async getNetCount(qrCode, departmentNames) {
      calls.netCountQueries.push({ qrCode, departmentNames });
      return departmentNames.reduce(
        (sum, name) => sum + (counts[`${qrCode}|${name}`] || 0),
        0
      );
    },
    async getSrlSize(boxCode) {
      calls.srlLookups.push(boxCode);
      return null;
    },
    async innerQrExistsInDataUpdates(innerQr) {
      calls.innerExistsChecks.push(innerQr);
      return innerExists;
    },
    // Rule 6 (Cut Quantity) adapter stubs: these tests exercise the
    // sequence / net-count / dual-scan guards, NOT the cut_qty limit, so
    // return a generous limit and a zero sum to keep Rule 6 passing.
    async getCutQtyForPoSize() {
      return Number.MAX_SAFE_INTEGER;
    },
    async getDeptPoSizeSum() {
      return 0;
    },
  };
}

/* ============ resolveOrgQrFromInnerBox (service layer) =============== */

test('lookup: resolves the Shoe QR (org_qr) of a linked Inner Box QR from data_updates', async () => {
  const { client, queries } = createMockSupabase({
    data_updates: { data: [{ qr_code: SHOE_ORG }], error: null },
  });
  const result = await resolveOrgQrFromInnerBox(INNER_QR, client);
  assert.deepEqual(result, { found: true, orgQr: SHOE_ORG, offline: false });
  // Exactly one query: SELECT qr_code FROM data_updates
  //   WHERE inner_qr = <scanned> ORDER BY created_at DESC LIMIT 1.
  assert.equal(queries.length, 1);
  const q = queries[0];
  assert.equal(q.table, 'data_updates');
  assert.equal(q.select, 'qr_code');
  assert.deepEqual(q.filters, [['eq', 'inner_qr', INNER_QR]]);
  assert.deepEqual(q.orders, [['created_at', { ascending: false }]]);
  assert.equal(q.limit, 1);
});

test('lookup: uses the LATEST association when a box was re-paired over time', async () => {
  const { client } = createMockSupabase({
    data_updates: {
      // Rows arrive ordered by created_at DESC (latest first), exactly
      // what ORDER BY created_at DESC returns.
      data: [{ qr_code: SHOE_ORG }, { qr_code: 'OLD-SHOE' }],
      error: null,
    },
  });
  const result = await resolveOrgQrFromInnerBox(INNER_QR, client);
  assert.equal(result.found, true);
  assert.equal(result.orgQr, SHOE_ORG);
});

test('lookup: rejects an UNLINKED Inner Box QR (no matching org_qr)', async () => {
  const { client, queries } = createMockSupabase({
    data_updates: { data: [], error: null },
  });
  const result = await resolveOrgQrFromInnerBox(INNER_QR, client);
  // found:false + offline:false -> the view shows the exact
  // "Unlinked Inner Box" rejection (not an offline message).
  assert.deepEqual(result, { found: false, orgQr: null, offline: false });
  assert.equal(queries.length, 1);
});

test('lookup: blocks FAIL-SAFE when the data_updates table cannot be reached', async () => {
  const { client } = createMockSupabase({
    data_updates: { data: null, error: { message: 'fetch failed' } },
  });
  const result = await resolveOrgQrFromInnerBox(INNER_QR, client);
  assert.equal(result.found, false);
  assert.equal(result.orgQr, null);
  assert.equal(result.offline, true);
});

test('lookup: a blank scan is rejected without touching the database', async () => {
  const { client, queries } = createMockSupabase();
  const result = await resolveOrgQrFromInnerBox('   ', client);
  assert.deepEqual(result, { found: false, orgQr: null, offline: false });
  assert.equal(queries.length, 0);
});

test('lookup: the exact "Unlinked Inner Box" rejection texts are stable', () => {
  assert.equal(PACKING_UNLINKED_INNER_BOX_TITLE, 'Unlinked Inner Box');
  assert.equal(
    PACKING_UNLINKED_INNER_BOX_MESSAGE,
    'This Inner Box QR has no recorded Shoe QR in the system.'
  );
});

/* ==== full Packing single-scan workflow (resolve -> guards -> write) == */

test('Packing transaction: a LINKED Inner Box QR resolves, guards pass on the resolved org_qr and the pair is stored', async () => {
  // 1) The user scans ONLY the Inner Box QR (no Shoe QR is scanned).
  const { client } = createMockSupabase({
    data_updates: { data: [{ qr_code: SHOE_ORG }], error: null },
  });
  const lookup = await resolveOrgQrFromInnerBox(INNER_QR, client);
  assert.equal(lookup.found, true);

  // 2) Validation runs against the RESOLVED org_qr with scannedQr =
  //    null (exactly how TransactionsView.autoSubmit calls it). The
  //    previous department (Finishing 01) nets +1 - Rule 2 satisfied.
  const db = createFakeGuardDb({
    counts: { [`${SHOE_ORG}|Finishing 01`]: 1 },
    innerExists: true, // the box IS registered - resolution found it!
  });
  const gate = await validateStandardScan({
    scannedQr: null,
    user: PACKING_USER,
    db,
    innerQr: INNER_QR,
    qcStatus: 'Forward',
    orgQr: lookup.orgQr,
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.orgQr, SHOE_ORG);

  // Rule 1 (msk gate) was SKIPPED - no msk lookup may happen.
  assert.equal(db.calls.mskLookups.length, 0);
  // The Finishing Dual-Scan checks (V1-V3 + Duplicate Inner Box Guard)
  // were SKIPPED: srl_num is never queried and the registered box does
  // NOT block the Packing scan.
  assert.equal(db.calls.srlLookups.length, 0);
  assert.equal(db.calls.innerExistsChecks.length, 0);

  // 3) The inserted data_updates record carries the resolved pair with
  //    the standard metadata set.
  const payload = buildStandardTransactionPayload({
    user: PACKING_USER,
    orgQr: gate.orgQr,
    recordStatus: 'IN',
    qcStatus: 'Forward',
    innerQr: INNER_QR,
  });
  assert.equal(payload.qr_code, SHOE_ORG); // resolved Shoe QR
  assert.equal(payload.inner_qr, INNER_QR); // scanned Inner Box QR
  assert.equal(payload.department, 'Packing');
  assert.equal(payload.record_status, 'IN');
  assert.equal(payload.qc_status, 'Forward');
  assert.equal(payload.count, 1);
  assert.equal(payload.created_by, 'packer01');
  assert.ok(!Number.isNaN(Date.parse(payload.created_at)));
});

test('Packing transaction: an UNLINKED Inner Box QR is rejected before any validation or write', async () => {
  const { client, queries } = createMockSupabase({
    data_updates: { data: [], error: null }, // no row with this inner_qr
  });
  const db = createFakeGuardDb();

  // The view flow: resolve first, and reject when not found.
  const lookup = await resolveOrgQrFromInnerBox(INNER_QR, client);
  assert.equal(lookup.found, false);

  // The exact rejection the worker sees:
  assert.equal(PACKING_UNLINKED_INNER_BOX_TITLE, 'Unlinked Inner Box');
  assert.equal(
    PACKING_UNLINKED_INNER_BOX_MESSAGE,
    'This Inner Box QR has no recorded Shoe QR in the system.'
  );

  // Nothing else ran: no guard queries, no validation, no write.
  assert.equal(db.calls.mskLookups.length, 0);
  assert.equal(db.calls.departmentFetches, 0);
  assert.equal(db.calls.netCountQueries.length, 0);
  assert.equal(queries.length, 1); // only the lookup itself touched the db
});

/* ==== Rules 2-5 enforced on the RESOLVED org_qr (Packing mode) ======= */

test('Net Count Guard (Rule 3): blocks a scan when the resolved org_qr already nets +1 in Packing', async () => {
  const db = createFakeGuardDb({
    counts: {
      [`${SHOE_ORG}|Finishing 01`]: 1, // Rule 2 satisfied
      [`${SHOE_ORG}|Packing`]: 1, // already scanned IN here
    },
  });
  const gate = await validateStandardScan({
    scannedQr: null,
    user: PACKING_USER,
    db,
    innerQr: INNER_QR,
    qcStatus: 'Forward',
    orgQr: SHOE_ORG,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, BLOCK_CURRENT_SEQ);
});

test('Net Count Guard (Rule 3): a Return on a 0 net is blocked (nothing to clear)', async () => {
  const db = createFakeGuardDb({
    counts: {
      [`${SHOE_ORG}|Finishing 01`]: 1,
      [`${SHOE_ORG}|Packing`]: 0,
    },
  });
  const gate = await validateStandardScan({
    scannedQr: null,
    user: PACKING_USER,
    db,
    innerQr: INNER_QR,
    qcStatus: 'Return',
    orgQr: SHOE_ORG,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, BLOCK_CURRENT_SEQ_NEGATIVE);
});

test('Net Count Guard (Rule 3): a Return on a +1 net is allowed and records count = -1', async () => {
  const db = createFakeGuardDb({
    counts: {
      [`${SHOE_ORG}|Finishing 01`]: 1,
      [`${SHOE_ORG}|Packing`]: 1, // Return clears it to 0
    },
  });
  const gate = await validateStandardScan({
    scannedQr: null,
    user: PACKING_USER,
    db,
    innerQr: INNER_QR,
    qcStatus: 'Return',
    orgQr: SHOE_ORG,
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.orgQr, SHOE_ORG);

  const payload = buildStandardTransactionPayload({
    user: PACKING_USER,
    orgQr: gate.orgQr,
    recordStatus: 'IN',
    qcStatus: 'Return',
    innerQr: INNER_QR,
  });
  assert.equal(payload.count, -1);
  assert.equal(payload.qc_status, 'Return');
  assert.equal(payload.inner_qr, INNER_QR);
});

test('Downstream Sequence Guard (Rule 5): blocks when the next department (Warehouse) holds a count', async () => {
  const db = createFakeGuardDb({
    counts: {
      [`${SHOE_ORG}|Finishing 01`]: 1, // Rule 2 satisfied
      [`${SHOE_ORG}|Warehouse`]: 1, // processed downstream
    },
  });
  const gate = await validateStandardScan({
    scannedQr: null,
    user: PACKING_USER,
    db,
    innerQr: INNER_QR,
    qcStatus: 'Forward',
    orgQr: SHOE_ORG,
  });
  assert.equal(gate.ok, false);
  assert.equal(
    gate.reason,
    BLOCK_DOWNSTREAM_DEPT.replace('{Next Department Name}', 'Warehouse')
  );
});

test('Preceding Sequence Guard (Rule 2): blocks when the previous department net is not +1', async () => {
  const db = createFakeGuardDb({
    counts: { [`${SHOE_ORG}|Finishing 01`]: 0 }, // never scanned IN upstream
  });
  const gate = await validateStandardScan({
    scannedQr: null,
    user: PACKING_USER,
    db,
    innerQr: INNER_QR,
    qcStatus: 'Forward',
    orgQr: SHOE_ORG,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, BLOCK_PREVIOUS_SEQ);
});

test('Parallel Sequence Guard (Rule 4): blocks when a same-sequence parallel Packing line holds a count', async () => {
  const db = createFakeGuardDb({
    departments: DEPARTMENTS_WITH_PARALLEL_PACKING,
    counts: {
      [`${SHOE_ORG}|Finishing 01`]: 1, // Rule 2 satisfied
      [`${SHOE_ORG}|Packing 02`]: 1, // parallel line active
    },
  });
  const gate = await validateStandardScan({
    scannedQr: null,
    user: PACKING_USER,
    db,
    innerQr: INNER_QR,
    qcStatus: 'Forward',
    orgQr: SHOE_ORG,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, BLOCK_PARALLEL_SEQ);
});

test('Packing mode skips Rule 1 even when the msk table has no mapping at all', async () => {
  // No msk rows exist for anything - yet a Packing scan with a
  // pre-resolved org_qr must still pass when the guards are satisfied.
  const db = createFakeGuardDb({
    counts: { [`${SHOE_ORG}|Finishing 01`]: 1 },
  });
  const gate = await validateStandardScan({
    scannedQr: null,
    user: PACKING_USER,
    db,
    innerQr: INNER_QR,
    qcStatus: 'Forward',
    orgQr: SHOE_ORG,
  });
  assert.equal(gate.ok, true);
  assert.equal(db.calls.mskLookups.length, 0);
});

/* ========= Packing msk lifecycle trigger (msk.status sync) =========== */

test('isPackingDepartment: exact-name gate mirrors the view single-scan gate', () => {
  assert.equal(isPackingDepartment('Packing'), true);
  assert.equal(isPackingDepartment('Packing 02'), false);
  assert.equal(isPackingDepartment('packing'), false);
  assert.equal(isPackingDepartment(undefined), false);
});

test('msk helper: updateMskStatusForOrgQr writes the status on the msk row addressed by org_qr', async () => {
  const { client, queries } = createMockSupabase({
    msk: { data: [{ id: 1 }], error: null },
  });
  const result = await updateMskStatusForOrgQr(SHOE_ORG, 'Packed', client);
  assert.deepEqual(result, { updated: true, rows: 1 });
  assert.equal(queries.length, 1);
  const q = queries[0];
  assert.equal(q.table, 'msk');
  assert.deepEqual(q.update, { status: 'Packed' });
  assert.deepEqual(q.filters, [['eq', 'org_qr', SHOE_ORG]]);
  assert.equal(q.select, 'id');
});

test('msk helper: a blank org_qr is a no-op (no query issued)', async () => {
  const { client, queries } = createMockSupabase();
  const result = await updateMskStatusForOrgQr('   ', 'Packed', client);
  assert.deepEqual(result, { updated: false, rows: 0, reason: 'missing-org-qr' });
  assert.equal(queries.length, 0);
});

test('msk trigger: NON-Packing departments never touch msk.status (zero queries)', async () => {
  const { client, queries } = createMockSupabase();
  const result = await syncMskStatusForPackingTransaction(
    { username: 'nimal', department: 'Finishing 01' },
    SHOE_ORG,
    client
  );
  assert.deepEqual(result, { triggered: false, reason: 'not-packing' });
  // No net-count select and no msk update may happen.
  assert.equal(queries.length, 0);
});

test('msk trigger: Packing net +1 marks msk.status = Packed', async () => {
  const { client, queries } = createMockSupabase({
    data_updates: { data: [{ count: 1 }], error: null },
    msk: { data: [{ id: 1 }], error: null },
  });
  const result = await syncMskStatusForPackingTransaction(PACKING_USER, SHOE_ORG, client);
  assert.deepEqual(result, {
    triggered: true,
    net: 1,
    status: 'Packed',
    updated: true,
    rows: 1,
  });
  // The net was computed from data_updates for the org_qr in Packing.
  const netQuery = queries.find((q) => q.table === 'data_updates' && !q.insert && !q.update);
  assert.ok(netQuery);
  assert.equal(netQuery.select, 'count');
  assert.deepEqual(netQuery.filters, [
    ['eq', 'qr_code', SHOE_ORG],
    ['in', 'department', ['Packing']],
  ]);
  // The msk row was addressed by org_qr and set to 'Packed'.
  const mskUpdate = queries.find((q) => q.table === 'msk');
  assert.ok(mskUpdate);
  assert.deepEqual(mskUpdate.update, { status: 'Packed' });
  assert.deepEqual(mskUpdate.filters, [['eq', 'org_qr', SHOE_ORG]]);
});

test('msk trigger: Packing net 0 reverts msk.status = Active (Return/Undo)', async () => {
  const { client, queries } = createMockSupabase({
    data_updates: { data: [{ count: 1 }, { count: -1 }], error: null },
    msk: { data: [{ id: 1 }], error: null },
  });
  const result = await syncMskStatusForPackingTransaction(PACKING_USER, SHOE_ORG, client);
  assert.deepEqual(result, {
    triggered: true,
    net: 0,
    status: 'Active',
    updated: true,
    rows: 1,
  });
  const mskUpdate = queries.find((q) => q.table === 'msk');
  assert.deepEqual(mskUpdate.update, { status: 'Active' });
  assert.deepEqual(mskUpdate.filters, [['eq', 'org_qr', SHOE_ORG]]);
});

test('msk trigger: an unexpected net count leaves msk untouched (defensive)', async () => {
  const { client, queries } = createMockSupabase({
    data_updates: { data: [{ count: 3 }], error: null },
  });
  const result = await syncMskStatusForPackingTransaction(PACKING_USER, SHOE_ORG, client);
  assert.deepEqual(result, { triggered: false, reason: 'unexpected-net-count', net: 3 });
  assert.equal(queries.find((q) => q.table === 'msk'), undefined);
});

test('msk trigger: unreachable data_updates leaves msk untouched (fail-safe)', async () => {
  const { client, queries } = createMockSupabase({
    data_updates: { data: null, error: { message: 'fetch failed' } },
  });
  const result = await syncMskStatusForPackingTransaction(PACKING_USER, SHOE_ORG, client);
  assert.equal(result.triggered, false);
  assert.equal(result.reason, 'net-count-unavailable');
  assert.equal(queries.find((q) => q.table === 'msk'), undefined);
});

test('msk trigger: an msk update failure is reported non-fatally (never throws)', async () => {
  const { client, queries } = createMockSupabase({
    data_updates: { data: [{ count: 1 }], error: null },
    msk: { data: null, error: { message: 'fetch failed' } },
  });
  const result = await syncMskStatusForPackingTransaction(PACKING_USER, SHOE_ORG, client);
  assert.equal(result.triggered, true);
  assert.equal(result.net, 1);
  assert.equal(result.status, 'Packed');
  assert.equal(result.updated, false);
  assert.match(result.error, /fetch failed/);
});

/* ==== createTransaction wiring (trigger runs right after the save) === */

test('Packing scan recorded (net +1): createTransaction marks msk.status = Packed', async () => {
  const { client, queries } = createMockSupabase({
    // Net count AFTER the just-saved Packing IN record: +1.
    data_updates: { data: [{ count: 1 }], error: null },
    msk: { data: [{ id: 1 }], error: null },
  });
  const result = await createTransaction(
    PACKING_USER,
    SHOE_ORG,
    'IN',
    'Forward',
    INNER_QR,
    client
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 'synced');
  // The transaction itself is the standard record (resolved Shoe QR +
  // scanned Inner Box QR + Packing department + count +1).
  const insert = queries.find((q) => q.table === 'data_updates' && q.insert);
  assert.ok(insert);
  assert.equal(insert.insert.length, 1);
  assert.equal(insert.insert[0].qr_code, SHOE_ORG);
  assert.equal(insert.insert[0].inner_qr, INNER_QR);
  assert.equal(insert.insert[0].department, 'Packing');
  assert.equal(insert.insert[0].count, 1);
  assert.equal(insert.insert[0].qc_status, 'Forward');
  // The automatic trigger marked the shoe Packed.
  assert.deepEqual(result.mskStatus, {
    triggered: true,
    net: 1,
    status: 'Packed',
    updated: true,
    rows: 1,
  });
  const mskUpdate = queries.find((q) => q.table === 'msk');
  assert.ok(mskUpdate);
  assert.deepEqual(mskUpdate.update, { status: 'Packed' });
  assert.deepEqual(mskUpdate.filters, [['eq', 'org_qr', SHOE_ORG]]);
});

test('Packing Return recorded (net 0): createTransaction reverts msk.status = Active', async () => {
  const { client, queries } = createMockSupabase({
    // Rows AFTER the Return record: +1 and -1 -> net back to 0.
    data_updates: { data: [{ count: 1 }, { count: -1 }], error: null },
    msk: { data: [{ id: 1 }], error: null },
  });
  const result = await createTransaction(
    PACKING_USER,
    SHOE_ORG,
    'IN',
    'Return',
    null,
    client
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 'synced');
  assert.equal(result.row.count, -1); // Return records -1
  assert.deepEqual(result.mskStatus, {
    triggered: true,
    net: 0,
    status: 'Active',
    updated: true,
    rows: 1,
  });
  const mskUpdate = queries.find((q) => q.table === 'msk');
  assert.ok(mskUpdate);
  assert.deepEqual(mskUpdate.update, { status: 'Active' });
  assert.deepEqual(mskUpdate.filters, [['eq', 'org_qr', SHOE_ORG]]);
});

test('NON-Packing scan: createTransaction leaves msk.status unchanged', async () => {
  const { client, queries } = createMockSupabase({
    data_updates: { data: null, error: null },
  });
  const user = { username: 'nimal', department: 'Finishing 01' };
  const result = await createTransaction(user, SHOE_ORG, 'IN', 'Forward', null, client);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'synced');
  // The trigger was not even attempted: no mskStatus on the result.
  assert.equal(result.mskStatus, undefined);
  // Exactly ONE query happened (the data_updates insert) - no Packing
  // net-count select and no msk update.
  assert.equal(queries.length, 1);
  assert.equal(queries[0].table, 'data_updates');
  assert.ok(queries[0].insert);
  assert.equal(queries.find((q) => q.table === 'msk'), undefined);
});

test('Packing scan QUEUED offline: the msk trigger is deferred (record not in the DB yet)', async () => {
  const { client, queries } = createMockSupabase({
    data_updates: { data: null, error: { message: 'fetch failed - network down' } },
  });
  const result = await createTransaction(PACKING_USER, SHOE_ORG, 'IN', 'Forward', null, client);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'queued'); // saved on device, flushed later
  assert.equal(result.mskStatus, undefined);
  // Only the failed insert was attempted - the trigger fires when the
  // queue flushes (retryQueuedTransactions), never against a record
  // that is not in the DB yet.
  assert.equal(queries.length, 1);
  assert.equal(queries.find((q) => q.table === 'msk'), undefined);
});



