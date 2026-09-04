import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK_INNER_BOX_FORMAT,
  BLOCK_PO_MISMATCH,
  BLOCK_SIZE_MISMATCH,
  createDualScanState,
  extractInnerBoxCode,
  extractInnerBoxPo,
  extractShoePoCode,
  isInnerBoxQrFormatValid,
  parseOrgQr,
  srlNumNotFoundReason,
  sizeMismatchReason,
  sizesMatch,
  validateDualScanPair,
} from '../lib/transactionDualScan.js';
import {
  validateStandardScan,
  BLOCK_SRL_UNREACHABLE,
  BLOCK_DUPLICATE_INNER_BOX,
  BLOCK_DUPLICATE_INNER_BOX_CHECK_FAILED,
} from '../lib/transactionGuards.js';

/* ------- fixture QRs (digit positions hand-verified) ---------------- */
// Inner A digits: 24 digits; backwards PO code (after skipping the
// last 8) = positions 12-15 = '3456'; forwards Box Code (after
// skipping the first 3) = positions 3-15 = '4567890123456'.
const INNER_A = 'http://blaklader.com/product/123456789012345678901234/box';
// Hyphenated PO: 123456-02 -> strip suffix -> 123456 -> last 4 '3456'.
const SHOE_A = ';MQC-77;123456-02;42;scanned;';
// Inner B digits: positions 12-15 = '4065'; Box Code = '4567890124065'.
const INNER_B = 'http://blaklader.com/box/123456789012406599999999/x';
// Standard PO: 144065 -> last 4 directly = '4065'.
const SHOE_B = ';MQC-88;144065;42;scanned;';

const SRL_SIZES = {
  '4567890123456': '42',
  '4567890124065': '42',
  // Exact production row used by the V3 tests below.
  '7330509963975': '35',
};

// Exact production shoe org_qr (3rd ';' field = size '35').
const REAL_SHOE = ';566998;148925;35;33;';

/* ------------- Validation 2: shoe PO extraction (both formats) ------ */

test('Shoe PO hyphen format: 148925-01 strips the suffix then takes last 4 -> 8925', () => {
  assert.equal(extractShoePoCode('148925-01'), '8925');
  assert.equal(extractShoePoCode(SHOE_A), '3456'); // 123456-02 -> 3456
});

test('Shoe PO standard format: 144065 takes the last 4 digits directly -> 4065', () => {
  assert.equal(extractShoePoCode('144065'), '4065');
  assert.equal(extractShoePoCode(SHOE_B), '4065');
});

test('Shoe PO extraction handles the full org_qr structure and junk', () => {
  assert.equal(parseOrgQr(SHOE_A).po, '123456-02');
  assert.equal(parseOrgQr(SHOE_A).size, '42');
  assert.equal(extractShoePoCode(''), null);
  assert.equal(extractShoePoCode(';mqc;;42;'), null); // no PO segment
  assert.equal(extractShoePoCode(';mqc;12-;42;'), null); // too few digits
});

/* ---------- Validation 2: inner PO extraction (backwards) ----------- */

test('Inner PO extraction: backwards skip 8 digits then take preceding 4', () => {
  assert.equal(extractInnerBoxPo(INNER_A), '3456');
  assert.equal(extractInnerBoxPo(INNER_B), '4065');
});

test('Inner PO extraction skips non-digit URL separators', () => {
  // Digits separated by punctuation still resolve in backwards order.
  assert.equal(extractInnerBoxPo('http://blaklader.com/9-9-9-9-1-2-3-4-5-6-7-8-9-0-1-2'), '1234');
  assert.equal(extractInnerBoxPo('no digits here'), null);
  assert.equal(extractInnerBoxPo('12345678901'), null); // < 12 digits
});

/* ----- Validation 2: real GS1 label (control chars + variable parts) - */

// Real scanned Inner Box QR: GS1 elements 01+GTIN(14) | 21+serial |
// 10+PO(148925) | 8200+URL, delimited by \u001d group separators.
const INNER_GS =
  '010733050996397521028002291\u001d10148925\u001d8200http://blaklader.com';
// The same label with the group separators stripped (some scanners).
const INNER_GS_NO_SEP = INNER_GS.split('\u001d').join('');

test('real GS1 sample: PO comes from the 10-AI segment -> 148925 -> 8925', () => {
  assert.equal(extractInnerBoxPo(INNER_GS), '8925');
});

test('real GS1 sample without separators: URL-anchored scan still yields 8925', () => {
  assert.equal(extractInnerBoxPo(INNER_GS_NO_SEP), '8925');
});

test('GS1 control characters never corrupt the extraction', () => {
  // Whitespace around the PO segment is trimmed before matching.
  const padded =
    '010733050996397521028002291\u001d 10148925 \u001d8200http://blaklader.com';
  assert.equal(extractInnerBoxPo(padded), '8925');
  // The first 10-element wins; a later 10-element is ignored.
  const twoTenElements =
    '0107330509963975\u001d10148925\u001d21X\u001d10999999\u001d8200http://blaklader.com';
  assert.equal(extractInnerBoxPo(twoTenElements), '8925');
});

test('real GS1 sample: 13-digit Box Code is unaffected by control characters', () => {
  // 01 + 14-digit GTIN prefix: skip 3 digits -> 7330509963975.
  assert.equal(extractInnerBoxCode(INNER_GS), '7330509963975');
  assert.equal(extractInnerBoxCode(INNER_GS_NO_SEP), '7330509963975');
});

test('real GS1 sample: pair matches 148925-01 shoe (8925), rejects 144065 shoe', () => {
  assert.equal(
    validateDualScanPair({
      innerQr: INNER_GS,
      orgQr: ';MQC-9;148925-01;42;scanned;',
      srlSize: '42',
    }),
    null
  );
  assert.deepEqual(
    validateDualScanPair({
      innerQr: INNER_GS,
      orgQr: ';MQC-9;144065;42;scanned;',
      srlSize: '42',
    }),
    { reason: BLOCK_PO_MISMATCH }
  );
});

/* ---------- Validation 3: inner 13-digit Box Code extraction -------- */

test('Inner Box Code: skip first 3 digits then extract the next 13', () => {
  assert.equal(extractInnerBoxCode(INNER_A), '4567890123456');
  assert.equal(extractInnerBoxCode(INNER_B), '4567890124065');
});

test('Inner Box Code is null when the QR does not carry 16 leading digits', () => {
  assert.equal(extractInnerBoxCode('http://blaklader.com/12345'), null);
  assert.equal(extractInnerBoxCode(''), null);
});

/* ------------- Validation 1: exact blaklader URL token -------------- */

test('URL check requires the exact http://blaklader.com substring', () => {
  assert.equal(isInnerBoxQrFormatValid(INNER_A), true);
  assert.equal(isInnerBoxQrFormatValid('xhttp://blaklader.com/y'), true); // substring counts
  assert.equal(isInnerBoxQrFormatValid('https://blaklader.com/box'), false); // https != http
  assert.equal(isInnerBoxQrFormatValid('SHOE-QR-77'), false);
  assert.equal(isInnerBoxQrFormatValid(''), false);
  assert.equal(isInnerBoxQrFormatValid(null), false);
});

/* ------------- combined pair validation (V1 -> V2 -> V3) ------------ */

test('validateDualScanPair passes a matching Inner/Shoe pair (both PO formats)', () => {
  assert.equal(
    validateDualScanPair({ innerQr: INNER_A, orgQr: SHOE_A, srlSize: '42' }),
    null
  );
  assert.equal(
    validateDualScanPair({ innerQr: INNER_B, orgQr: SHOE_B, srlSize: '42' }),
    null
  );
});

test('V1 failure: inner QR without the blaklader URL fails with the exact message', () => {
  const result = validateDualScanPair({
    innerQr: 'INNER-BOX-001',
    orgQr: SHOE_A,
    srlSize: '42',
  });
  assert.deepEqual(result, { reason: BLOCK_INNER_BOX_FORMAT });
});

test('V2 failure: 148925-01 shoe (8925) vs inner 3456 fails with the exact message', () => {
  const result = validateDualScanPair({
    innerQr: INNER_A,
    orgQr: ';MQC-77;148925-01;42;scanned;',
    srlSize: '42',
  });
  assert.deepEqual(result, { reason: BLOCK_PO_MISMATCH });
});

test('V3 failure (a): a missing srl_num row fails naming the exact box code', () => {
  const missing = validateDualScanPair({ innerQr: INNER_A, orgQr: SHOE_A, srlSize: null });
  assert.deepEqual(missing, {
    reason: srlNumNotFoundReason('4567890123456'),
  });
  assert.equal(
    missing.reason,
    'Box code 4567890123456 not found in srl_num database'
  );
});

test('V3 failure (b): a size mismatch fails naming BOTH sizes', () => {
  const wrong = validateDualScanPair({ innerQr: INNER_A, orgQr: SHOE_A, srlSize: '44' });
  assert.deepEqual(wrong, { reason: sizeMismatchReason('44', '42') });
  assert.equal(
    wrong.reason,
    "Size Mismatch: Inner Box Size ('44') does not match Shoe Size ('42')"
  );
});

test('V3 generic branch: label without a 13-digit Box Code keeps the static message', () => {
  // Only 12 digits on the label: the PO resolves ('1234') but no
  // 13-digit Box Code exists after the first 3 -> nothing to look up.
  const result = validateDualScanPair({
    innerQr: 'http://blaklader.com/123456789012',
    orgQr: ';MQC-9;99991234;42;scanned;',
    srlSize: '42',
  });
  assert.deepEqual(result, { reason: BLOCK_SIZE_MISMATCH });
});

/* ------ V3 with the exact production values (srl_num + shoe org_qr) -- */

test('exact values: box code 7330509963975 is extracted and trimmed', () => {
  assert.equal(extractInnerBoxCode(`  ${INNER_GS}  `), '7330509963975');
  assert.equal(parseOrgQr(REAL_SHOE).size, '35');
});

test('exact values: real label + srl_num 7330509963975=35 + shoe ;566998;148925;35;33; passes', () => {
  assert.equal(
    validateDualScanPair({ innerQr: INNER_GS, orgQr: REAL_SHOE, srlSize: '35' }),
    null
  );
});

test('exact values: missing srl_num row -> "Box code 7330509963975 not found in srl_num database"', () => {
  const result = validateDualScanPair({ innerQr: INNER_GS, orgQr: REAL_SHOE, srlSize: null });
  assert.equal(result.reason, 'Box code 7330509963975 not found in srl_num database');
});

test('exact values: mismatch -> both sizes named (36 vs 35)', () => {
  const result = validateDualScanPair({ innerQr: INNER_GS, orgQr: REAL_SHOE, srlSize: '36' });
  assert.equal(
    result.reason,
    "Size Mismatch: Inner Box Size ('36') does not match Shoe Size ('35')"
  );
});

test('sizesMatch: String + trim + toUpperCase, plus numeric tolerance', () => {
  assert.equal(sizesMatch(' 35 ', '35'), true); // whitespace tolerance
  assert.equal(sizesMatch('XL', 'xl'), true); // case-insensitive
  assert.equal(sizesMatch('35.0', '35'), true); // numeric-equal formats
  assert.equal(sizesMatch('35', '36'), false);
  assert.equal(sizesMatch(null, '35'), false);
  assert.equal(sizesMatch('35', undefined), false);
});

/* ------- orchestrator integration (guards run V1-V3 for pairs) ------ */

const SEQ1_DEPTS = [{ id: 1, department: 'Upper Line 01', sequence: 1 }];
const SEQ1_USER = { username: 'nimal', department: 'Upper Line 01' };

/** Fake guard db with an in-memory srl_num map and call recording. */
function createFakeDb({
  mskRows = {},
  counts = {},
  srlSizes = SRL_SIZES,
  failSrl = false,
  existingInner = {},
} = {}) {
  const calls = { srlLookups: [], netCountQueries: [], innerLookups: [] };
  return {
    calls,
    async listMskRowsByMskQr(mskQr) {
      return mskRows[mskQr] || [];
    },
    async listDepartments() {
      return SEQ1_DEPTS;
    },
    async getNetCount(qrCode, departmentNames) {
      calls.netCountQueries.push({ qrCode, departmentNames });
      return departmentNames.reduce((sum, name) => sum + (counts[`${qrCode}|${name}`] || 0), 0);
    },
    async getSrlSize(boxCode) {
      calls.srlLookups.push(boxCode);
      if (failSrl) throw new Error('fetch failed');
      return srlSizes[boxCode] ?? null;
    },
    async innerQrExistsInDataUpdates(innerQr) {
      calls.innerLookups.push(innerQr);
      return Boolean(existingInner[innerQr]);
    },
  };
}

const MSK_ACTIVE = [{ org_qr: SHOE_A, status: 'Active' }];

test('Orchestrator: a matching dual pair passes every guard end-to-end', async () => {
  const db = createFakeDb({ mskRows: { 'MSK-1': MSK_ACTIVE } });
  const result = await validateStandardScan({
    scannedQr: 'MSK-1',
    user: SEQ1_USER,
    db,
    innerQr: INNER_A,
  });
  assert.equal(result.ok, true);
  assert.equal(result.orgQr, SHOE_A);
  assert.deepEqual(db.calls.srlLookups, ['4567890123456']);
});

test('Orchestrator: PO mismatch blocks BEFORE the sequence net-count guards', async () => {
  const db = createFakeDb({ mskRows: { 'MSK-1': MSK_ACTIVE } });
  const result = await validateStandardScan({
    scannedQr: 'MSK-1',
    user: SEQ1_USER,
    db,
    innerQr: INNER_A, // 3456 vs the hyphen-format shoe 8925
    // override the resolved org_qr by pointing msk at the other shoe
  });
  void result;
  const db2 = createFakeDb({
    mskRows: { 'MSK-1': [{ org_qr: ';MQC-77;148925-01;42;scanned;', status: 'Active' }] },
  });
  const blocked = await validateStandardScan({
    scannedQr: 'MSK-1',
    user: SEQ1_USER,
    db: db2,
    innerQr: INNER_A,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, BLOCK_PO_MISMATCH);
  assert.equal(blocked.dualScan, true); // view resets the Inner field
  assert.equal(db2.calls.netCountQueries.length, 0); // Rules 2-4 never ran
});

test('Orchestrator: an unreachable srl_num table blocks the scan fail-safe', async () => {
  const db = createFakeDb({ mskRows: { 'MSK-1': MSK_ACTIVE }, failSrl: true });
  const result = await validateStandardScan({
    scannedQr: 'MSK-1',
    user: SEQ1_USER,
    db,
    innerQr: INNER_A,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_SRL_UNREACHABLE);
  assert.equal(result.dualScan, true);
});

test('Orchestrator: single scans (no inner QR) never query srl_num', async () => {
  const db = createFakeDb({ mskRows: { 'MSK-1': MSK_ACTIVE }, failSrl: true });
  const result = await validateStandardScan({
    scannedQr: 'MSK-1',
    user: SEQ1_USER,
    db,
    innerQr: null,
  });
  assert.equal(result.ok, true); // srl failure is irrelevant without a pair
  assert.deepEqual(db.calls.srlLookups, []);
});

/* --------------- Duplicate Inner Box Guard (standard transactions) --------------- */

test('Orchestrator: a duplicate Inner Box QR is rejected (already in data_updates)', async () => {
  // The same Inner Box QR (INNER_A) already exists in data_updates -
  // the pair must be blocked even though V1-V3 all pass.
  const db = createFakeDb({
    mskRows: { 'MSK-1': MSK_ACTIVE },
    existingInner: { [INNER_A]: true },
  });
  const result = await validateStandardScan({
    scannedQr: 'MSK-1',
    user: SEQ1_USER,
    db,
    innerQr: INNER_A,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_DUPLICATE_INNER_BOX);
  assert.equal(result.dualScan, true); // view resets the Inner field
  assert.deepEqual(db.calls.srlLookups, ['4567890123456']); // V3 passed
  assert.deepEqual(db.calls.innerLookups, [INNER_A]); // duplicate check ran
});

test('Orchestrator: an unreachable data_updates table blocks the duplicate check fail-safe', async () => {
  const db = createFakeDb({ mskRows: { 'MSK-1': MSK_ACTIVE } });
  // Override innerQrExistsInDataUpdates to simulate an unreachable table.
  db.innerQrExistsInDataUpdates = async () => {
    throw new Error('network error');
  };
  const result = await validateStandardScan({
    scannedQr: 'MSK-1',
    user: SEQ1_USER,
    db,
    innerQr: INNER_A,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_DUPLICATE_INNER_BOX_CHECK_FAILED);
  assert.equal(result.dualScan, true);
});
test('Orchestrator: QC Return BYPASSES the Duplicate Inner Box Guard (registered box allowed through)', async () => {
  // The same Inner Box QR is already registered in data_updates, but the
  // QC status is 'Return' - the Return service layer clears the inner_qr
  // association, so a registered box MUST be allowed through.
  const db = createFakeDb({
    mskRows: { 'MSK-1': MSK_ACTIVE },
    existingInner: { [INNER_A]: true }, // box already registered
  });
  const result = await validateStandardScan({
    scannedQr: 'MSK-1',
    user: SEQ1_USER,
    db,
    innerQr: INNER_A,
    qcStatus: 'Return',
  });
  assert.equal(result.ok, true); // passes validation
  assert.equal(result.orgQr, SHOE_A);
  assert.deepEqual(db.calls.srlLookups, ['4567890123456']); // V3 STILL ran
  assert.deepEqual(db.calls.innerLookups, []); // duplicate check bypassed
});

test('Orchestrator: non-Return QC statuses still enforce the Duplicate Inner Box Guard', async () => {
  const db = createFakeDb({
    mskRows: { 'MSK-1': MSK_ACTIVE },
    existingInner: { [INNER_A]: true },
  });
  const result = await validateStandardScan({
    scannedQr: 'MSK-1',
    user: SEQ1_USER,
    db,
    innerQr: INNER_A,
    qcStatus: 'Forward', // NOT Return -> guard enforced
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, BLOCK_DUPLICATE_INNER_BOX);
  assert.deepEqual(db.calls.innerLookups, [INNER_A]); // check ran
});

/* ------------------ failed-scan reset contract ---------------------- */



test('Failed-scan reset contract: createDualScanState clears the pair and rearms stage 1', () => {
  // The view calls exactly this on ANY validation failure, then bumps
  // its focus signal so the Inner Box field is cleared and re-focused.
  const midPair = { enabled: true, stage: 'shoe', innerQr: INNER_A };
  const reset = createDualScanState(midPair.enabled);
  assert.equal(reset.enabled, true);
  assert.equal(reset.innerQr, null); // captured Inner dropped
  assert.equal(reset.stage, 'inner'); // focus back on the Inner field
  const bypassedReset = createDualScanState(false);
  assert.equal(bypassedReset.enabled, false);
});

/* --------------- supabase adapter: getSrlSize shape ----------------- */

test('getSrlSize queries srl_num.size by box_num with limit 1', async () => {
  const queries = [];
  const makeBuilder = (table) => {
    const record = { table, select: null, filters: [], limited: false };
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
      limit() {
        record.limited = true;
        return chain;
      },
      then(onFulfilled, onRejected) {
        const payload =
          table === 'srl_num'
            ? { data: [{ size: '42' }], error: null }
            : { data: [], error: null };
        return Promise.resolve(payload).then(onFulfilled, onRejected);
      },
    };
    return chain;
  };
  const { createSupabaseGuardDb } = await import('../lib/transactionGuards.js');
  const db = createSupabaseGuardDb({ from: makeBuilder });
  const size = await db.getSrlSize('4567890123456');
  assert.equal(size, '42');
  assert.equal(queries[0].table, 'srl_num');
  assert.equal(queries[0].select, 'size');
  assert.deepEqual(queries[0].filters, [['eq', 'box_num', '4567890123456']]);
  assert.equal(queries[0].limited, true);
});

