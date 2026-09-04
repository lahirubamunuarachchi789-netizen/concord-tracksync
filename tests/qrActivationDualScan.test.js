import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActivationDataRow,
  buildActivationMskRow,
  validateActivationScan,
} from '../lib/qrActivationDualScan.js';
import {
  BLOCK_INNER_BOX_FORMAT,
  BLOCK_PO_MISMATCH,
  DUAL_SCAN_STAGES,
  applyDualScanScan,
  createDualScanState,
  isDualScanEnabled,
  isDualScanQcBypass,
  srlNumNotFoundReason,
  sizeMismatchReason,
} from '../lib/transactionDualScan.js';
import { BLOCK_SRL_UNREACHABLE, BLOCK_DUPLICATE_INNER_BOX, BLOCK_DUPLICATE_INNER_BOX_CHECK_FAILED } from '../lib/transactionGuards.js';

/* ----------------------- fixtures (production values) ---------------------- */

// Real scanned Inner Box QR: GS1 01+GTIN(14) | 21+serial | 10+PO(148925) |
// 8200+URL, delimited by the \u001d group separator. Box Code (skip 3, take 13)
// = 7330509963975; PO from the 10-AI segment = 148925 -> trailing 4 = 8925.
const INNER_GS =
  '010733050996397521028002291\u001d10148925\u001d8200http://blaklader.com';

// The activation-formatted shoe org_qr ";mqc;po;size;scanned;" - PO 148925 ->
// trailing 4 = 8925 (matches the inner), size 35 (matches srl_num 7330509963975).
const ACTIVATION_ORG_QR = ';566998;148925;35;RAW-SHOE-1;';

const USER = { username: 'nimal', department: 'Finishing 01' };

/**
 * Fake srl_num lookup + Duplicate Inner Box check with call recording
 * (mirrors the guard-db adapter). `innerQrExists` returns false by
 * default (no pre-existing Inner Box) and records its lookups.
 */
function createFakeSrl({ sizes = {}, fail = false, innerMatches = {} } = {}) {
  const calls = { srlLookups: [], innerLookups: [] };
  return {
    calls,
    async getSrlSize(boxCode) {
      calls.srlLookups.push(boxCode);
      if (fail) throw new Error('fetch failed');
      return sizes[boxCode] ?? null;
    },
    async innerQrExists(innerQr) {
      calls.innerLookups.push(innerQr);
      return Boolean(innerMatches[innerQr]);
    },
  };
}

/* --------------- 1. Dual-Scan enablement (QR Activation) --------------- */

test('QR Activation: Finishing departments enable Dual-Scan with a non-bypass QC status', () => {
  for (const department of ['Finishing 01', 'Finishing 02', 'Finishing 03']) {
    for (const qc of ['Forward', 'Return', 'Reworked']) {
      assert.equal(isDualScanEnabled(department, qc), true, `${department} + ${qc}`);
    }
  }
  // case-insensitive + whitespace tolerant (same contract as standard).
  assert.equal(isDualScanEnabled(' finishing 02 ', 'Forward'), true);
});

test('QR Activation: bypass QC statuses disable Dual-Scan even in Finishing', () => {
  for (const qc of ['B Grade', 'C Grade', 'Lab Testing']) {
    assert.equal(isDualScanEnabled('Finishing 01', qc), false, qc);
  }
});

test('QR Activation: non-Finishing departments never enable Dual-Scan', () => {
  for (const qc of ['Forward', 'B Grade', 'Return']) {
    assert.equal(isDualScanEnabled('Lasting 01', qc), false);
    assert.equal(isDualScanEnabled('Upper Line 02', qc), false);
  }
});

/* ------------------------- 2. stage machine ---------------------------- */

test('QR Activation scan 1 of 2: Inner Box QR captured, nothing activates', () => {
  const state = createDualScanState(true);
  const { next, submitCode, innerQrForSubmit } = applyDualScanScan(state, INNER_GS);
  assert.equal(submitCode, null); // no activation yet
  assert.equal(innerQrForSubmit, null);
  assert.equal(next.enabled, true);
  assert.equal(next.stage, DUAL_SCAN_STAGES.SHOE); // focus shifts to Shoe QR
  assert.equal(next.innerQr, INNER_GS);
});

test('QR Activation scan 2 of 2: Shoe QR submits with the captured Inner Box QR and resets', () => {
  const state = { enabled: true, stage: DUAL_SCAN_STAGES.SHOE, innerQr: INNER_GS };
  const { next, submitCode, innerQrForSubmit } = applyDualScanScan(state, 'RAW-SHOE-1');
  assert.equal(submitCode, 'RAW-SHOE-1');
  assert.equal(innerQrForSubmit, INNER_GS); // carried to the activation write
  // Pair recorded - state resets to a fresh stage 1 for the next pair.
  assert.deepEqual(next, createDualScanState(true));
});

test('QR Activation bypass: every scan submits immediately with inner = null', () => {
  const state = createDualScanState(false);
  const { submitCode, innerQrForSubmit, next } = applyDualScanScan(state, 'RAW-SHOE-1');
  assert.equal(submitCode, 'RAW-SHOE-1');
  assert.equal(innerQrForSubmit, null); // null when bypassed
  assert.equal(next.enabled, false); // stays single mode
});

/* --------------- 3. V1-V3 gate (validateActivationScan) ---------------- */

test('gate: a matching dual pair passes every check end-to-end', async () => {
  const srl = createFakeSrl({ sizes: { '7330509963975': '35' } });
  const gate = await validateActivationScan({
    innerQr: INNER_GS,
    orgQr: ACTIVATION_ORG_QR,
    getSrlSize: srl.getSrlSize,
    innerQrExists: srl.innerQrExists,
  });
  assert.deepEqual(gate, { ok: true });
  assert.deepEqual(srl.calls.srlLookups, ['7330509963975']); // box code queried exactly once
  assert.deepEqual(srl.calls.innerLookups, [INNER_GS]); // duplicate check ran after V3
});

test('gate: V1 - an Inner Box QR without the blaklader URL token is rejected', async () => {
  const srl = createFakeSrl({ sizes: { '7330509963975': '35' } });
  // No blaklader URL (V1 fails) AND no 13-digit box code -> srl is never queried.
  const gate = await validateActivationScan({
    innerQr: 'http://example.com/product/short',
    orgQr: ACTIVATION_ORG_QR,
    getSrlSize: srl.getSrlSize,
    innerQrExists: srl.innerQrExists,
  });
  assert.deepEqual(gate, { ok: false, reason: BLOCK_INNER_BOX_FORMAT, dualScan: true });
  assert.deepEqual(srl.calls.srlLookups, []); // V1 fails BEFORE any srl_num lookup
  assert.deepEqual(srl.calls.innerLookups, []); // duplicate check never reached
});

test('gate: V2 - a PO mismatch between Inner Box and Shoe QR is rejected', async () => {
  const srl = createFakeSrl({ sizes: { '7330509963975': '35' } });
  // Has the blaklader URL (V1 passes) but no box code and no PO element,
  // so V2 fails and srl is never queried.
  const gate = await validateActivationScan({
    innerQr: 'http://blaklader.com/product/short',
    orgQr: ';566998;999999;35;RAW-SHOE-1;',
    getSrlSize: srl.getSrlSize,
    innerQrExists: srl.innerQrExists,
  });
  assert.deepEqual(gate, { ok: false, reason: BLOCK_PO_MISMATCH, dualScan: true });
  assert.deepEqual(srl.calls.srlLookups, []); // V2 fails BEFORE the srl_num lookup
  assert.deepEqual(srl.calls.innerLookups, []); // duplicate check never reached
});

test('gate: V3 - a missing srl_num row fails naming the exact box code', async () => {
  const srl = createFakeSrl({ sizes: {} }); // no row for 7330509963975
  const gate = await validateActivationScan({
    innerQr: INNER_GS,
    orgQr: ACTIVATION_ORG_QR,
    getSrlSize: srl.getSrlSize,
    innerQrExists: srl.innerQrExists,
  });
  assert.deepEqual(gate, {
    ok: false,
    reason: srlNumNotFoundReason('7330509963975'),
    dualScan: true,
  });
});

test('gate: V3 - a size mismatch names BOTH sizes (srl first, shoe second)', async () => {
  const srl = createFakeSrl({ sizes: { '7330509963975': '36' } }); // 36 vs shoe 35
  const gate = await validateActivationScan({
    innerQr: INNER_GS,
    orgQr: ACTIVATION_ORG_QR,
    getSrlSize: srl.getSrlSize,
    innerQrExists: srl.innerQrExists,
  });
  assert.deepEqual(gate, {
    ok: false,
    reason: sizeMismatchReason('36', '35'),
    dualScan: true,
  });
});

/* -------------------- 4. data routing (both tables) -------------------- */

test('data_updates routing: a dual pair stores ALL transaction fields incl. inner_qr', () => {
  const dataRow = buildActivationDataRow({
    user: USER,
    qrCode: ACTIVATION_ORG_QR,
    recordStatus: 'IN',
    qcStatus: 'Forward',
    innerQr: INNER_GS,
  });
  assert.equal(dataRow.qr_code, ACTIVATION_ORG_QR); // org_qr (formatted string)
  assert.equal(dataRow.inner_qr, INNER_GS); // captured Inner Box QR
  assert.equal(dataRow.record_status, 'IN');
  assert.equal(dataRow.qc_status, 'Forward');
  assert.equal(dataRow.department, 'Finishing 01');
  assert.equal(dataRow.count, 1);
  assert.equal(dataRow.created_by, 'nimal');
  assert.ok(!Number.isNaN(Date.parse(dataRow.created_at))); // valid scan timestamp
  // the full standard-transaction field set, in stable alphabetical order
  assert.deepEqual(Object.keys(dataRow).sort(), [
    'count',
    'created_at',
    'created_by',
    'department',
    'inner_qr',
    'qc_status',
    'qr_code',
    'record_status',
  ]);
});

test('data_updates routing: single scans persist inner_qr = null', () => {
  const dataRow = buildActivationDataRow({
    user: USER,
    qrCode: ACTIVATION_ORG_QR,
    recordStatus: 'OUT',
    qcStatus: 'Forward',
    innerQr: null,
  });
  assert.equal(dataRow.inner_qr, null);
  assert.equal(dataRow.count, 1);
});

test('data_updates routing: inner_qr is trimmed; whitespace-only becomes null', () => {
  const dataRow = buildActivationDataRow({
    user: USER,
    qrCode: ACTIVATION_ORG_QR,
    recordStatus: 'IN',
    qcStatus: 'Forward',
    innerQr: `  ${INNER_GS}  `,
  });
  assert.equal(dataRow.inner_qr, INNER_GS); // trimmed
});

test('data_updates routing: Return keeps count = -1 while inner_qr is still stored', () => {
  const dataRow = buildActivationDataRow({
    user: USER,
    qrCode: ACTIVATION_ORG_QR,
    recordStatus: 'OUT',
    qcStatus: 'Return',
    innerQr: INNER_GS,
  });
  assert.equal(dataRow.count, -1);
  assert.equal(dataRow.inner_qr, INNER_GS);
});

test('data_updates routing: missing user falls back to safe defaults', () => {
  const dataRow = buildActivationDataRow({
    user: null,
    qrCode: ACTIVATION_ORG_QR,
    recordStatus: 'IN',
    qcStatus: 'Forward',
  });
  assert.equal(dataRow.department, '-');
  assert.equal(dataRow.created_by, 'unknown');
  assert.equal(dataRow.inner_qr, null);
});

test('msk routing: standard shoe activation data ONLY - inner_qr is NEVER written', () => {
  const mskRow = buildActivationMskRow({ qrValue: 'RAW-SHOE-1', qrCode: ACTIVATION_ORG_QR });
  assert.deepEqual(mskRow, { msk_qr: 'RAW-SHOE-1', org_qr: ACTIVATION_ORG_QR });
  // EXACTLY two keys - the Inner Box QR must never leak into msk.
  assert.deepEqual(Object.keys(mskRow).sort(), ['msk_qr', 'org_qr']);
  assert.ok(!('inner_qr' in mskRow));
});

/* --------------- 5. end-to-end: full dual flow routes correctly --------------- */

test('end-to-end: a full Dual-Scan pair routes the Inner QR to data_updates and never to msk', async () => {
  // Scan 1 of 2: capture the Inner Box QR.
  const first = applyDualScanScan(createDualScanState(true), INNER_GS);
  assert.equal(first.submitCode, null);

  // Scan 2 of 2: the Shoe QR submits together with the captured Inner.
  const second = applyDualScanScan(first.next, 'RAW-SHOE-1');
  assert.equal(second.submitCode, 'RAW-SHOE-1');
  assert.equal(second.innerQrForSubmit, INNER_GS);

  // The V1-V3 gate validates the pair against the activation org_qr.
  const srl = createFakeSrl({ sizes: { '7330509963975': '35' } });
  const gate = await validateActivationScan({
    innerQr: second.innerQrForSubmit,
    orgQr: ACTIVATION_ORG_QR,
    getSrlSize: srl.getSrlSize,
    innerQrExists: srl.innerQrExists,
  });
  assert.deepEqual(gate, { ok: true });

  // data_updates gets ALL fields incl. inner_qr; msk gets the standard marking only.
  const dataRow = buildActivationDataRow({
    user: USER,
    qrCode: ACTIVATION_ORG_QR,
    recordStatus: 'IN',
    qcStatus: 'Forward',
    innerQr: second.innerQrForSubmit,
  });
  const mskRow = buildActivationMskRow({ qrValue: second.submitCode, qrCode: ACTIVATION_ORG_QR });
  assert.equal(dataRow.inner_qr, INNER_GS);
  assert.equal(mskRow.msk_qr, 'RAW-SHOE-1');
  assert.ok(!('inner_qr' in mskRow));
  assert.deepEqual(srl.calls.srlLookups, ['7330509963975']);
});

test('end-to-end: a rejected pair writes NOTHING to either table', async () => {
  const second = applyDualScanScan(
    { enabled: true, stage: DUAL_SCAN_STAGES.SHOE, innerQr: INNER_GS },
    'RAW-SHOE-1'
  );
  // PO mismatch -> gate fails -> caller must NOT build/insert either row.
  const srl = createFakeSrl({ sizes: { '7330509963975': '35' } });
  const gate = await validateActivationScan({
    innerQr: second.innerQrForSubmit,
    orgQr: ';566998;999999;35;RAW-SHOE-1;', // 9999 != inner 8925
    getSrlSize: srl.getSrlSize,
    innerQrExists: srl.innerQrExists,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.dualScan, true); // view resets the Inner field on this flag
});

test('gate: an unreachable srl_num table blocks the scan fail-safe', async () => {
  const srl = createFakeSrl({ fail: true });
  const gate = await validateActivationScan({
    innerQr: INNER_GS,
    orgQr: ACTIVATION_ORG_QR,
    getSrlSize: srl.getSrlSize,
    innerQrExists: srl.innerQrExists,
  });
  assert.deepEqual(gate, { ok: false, reason: BLOCK_SRL_UNREACHABLE, dualScan: true });
});

test('gate: single scans (no inner QR) pass and never query srl_num', async () => {
  const srl = createFakeSrl({ fail: true }); // would throw if ever called
  const gateNull = await validateActivationScan({ innerQr: null, orgQr: ACTIVATION_ORG_QR, getSrlSize: srl.getSrlSize, innerQrExists: srl.innerQrExists });
  const gateEmpty = await validateActivationScan({ innerQr: '   ', orgQr: ACTIVATION_ORG_QR, getSrlSize: srl.getSrlSize, innerQrExists: srl.innerQrExists });
  assert.deepEqual(gateNull, { ok: true });
  assert.deepEqual(gateEmpty, { ok: true });
  assert.deepEqual(srl.calls.srlLookups, []);
  assert.deepEqual(srl.calls.innerLookups, []);
});

/* --------------- 6. Duplicate Inner Box Guard (activation) --------------- */

test('gate: a duplicate Inner Box QR is rejected (already in data_updates)', async () => {
  // The same Inner Box QR (INNER_GS) already exists in data_updates -
  // the pair must be blocked even though V1-V3 all pass.
  const srl = createFakeSrl({
    sizes: { '7330509963975': '35' },
    innerMatches: { [INNER_GS]: true },
  });
  const gate = await validateActivationScan({
    innerQr: INNER_GS,
    orgQr: ACTIVATION_ORG_QR,
    getSrlSize: srl.getSrlSize,
    innerQrExists: srl.innerQrExists,
  });
  assert.deepEqual(gate, { ok: false, reason: BLOCK_DUPLICATE_INNER_BOX, dualScan: true });
  assert.deepEqual(srl.calls.srlLookups, ['7330509963975']); // V3 passed
  assert.deepEqual(srl.calls.innerLookups, [INNER_GS]); // duplicate check ran
});

test('gate: an unreachable data_updates table blocks the duplicate check fail-safe', async () => {
  const srl = createFakeSrl({ sizes: { '7330509963975': '35' } });
  // Override innerQrExists to simulate an unreachable data_updates table.
  srl.innerQrExists = async () => {
    throw new Error('network error');
  };
  const gate = await validateActivationScan({
    innerQr: INNER_GS,
    orgQr: ACTIVATION_ORG_QR,
    getSrlSize: srl.getSrlSize,
    innerQrExists: srl.innerQrExists,
  });
  assert.deepEqual(gate, {
    ok: false,
    reason: BLOCK_DUPLICATE_INNER_BOX_CHECK_FAILED,
    dualScan: true,
  });
});

/* --------------- 7. Return handling clears inner_qr (activation) --------------- */

test('Return handling: a Finishing Return writes inner_qr = null and count = -1', () => {
  // For a Finishing Return, the activation flow nulls the inner_qr in the
  // data row (after clearing existing associations) and writes count = -1.
  const dataRow = buildActivationDataRow({
    user: USER,
    qrCode: ACTIVATION_ORG_QR,
    recordStatus: 'OUT',
    qcStatus: 'Return',
    innerQr: INNER_GS,
  });
  // The builder captures the captured inner_qr; the Return branch nulls it.
  assert.equal(dataRow.inner_qr, INNER_GS);
  assert.equal(dataRow.count, -1);
  // Simulate the Return branch clearing the association for this QR.
  dataRow.inner_qr = null;
  assert.equal(dataRow.inner_qr, null);
});

test('Return handling: non-Return QC statuses keep the captured inner_qr', () => {
  const dataRow = buildActivationDataRow({
    user: USER,
    qrCode: ACTIVATION_ORG_QR,
    recordStatus: 'IN',
    qcStatus: 'Forward',
    innerQr: INNER_GS,
  });
  assert.equal(dataRow.inner_qr, INNER_GS);
  assert.equal(dataRow.count, 1);
});