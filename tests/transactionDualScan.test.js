import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DUAL_SCAN_STAGES,
  FINISHING_DEPARTMENTS,
  applyDualScanScan,
  buildStandardTransactionPayload,
  createDualScanState,
  isDualScanEnabled,
  isDualScanQcBypass,
  isFinishingDepartment,
} from '../lib/transactionDualScan.js';

/* ------------- condition helpers: department + QC gates ------------- */

test('isFinishingDepartment matches exactly Finishing 01 / 02 / 03', () => {
  assert.deepEqual(FINISHING_DEPARTMENTS, ['Finishing 01', 'Finishing 02', 'Finishing 03']);
  assert.equal(isFinishingDepartment('Finishing 01'), true);
  assert.equal(isFinishingDepartment('Finishing 02'), true);
  assert.equal(isFinishingDepartment('Finishing 03'), true);
});

test('isFinishingDepartment is case-insensitive and whitespace tolerant', () => {
  assert.equal(isFinishingDepartment('finishing 02'), true);
  assert.equal(isFinishingDepartment('  FINISHING 03 '), true);
});

test('isFinishingDepartment rejects every other department', () => {
  assert.equal(isFinishingDepartment('Lasting 01'), false);
  assert.equal(isFinishingDepartment('Upper Line 01'), false);
  assert.equal(isFinishingDepartment('Finishing 04'), false);
  assert.equal(isFinishingDepartment('Finishing'), false);
  assert.equal(isFinishingDepartment(''), false);
  assert.equal(isFinishingDepartment(null), false);
  assert.equal(isFinishingDepartment(undefined), false);
});

test('isDualScanQcBypass matches B Grade / C Grade / Lab Testing', () => {
  assert.equal(isDualScanQcBypass('B Grade'), true);
  assert.equal(isDualScanQcBypass('C Grade'), true);
  assert.equal(isDualScanQcBypass('Lab Testing'), true);
  assert.equal(isDualScanQcBypass('b grade'), true);
  assert.equal(isDualScanQcBypass('  LAB TESTING '), true);
});

test('isDualScanQcBypass accepts every other QC status', () => {
  assert.equal(isDualScanQcBypass('Forward'), false);
  assert.equal(isDualScanQcBypass('Return'), false);
  assert.equal(isDualScanQcBypass('Reworked'), false);
  assert.equal(isDualScanQcBypass(''), false);
  assert.equal(isDualScanQcBypass(null), false);
});

/* ------------------- Normal Dual-Scan condition --------------------- */

test('Normal condition: Finishing department + non-bypass QC enables Dual-Scan', () => {
  for (const department of FINISHING_DEPARTMENTS) {
    for (const qc of ['Forward', 'Return', 'Reworked']) {
      assert.equal(isDualScanEnabled(department, qc), true, `${department} + ${qc}`);
    }
  }
});

test('Bypass condition: B Grade / C Grade / Lab Testing disable Dual-Scan in Finishing', () => {
  for (const department of FINISHING_DEPARTMENTS) {
    for (const qc of ['B Grade', 'C Grade', 'Lab Testing']) {
      assert.equal(isDualScanEnabled(department, qc), false, `${department} + ${qc}`);
    }
  }
});

test('Non-Finishing departments never enable Dual-Scan (any QC status)', () => {
  for (const qc of ['Forward', 'B Grade', 'C Grade', 'Lab Testing', 'Return', 'Reworked']) {
    assert.equal(isDualScanEnabled('Lasting 01', qc), false);
    assert.equal(isDualScanEnabled('Upper Line 02', qc), false);
    assert.equal(isDualScanEnabled(undefined, qc), false);
  }
});

/* ------------------------- stage machine ---------------------------- */

test('createDualScanState starts at stage 1 (Inner) with nothing captured', () => {
  assert.deepEqual(createDualScanState(true), {
    enabled: true,
    stage: DUAL_SCAN_STAGES.INNER,
    innerQr: null,
  });
  assert.equal(createDualScanState(false).enabled, false);
});

test('Dual-Scan scan 1: Inner Box QR is captured, nothing is submitted', () => {
  const state = createDualScanState(true);
  const { next, submitCode, innerQrForSubmit } = applyDualScanScan(state, 'INNER-BOX-001');
  assert.equal(submitCode, null); // no transaction yet
  assert.equal(innerQrForSubmit, null);
  assert.equal(next.enabled, true);
  assert.equal(next.stage, DUAL_SCAN_STAGES.SHOE); // focus shifts to Shoe QR
  assert.equal(next.innerQr, 'INNER-BOX-001');
});

test('Dual-Scan scan 2: Shoe QR submits together with the captured Inner Box QR', () => {
  const state = { enabled: true, stage: DUAL_SCAN_STAGES.SHOE, innerQr: 'INNER-BOX-001' };
  const { next, submitCode, innerQrForSubmit } = applyDualScanScan(state, 'SHOE-QR-77');
  assert.equal(submitCode, 'SHOE-QR-77');
  assert.equal(innerQrForSubmit, 'INNER-BOX-001');
  // Pair recorded - state resets to a fresh stage 1 for the next pair.
  assert.deepEqual(next, createDualScanState(true));
});

test('Bypassed / single mode: every scan submits immediately with inner_qr = null', () => {
  const state = createDualScanState(false);
  const first = applyDualScanScan(state, 'SHOE-QR-77');
  assert.equal(first.submitCode, 'SHOE-QR-77');
  assert.equal(first.innerQrForSubmit, null); // null when bypassed
  assert.equal(first.next.enabled, false); // stays single mode

  // A stale captured Inner (mode switched mid-pair) is dropped, never sent.
  const stale = { enabled: false, stage: DUAL_SCAN_STAGES.SHOE, innerQr: 'OLD-INNER' };
  const second = applyDualScanScan(stale, 'SHOE-QR-78');
  assert.equal(second.submitCode, 'SHOE-QR-78');
  assert.equal(second.innerQrForSubmit, null);
});

test('applyDualScanScan trims scanned codes', () => {
  const { next } = applyDualScanScan(createDualScanState(true), '  INNER-9  ');
  assert.equal(next.innerQr, 'INNER-9');
});

test('full dual flow: two pairs back to back stay in sync', () => {
  let state = createDualScanState(true);
  let step = applyDualScanScan(state, 'INNER-A');
  assert.equal(step.submitCode, null);
  state = step.next;
  step = applyDualScanScan(state, 'SHOE-A');
  assert.equal(step.submitCode, 'SHOE-A');
  assert.equal(step.innerQrForSubmit, 'INNER-A');
  state = step.next; // fresh pair
  step = applyDualScanScan(state, 'INNER-B');
  assert.equal(step.next.innerQr, 'INNER-B');
});

/* ------------------- data_updates payload shape --------------------- */

const USER = { username: 'nimal', department: 'Finishing 01' };

test('payload: Dual-Scan records the captured inner_qr with the transaction', () => {
  const payload = buildStandardTransactionPayload({
    user: USER,
    orgQr: 'ORG-001',
    recordStatus: 'IN',
    qcStatus: 'Forward',
    innerQr: 'INNER-BOX-001',
  });
  assert.equal(payload.qr_code, 'ORG-001');
  assert.equal(payload.inner_qr, 'INNER-BOX-001');
  assert.equal(payload.record_status, 'IN');
  assert.equal(payload.qc_status, 'Forward');
  assert.equal(payload.department, 'Finishing 01');
  assert.equal(payload.count, 1);
  assert.equal(payload.created_by, 'nimal');
  assert.ok(!Number.isNaN(Date.parse(payload.created_at)));
});

test('payload: bypassed / single scans persist inner_qr as null', () => {
  const payload = buildStandardTransactionPayload({
    user: USER,
    orgQr: 'ORG-001',
    recordStatus: 'OUT',
    qcStatus: 'B Grade', // bypass QC status
    innerQr: null,
  });
  assert.equal(payload.inner_qr, null);
  assert.equal(payload.count, 1);
});

test('payload: blank inner values are normalized to null', () => {
  for (const inner of [null, undefined, '', '   ']) {
    const payload = buildStandardTransactionPayload({
      user: USER,
      orgQr: 'ORG-1',
      recordStatus: 'IN',
      qcStatus: 'Forward',
      innerQr: inner,
    });
    assert.equal(payload.inner_qr, null);
  }
});

test('payload: Return keeps its dynamic count of -1', () => {
  const payload = buildStandardTransactionPayload({
    user: USER,
    orgQr: 'ORG-001',
    recordStatus: 'OUT',
    qcStatus: 'Return',
    innerQr: 'INNER-BOX-001',
  });
  assert.equal(payload.count, -1);
  assert.equal(payload.inner_qr, 'INNER-BOX-001');
});

