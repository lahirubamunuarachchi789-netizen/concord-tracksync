// ============================================================
// Concord TrackSync - Dual-Scan workflow (Finishing departments)
//
// Pure, dependency-free logic behind the two-scan process in
// /transactions:
//   Scan 1 = Inner Box QR   (captured, no write)
//   Scan 2 = Shoe QR        (validated by the standard guards and
//                            inserted into data_updates together
//                            with the captured inner_qr)
//
// Dual-Scan is enabled ONLY when BOTH hold:
//   1. the logged-in user's department is 'Finishing 01',
//      'Finishing 02' or 'Finishing 03', AND
//   2. the locked QC status is NOT 'B Grade', 'C Grade' or
//      'Lab Testing' (the bypass condition - those statuses revert
//      to the single Shoe QR scan mode, inner_qr = null).
// Comparisons are case-insensitive and whitespace tolerant.
// ============================================================

/** Departments where the Dual-Scan process applies (exact names). */
export const FINISHING_DEPARTMENTS = ['Finishing 01', 'Finishing 02', 'Finishing 03'];

/** QC statuses that bypass Dual-Scan, even inside Finishing departments. */
export const DUAL_SCAN_BYPASS_QC = ['B Grade', 'C Grade', 'Lab Testing'];

/** The two capture stages of a dual-scan pair. */
export const DUAL_SCAN_STAGES = { INNER: 'inner', SHOE: 'shoe' };

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

/** True when the department is one of the Finishing lines. */
export function isFinishingDepartment(department) {
  return FINISHING_DEPARTMENTS.some((name) => norm(name) === norm(department));
}

/** True when the selected QC status bypasses Dual-Scan. */
export function isDualScanQcBypass(qcStatus) {
  return DUAL_SCAN_BYPASS_QC.some((status) => norm(status) === norm(qcStatus));
}

/**
 * Normal Dual-Scan condition: a Finishing department whose QC status
 * is NOT one of the bypass statuses.
 */
export function isDualScanEnabled(department, qcStatus) {
  return isFinishingDepartment(department) && !isDualScanQcBypass(qcStatus);
}

/**
 * Fresh dual-scan state: stage 1 (Inner Box QR) with nothing captured.
 * @param {boolean} enabled
 */
export function createDualScanState(enabled) {
  return { enabled: Boolean(enabled), stage: DUAL_SCAN_STAGES.INNER, innerQr: null };
}

/**
 * Pure step: route ONE scanned code through the dual-scan state.
 *
 * Returns { next, submitCode, innerQrForSubmit }:
 *  - Dual-Scan active, stage 1  -> next = stage 2 + captured innerQr,
 *    submitCode = null (nothing recorded yet).
 *  - Dual-Scan active, stage 2  -> submitCode = the Shoe QR,
 *    innerQrForSubmit = the captured Inner Box QR; next is RESET to a
 *    fresh stage-1 state for the next pair.
 *  - Dual-Scan disabled (bypass / non-Finishing) -> single Shoe QR
 *    mode: submitCode = the code immediately, innerQrForSubmit = null
 *    (any stale captured inner is dropped).
 */
export function applyDualScanScan(state, scannedCode) {
  const code = String(scannedCode || '').trim();
  if (!state?.enabled) {
    return {
      next: createDualScanState(false),
      submitCode: code,
      innerQrForSubmit: null,
    };
  }
  if (state.stage === DUAL_SCAN_STAGES.INNER) {
    return {
      next: { enabled: true, stage: DUAL_SCAN_STAGES.SHOE, innerQr: code },
      submitCode: null,
      innerQrForSubmit: null,
    };
  }
  return {
    next: createDualScanState(true),
    submitCode: code,
    innerQrForSubmit: state.innerQr,
  };
}

/**
 * Build the exact data_updates payload for one standard transaction.
 * `inner_qr` carries the Inner Box QR captured in Dual-Scan mode and
 * is null for single scans (bypassed QC statuses / non-Finishing).
 * `count` is -1 for Return and 1 for every other QC status.
 */
export function buildStandardTransactionPayload({
  user,
  orgQr,
  recordStatus,
  qcStatus,
  innerQr = null,
}) {
  const trimmedInner = innerQr == null ? '' : String(innerQr).trim();
  return {
    qr_code: orgQr,
    inner_qr: trimmedInner || null,
    record_status: recordStatus,
    qc_status: qcStatus,
    department: user?.department || '-',
    count: qcStatus === 'Return' ? -1 : 1,
    created_by: user?.username || 'unknown',
    created_at: new Date().toISOString(), // scan timestamp (NOW)
  };
}