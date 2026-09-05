import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStandardScan,
  BLOCK_NO_ACTIVE_MSK,
  BLOCK_PREVIOUS_SEQ,
  BLOCK_CURRENT_SEQ,
  BLOCK_CURRENT_SEQ_NEGATIVE,
  BLOCK_PARALLEL_SEQ,
  BLOCK_DEPARTMENT_UNMAPPED,
  cutQtyExceededReason,
  noCutQtyReason,
  BLOCK_CUT_QTY_UNREACHABLE,
} from '../lib/transactionGuards.js';
import { normalizeSizeValue, parseOrgQr } from '../lib/transactionDualScan.js';

/* ----------------------------- fixtures ----------------------------- */

// Exact shape per the departments table: id, department (text),
// sequence (integer). Multiple departments share a sequence and the
// levels are sparse (1 -> 3, no 2) on purpose.
const DEPARTMENTS = [
  { id: 1, department: 'Upper Line 01', sequence: 1 },
  { id: 2, department: 'Upper Line 02', sequence: 1 },
  { id: 3, department: 'Upper Line 03', sequence: 1 },
  { id: 4, department: 'Upper Line 04', sequence: 1 },
  { id: 5, department: 'Lasting 01', sequence: 3 },
  { id: 6, department: 'Lasting 02', sequence: 3 },
];

const PREVIOUS_DEPTS = [
  'Upper Line 01',
  'Upper Line 02',
  'Upper Line 03',
  'Upper Line 04',
];

const USER = { username: 'nimal', department: 'Lasting 01' };
const USER_SEQ_1 = { username: 'kamal', department: 'Upper Line 02' };

// A department (seq 3) whose next department (seq 5 'Finishing 01') exists -
// used by the downstream-department sequence guard (Rule 5) tests.
const DEPARTMENTS_WITH_DOWNSTREAM = [
  ...DEPARTMENTS,
  { id: 7, department: 'Finishing 01', sequence: 5 },
  { id: 8, department: 'Finishing 02', sequence: 5 },
];
const USER_WITH_DOWNSTREAM = { username: 'nimal', department: 'Lasting 01' };

// Previous sequence level already nets exactly +1 (Rule 2 satisfied).
const PREV_OK = { 'ORG-001|Upper Line 04': 1 };

function mskRow(status = 'Active', orgQr = 'ORG-001') {
  return { id: 1, msk_qr: 'MSK-001', org_qr: orgQr, status };
}

/** In-memory fake of the guard db adapter, recording every query. */
function createFakeDb({
  mskRows = {},
  departments = DEPARTMENTS,
  counts = {},
  failMsk = false,
  podRows = [],
  dataUpdates = [],
  failPod = false,
  failDataUpdates = false,
} = {}) {
  const calls = {
    mskLookups: [],
    departmentFetches: 0,
    netCountQueries: [],
    cutQtyQueries: [],
    deptPoSizeQueries: [],
  };
  return {
    calls,
    async listMskRowsByMskQr(mskQr) {
      calls.mskLookups.push(mskQr);
      if (failMsk) throw new Error('fetch failed');
      return mskRows[mskQr] || [];
    },
    async listDepartments() {
      calls.departmentFetches += 1;
      return departments;
    },
    async getNetCount(qrCode, departmentNames) {
      calls.netCountQueries.push({ qrCode, departmentNames });
      return departmentNames.reduce((sum, name) => {
        const values = counts[`${qrCode}|${name}`];
        if (Array.isArray(values)) return sum + values.reduce((a, b) => a + b, 0);
        return sum + (values || 0);
      }, 0);
    },
    async getCutQtyForPoSize(po, size) {
      calls.cutQtyQueries.push({ po, size });
      if (failPod) throw new Error('pod fetch failed');
      const poValue = String(po ?? '').trim();
      if (!poValue) return null;
      const wanted = normalizeSizeValue(size);
      const row = (podRows || []).find(
        (r) => String(r?.po ?? '').trim() === poValue && r?.cut_qty != null && normalizeSizeValue(r?.size) === wanted
      );
      return row ? Number(row.cut_qty) : null;
    },
    async getDeptPoSizeSum(department, po, size) {
      calls.deptPoSizeQueries.push({ department, po, size });
      if (failDataUpdates) throw new Error('data_updates fetch failed');
      const dept = String(department ?? '').trim();
      if (!dept) return 0;
      const poValue = String(po ?? '').trim();
      const wantedSize = normalizeSizeValue(size);
      return (dataUpdates || []).reduce((sum, row) => {
        if (String(row?.department ?? '').trim() !== dept) return sum;
        const parsed = parseOrgQr(row?.qr_code);
        if (
          parsed.po != null &&
          String(parsed.po).trim() === poValue &&
          parsed.size != null &&
          normalizeSizeValue(parsed.size) === wantedSize
        ) {
          return sum + (Number.isFinite(Number(row?.count)) ? Number(row.count) : 0);
        }
        return sum;
      }, 0);
    },
  };
}

/* ================= Rule 1: Active-status MSK gate =================== */

test('Rule 1: blocks when the scanned QR has no msk row at all', async () => {
  const db = createFakeDb();
  const result = await validateStandardScan({ scannedQr: 'UNKNOWN', user: USER, db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_NO_ACTIVE_MSK);
});

test('Rule 1: blocks when only Packed / non-Active mappings exist', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow('Packed'), mskRow('Picked')] },
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_NO_ACTIVE_MSK);
  assert.equal(result.offline, false); // reachable, just not Active
});

test('Rule 1: ignores a Packed row and resolves the Active one (case-insensitive)', async () => {
  const db = createFakeDb({
    mskRows: {
      'MSK-001': [mskRow('Packed', 'OLD-QR'), mskRow('ACTIVE', 'ORG-001')],
    },
    counts: { ...PREV_OK }, // Rule 2 satisfied - this test is about Rule 1
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, true);
  assert.equal(result.orgQr, 'ORG-001');
});

test('Rule 1: blocks and flags offline when the msk table cannot be reached', async () => {
  const db = createFakeDb({ failMsk: true });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_NO_ACTIVE_MSK);
  assert.equal(result.offline, true);
});

test('Rule 1: runs FIRST - departments are never queried when it blocks', async () => {
  const db = createFakeDb(); // no msk rows
  await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(db.calls.departmentFetches, 0);
  assert.deepEqual(db.calls.netCountQueries, []);
});

/* ============== Rule 2: preceding department net count ============== */

test('Rule 2: blocks when the previous sequence net count is 0 (missing prior scan)', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { 'ORG-001|Upper Line 01': 0 },
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_PREVIOUS_SEQ);
});

test('Rule 2: blocks when the previous sequence nets 0 (IN +1 then Return -1)', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: {
      'ORG-001|Upper Line 01': 1,
      'ORG-001|Upper Line 02': -1,
    },
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_PREVIOUS_SEQ);
});

test('Rule 2: blocks when the previous sequence nets 2 (duplicate prior scan)', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: {
      'ORG-001|Upper Line 01': 1,
      'ORG-001|Upper Line 03': 1,
    },
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_PREVIOUS_SEQ);
});

test('Rule 2: passes when the previous sequence nets exactly +1 across departments', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: {
      'ORG-001|Upper Line 01': 2, // +2 on one line
      'ORG-001|Upper Line 02': -1, // -1 on another -> net +1
    },
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, true);
});

test('Rule 2: sums across ALL departments of previous_seq in one query', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { 'ORG-001|Upper Line 04': 1 },
  });
  await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  const rule2Query = db.calls.netCountQueries[0];
  assert.deepEqual(rule2Query.departmentNames, PREVIOUS_DEPTS);
  assert.equal(rule2Query.qrCode, 'ORG-001');
});

test('Rule 2: skipped at sequence 1 - scan proceeds without prior counts', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: {}, // nothing recorded anywhere
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER_SEQ_1, db });
  assert.equal(result.ok, true);
  // Rules 3 + 4 + 5 ran: current dept query + parallel dept query +
  // downstream dept query (Upper Line 02 is seq 1, downstream is seq 3).
  assert.equal(db.calls.netCountQueries.length, 3);
});

test('Rule 2: blocks BEFORE rules 3/4 when it fails (single net query)', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: {}, // previous net 0 -> Rule 2 fails
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.reason, BLOCK_PREVIOUS_SEQ);
  assert.equal(db.calls.netCountQueries.length, 1); // Rule 2 only
});

/* =============== Rule 3: current department net count =============== */

// PREV_OK is defined in the fixtures section above.

test('Rule 3: repairs when the current department nets -1 (Pass brings it back to 0)', async () => {
  // Prospective logic: current -1 + a Pass (+1) nets 0 - allowed.
  // (The old static rule blocked any non-zero current net.)
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { ...PREV_OK, 'ORG-001|Lasting 01': -1 },
  });
  const result = await validateStandardScan({
    scannedQr: 'MSK-001',
    user: USER,
    db,
    qcStatus: 'Forward',
  });
  assert.equal(result.ok, true);
});

test('Rule 3: Return on a current net +1 PASSES and reduces net to 0 (prospective fix)', async () => {
  // THE FIX: current +1 + a Return (-1) nets 0 - allowed. The old static
  // rule blocked this with "Net count is already +1".
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { ...PREV_OK, 'ORG-001|Lasting 01': 1 },
  });
  const result = await validateStandardScan({
    scannedQr: 'MSK-001',
    user: USER,
    db,
    qcStatus: 'Return',
  });
  assert.equal(result.ok, true);
  assert.equal(result.orgQr, 'ORG-001');
});

test('Rule 3: Return on a current net 0 blocks (0 error - nothing to clear)', async () => {
  // Prospective logic: current 0 + a Return (-1) nets -1 - blocked.
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { ...PREV_OK, 'ORG-001|Lasting 01': 0 },
  });
  const result = await validateStandardScan({
    scannedQr: 'MSK-001',
    user: USER,
    db,
    qcStatus: 'Return',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_CURRENT_SEQ_NEGATIVE);
});

test('Rule 3: Pass on a current net +1 still blocks (+1 error - would net 2)', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { ...PREV_OK, 'ORG-001|Lasting 01': 1 },
  });
  const result = await validateStandardScan({
    scannedQr: 'MSK-001',
    user: USER,
    db,
    qcStatus: 'Forward',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_CURRENT_SEQ);
});

test('Rule 3: only Return decrements - Reworked is a +1 scan (blocks on a +1 net)', async () => {
  // The service writes count = -1 ONLY for QC 'Return'; every other QC
  // status (incl. Reworked) writes +1, so the guard predicts the same.
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { ...PREV_OK, 'ORG-001|Lasting 01': 1 },
  });
  const result = await validateStandardScan({
    scannedQr: 'MSK-001',
    user: USER,
    db,
    qcStatus: 'Reworked',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_CURRENT_SEQ);
});

test('Rule 3: blocks when the current department nets 2 (or greater)', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { ...PREV_OK, 'ORG-001|Lasting 01': 2 },
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_CURRENT_SEQ);
});

test('Rule 3: passes when the current department nets exactly 0 (IN then OUT)', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { ...PREV_OK, 'ORG-001|Lasting 01': [1, -1] },
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, true);
});

test("Rule 3: queries ONLY the user's own department for the org QR", async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { ...PREV_OK },
  });
  await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  const rule3Query = db.calls.netCountQueries[1];
  assert.deepEqual(rule3Query.departmentNames, ['Lasting 01']);
  assert.equal(rule3Query.qrCode, 'ORG-001');
});

/* ========== Rule 4: parallel sequence mutual exclusion ============== */

test('Rule 4: blocks when a parallel department (same sequence) nets +1', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { ...PREV_OK, 'ORG-001|Lasting 02': 1 },
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_PARALLEL_SEQ);
});

test('Rule 4: passes when the parallel department nets 0 or negative', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { ...PREV_OK, 'ORG-001|Lasting 02': -1 },
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, true);
});

test('Rule 4: queries every parallel department EXCLUDING the current one', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { ...PREV_OK },
  });
  await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  const rule4Query = db.calls.netCountQueries[2];
  assert.deepEqual(rule4Query.departmentNames, ['Lasting 02']);
});

test('Rule 4: passes when no parallel departments share the sequence', async () => {
  const lonely = [
    { id: 1, department: 'Upper Line 01', sequence: 1 },
    { id: 2, department: 'Solo Dept', sequence: 2 },
  ];
  const db = createFakeDb({
    departments: lonely,
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { 'ORG-001|Upper Line 01': 1 }, // previous seq nets +1
  });
  const result = await validateStandardScan({
    scannedQr: 'MSK-001',
    user: { department: 'Solo Dept' },
    db,
  });
  assert.equal(result.ok, true);
  // Rule 4 ran with an empty department set (no DB round-trip needed).
  const rule4Query = db.calls.netCountQueries[2];
  assert.deepEqual(rule4Query.departmentNames, []);
});

/* ---------- order of 3 vs 4 + success path + safety gates ----------- */

test('Rule 3 is evaluated BEFORE Rule 4 when both would fail', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { ...PREV_OK, 'ORG-001|Lasting 01': 1, 'ORG-001|Lasting 02': 1 },
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_CURRENT_SEQ);
});

test('All guards pass: returns the resolved org_qr and sequence context', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { ...PREV_OK },
  });
  const result = await validateStandardScan({ scannedQr: '  MSK-001  ', user: USER, db });
  assert.equal(result.ok, true);
  assert.equal(result.orgQr, 'ORG-001');
  assert.equal(result.departmentContext.currentDepartment, 'Lasting 01');
  assert.equal(result.departmentContext.currentSeq, 3);
  assert.equal(result.departmentContext.previousSeq, 1);
  assert.deepEqual(result.departmentContext.parallelDepartments, ['Lasting 02']);
  assert.deepEqual(db.calls.mskLookups, ['MSK-001']); // trimmed input
});

test('Safety gate: blocks when the user department is not in departments', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow()] },
  });
  const result = await validateStandardScan({
    scannedQr: 'MSK-001',
    user: { department: 'Unknown Dept' },
    db,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_DEPARTMENT_UNMAPPED);
});

/* ----------- Rule 5: downstream department sequence guard ---------- */

test('Rule 5: passes when the next department net count is 0', async () => {
  const db = createFakeDb({
    departments: DEPARTMENTS_WITH_DOWNSTREAM,
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { ...PREV_OK }, // downstream 'Finishing 01' defaults to 0
  });
  const result = await validateStandardScan({
    scannedQr: 'MSK-001',
    user: USER_WITH_DOWNSTREAM,
    db,
  });
  assert.equal(result.ok, true);
  // Rule 5 ran and queried the downstream department.
  const rule5Query = db.calls.netCountQueries[3];
  assert.deepEqual(rule5Query.departmentNames, ['Finishing 01', 'Finishing 02']);
});

test('Rule 5: blocks when the next department net count is +1', async () => {
  const db = createFakeDb({
    departments: DEPARTMENTS_WITH_DOWNSTREAM,
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { ...PREV_OK, 'ORG-001|Finishing 01': 1 },
  });
  const result = await validateStandardScan({
    scannedQr: 'MSK-001',
    user: USER_WITH_DOWNSTREAM,
    db,
  });
    assert.equal(result.ok, false);
  // The reason is the interpolated downstream message.
  assert.equal(
    result.reason,
    'Scan blocked — This item has already been processed in the next department (Finishing 01, Finishing 02)! Undo/Return the next department first!'
  );
});

test('Rule 5: passes when there is no next department (final department)', async () => {
  // Original DEPARTMENTS: Highest Line (seq 3) has no seq above it.
  const db = createFakeDb({
    departments: DEPARTMENTS,
    mskRows: { 'MSK-001': [mskRow()] },
    counts: { ...PREV_OK },
  });
  const result = await validateStandardScan({
    scannedQr: 'MSK-001',
    user: USER,
    db,
  });
  assert.equal(result.ok, true);
});

/* ----------- Rule 6: PO + Size Cut Quantity limit guard ------------- */

// org_qr in the ";mqc;po;size;scanned;" activation format — encodes a
// PO + size so the Cut Quantity guard (Rule 6) applies.
const ORG_QR = ';mqc;PO-123;35;scanned;';

// PREV_OK for the semicolon-formatted org_qr (Rule 2: previous seq nets +1).
const PREV_OK_ORG = { [`${ORG_QR}|Upper Line 04`]: 1 };

test('Rule 6: passes when prospective department PO+Size quantity is within cut_qty', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow('Active', ORG_QR)] },
    counts: { ...PREV_OK_ORG, [`${ORG_QR}|Lasting 01`]: 0 }, // Rules 2 + 3 satisfied
    podRows: [{ po: 'PO-123', size: '35', cut_qty: 5 }],
    // Current PO+Size sum = 3; prospective 3 + 1 = 4 ≤ 5.
    dataUpdates: [
      { department: 'Lasting 01', qr_code: ORG_QR, count: 2 },
      { department: 'Lasting 01', qr_code: ORG_QR, count: 1 },
    ],
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, true);
  assert.equal(result.orgQr, ORG_QR);
  // Rule 6 queried both the pod limit and the department PO+Size sum.
  assert.equal(db.calls.cutQtyQueries.length, 1);
  assert.deepEqual(db.calls.cutQtyQueries[0], { po: 'PO-123', size: '35' });
  assert.equal(db.calls.deptPoSizeQueries.length, 1);
  assert.deepEqual(db.calls.deptPoSizeQueries[0], {
    department: 'Lasting 01',
    po: 'PO-123',
    size: '35',
  });
});

test('Rule 6: blocks when prospective department PO+Size quantity exceeds cut_qty (exact message)', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow('Active', ORG_QR)] },
    counts: { ...PREV_OK_ORG, [`${ORG_QR}|Lasting 01`]: 0 },
    podRows: [{ po: 'PO-123', size: '35', cut_qty: 3 }],
    // Current PO+Size sum = 3; prospective 3 + 1 = 4 > 3 → blocked.
    dataUpdates: [
      { department: 'Lasting 01', qr_code: ORG_QR, count: 1 },
      { department: 'Lasting 01', qr_code: ORG_QR, count: 1 },
      { department: 'Lasting 01', qr_code: ORG_QR, count: 1 },
    ],
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    cutQtyExceededReason({
      cutQty: 3,
      po: 'PO-123',
      size: '35',
      department: 'Lasting 01',
      currentDeptPoSizeSum: 3,
    })
  );
});

test('Rule 6: Return scan (-1) reduces the PO+Size sum and passes when within cut_qty', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow('Active', ORG_QR)] },
    counts: {
      ...PREV_OK_ORG,
      [`${ORG_QR}|Lasting 01`]: 1, // Rule 3: current net +1, Return → 0 (allowed)
    },
    podRows: [{ po: 'PO-123', size: '35', cut_qty: 5 }],
    // Current PO+Size sum = 3; Return → prospective 3 - 1 = 2 ≤ 5.
    dataUpdates: [
      { department: 'Lasting 01', qr_code: ORG_QR, count: 1 },
      { department: 'Lasting 01', qr_code: ORG_QR, count: 1 },
      { department: 'Lasting 01', qr_code: ORG_QR, count: 1 },
    ],
  });
  const result = await validateStandardScan({
    scannedQr: 'MSK-001',
    user: USER,
    db,
    qcStatus: 'Return',
  });
  assert.equal(result.ok, true);
  assert.equal(result.orgQr, ORG_QR);
});

test('Rule 6: blocks fail-closed when no pod row exists for the PO + size', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow('Active', ORG_QR)] },
    counts: { ...PREV_OK_ORG, [`${ORG_QR}|Lasting 01`]: 0 },
    podRows: [], // no pod row for PO-123 / 35
    dataUpdates: [],
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, noCutQtyReason('PO-123', '35'));
});

test('Rule 6: blocks fail-closed when pod row has a null cut_qty', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow('Active', ORG_QR)] },
    counts: { ...PREV_OK_ORG, [`${ORG_QR}|Lasting 01`]: 0 },
    podRows: [{ po: 'PO-123', size: '35', cut_qty: null }],
    dataUpdates: [],
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, noCutQtyReason('PO-123', '35'));
});

test('Rule 6: blocks fail-safe when the pod table cannot be reached', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow('Active', ORG_QR)] },
    counts: { ...PREV_OK_ORG, [`${ORG_QR}|Lasting 01`]: 0 },
    podRows: [{ po: 'PO-123', size: '35', cut_qty: 5 }],
    failPod: true,
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_CUT_QTY_UNREACHABLE);
});

test('Rule 6: blocks fail-safe when data_updates cannot be reached for the PO+Size sum', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow('Active', ORG_QR)] },
    counts: { ...PREV_OK_ORG, [`${ORG_QR}|Lasting 01`]: 0 },
    podRows: [{ po: 'PO-123', size: '35', cut_qty: 5 }],
    dataUpdates: [{ department: 'Lasting 01', qr_code: ORG_QR, count: 2 }],
    failDataUpdates: true,
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_CUT_QTY_UNREACHABLE);
});

test('Rule 6: skipped for org_qrs that do NOT encode a PO + size (plain legacy QR)', async () => {
  // 'LEGACY-001' has no semicolon structure -> parseOrgQr returns po = the
  // whole text, size = null. The guard skips when size is absent.
  const LEGACY_ORG = 'LEGACY-001';
  const PREV_OK_LEGACY = { [`${LEGACY_ORG}|Upper Line 04`]: 1 };
  const db = createFakeDb({
    mskRows: { 'MSK-001': [mskRow('Active', LEGACY_ORG)] },
    counts: { ...PREV_OK_LEGACY, [`${LEGACY_ORG}|Lasting 01`]: 0 },
  });
  const result = await validateStandardScan({ scannedQr: 'MSK-001', user: USER, db });
  assert.equal(result.ok, true);
  // Rule 6 never queried pod or data_updates for the cut quantity.
  assert.equal(db.calls.cutQtyQueries.length, 0);
  assert.equal(db.calls.deptPoSizeQueries.length, 0);
});

test('Rule 6: runs in Packing single-scan lookup mode (pre-resolved org_qr)', async () => {
  // Packing user scans the Inner Box QR; org_qr is resolved from data_updates
  // and passed pre-resolved. Rule 1 (msk) and Rule 1b (dual-scan) are
  // skipped; Rules 2-5 + Rule 6 run on the resolved org_qr.
  const PACKING_DEPTS = [
    { id: 1, department: 'Upper Line 01', sequence: 1 },
    { id: 2, department: 'Packing', sequence: 3 },
  ];
  const db = createFakeDb({
    departments: PACKING_DEPTS,
    // No mskRows needed - orgQr is pre-resolved, Rule 1 is skipped.
    counts: {
      [`${ORG_QR}|Upper Line 01`]: 1, // Rule 2: previous seq nets +1
      [`${ORG_QR}|Packing`]: 0, // Rule 3: current net 0
    },
    podRows: [{ po: 'PO-123', size: '35', cut_qty: 5 }],
    dataUpdates: [{ department: 'Packing', qr_code: ORG_QR, count: 2 }], // sum 2, prospective 3 ≤ 5
  });
  const result = await validateStandardScan({
    scannedQr: 'IBOX-001',
    user: { username: 'p-user', department: 'Packing' },
    db,
    orgQr: ORG_QR, // pre-resolved -> Packing single-scan lookup mode
  });
  assert.equal(result.ok, true);
  assert.equal(result.orgQr, ORG_QR);
  // Rule 1 (msk) was skipped - no msk lookup.
  assert.equal(db.calls.mskLookups.length, 0);
  // Rule 6 ran against the resolved org_qr.
  assert.equal(db.calls.cutQtyQueries.length, 1);
  assert.equal(db.calls.deptPoSizeQueries.length, 1);
});

test('Rule 6: runs AFTER Rule 5 - blocks cut_qty even when downstream guard would pass', async () => {
  // Verifies Rule 6 is the final guard: the scan reaches it only after
  // Rules 1-5 all pass, and a cut_qty violation blocks here.
  const db = createFakeDb({
    departments: DEPARTMENTS_WITH_DOWNSTREAM,
    mskRows: { 'MSK-001': [mskRow('Active', ORG_QR)] },
    counts: {
      ...PREV_OK_ORG,
      [`${ORG_QR}|Lasting 01`]: 0,
      // downstream nets 0 - Rule 5 passes
    },
    podRows: [{ po: 'PO-123', size: '35', cut_qty: 2 }],
    dataUpdates: [{ department: 'Lasting 01', qr_code: ORG_QR, count: 2 }], // sum 2, prospective 3 > 2
  });
  const result = await validateStandardScan({
    scannedQr: 'MSK-001',
    user: USER_WITH_DOWNSTREAM,
    db,
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    cutQtyExceededReason({
      cutQty: 2,
      po: 'PO-123',
      size: '35',
      department: 'Lasting 01',
      currentDeptPoSizeSum: 2,
    })
  );
  // All 4 prior net-count queries (Rules 2,3,4,5) ran before Rule 6.
  assert.equal(db.calls.netCountQueries.length, 4);
  assert.equal(db.calls.cutQtyQueries.length, 1);
});

