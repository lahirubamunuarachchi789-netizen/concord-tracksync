// ============================================================
// Concord TrackSync - QR Activation Dual-Scan (Finishing departments)
//
// Pure, dependency-free logic behind the two-scan process in the QR
// Activation tab (/transactions -> QR Activation), identical to the
// Standard Transactions Dual-Scan:
//   Scan 1 = Inner Box QR   (captured, no write)
//   Scan 2 = Shoe QR        (validated V1-V3, then auto-activated)
//
// Data routing on submit (the shoe org_qr is the formatted
// ";mqc;po;size;scanned;" string built from the locked parameters):
//   data_updates : ALL activation fields - qr_code (org_qr),
//                  inner_qr (captured Inner Box QR or null),
//                  record_status, qc_status, department, count,
//                  created_by, created_at - exactly the standard
//                  transaction shape.
//   msk          : standard shoe activation marking ONLY
//                  (msk_qr = raw scanned Shoe QR, org_qr = formatted
//                  string) - inner_qr is NEVER written to msk.
//
// The V1-V3 Inner Box checks are the exact same code path as the
// standard flow (validateDualScanPair in transactionDualScan.js):
//   V1. URL structure - 'http://blaklader.com' substring
//   V2. PO match      - GS1 '10' element code vs the org_qr PO code
//   V3. Size match    - srl_num.size for the 13-digit Box Code vs
//                       the size encoded in the org_qr
//
// msk LIFECYCLE STATUS GATE: a QR may ONLY be activated when its msk
// row is in the 'Packed' lifecycle status (set automatically when the
// shoe's Packing net count hits +1). 'Active' - the default status of
// an un-activated floor mapping - and every other status BLOCK the
// activation (evaluateActivationStatus in this module, enforced by
// createActivation in qrActivationService.js).
// ============================================================

import {
  extractInnerBoxCode,
  validateDualScanPair,
} from './transactionDualScan.js';
import { BLOCK_SRL_UNREACHABLE, BLOCK_DUPLICATE_INNER_BOX, BLOCK_DUPLICATE_INNER_BOX_CHECK_FAILED } from './transactionGuards.js';

/**
 * Build the exact data_updates payload for one QR Activation record.
 * `inner_qr` carries the Inner Box QR captured in Dual-Scan mode and
 * is null for single scans (bypassed QC statuses / non-Finishing
 * departments). `count` is -1 for Return and 1 for every other QC
 * status - identical to buildStandardTransactionPayload.
 */
export function buildActivationDataRow({
  user,
  qrCode,
  recordStatus,
  qcStatus,
  innerQr = null,
}) {
  const trimmedInner = innerQr == null ? '' : String(innerQr).trim();
  return {
    qr_code: qrCode,
    inner_qr: trimmedInner || null,
    record_status: recordStatus,
    qc_status: qcStatus,
    department: user?.department || '-',
    count: qcStatus === 'Return' ? -1 : 1,
    created_by: user?.username || 'unknown',
    created_at: new Date().toISOString(), // scan timestamp (NOW)
  };
}

/**
 * Build the exact msk activation marking row: standard shoe
 * activation data ONLY (msk_qr = raw scanned Shoe QR, org_qr = the
 * formatted ";mqc;po;size;scanned;" string). The Inner Box QR of a
 * Dual-Scan pair must NEVER appear here - msk stays the pure
 * duplicate guard (id / msk_qr / org_qr).
 */
export function buildActivationMskRow({ qrValue, qrCode }) {
  return { msk_qr: qrValue, org_qr: qrCode };
}

/* ====================================================================
 * msk lifecycle status gate (activation requires 'Packed')
 *
 * The msk table carries a lifecycle `status` per QR: 'Active' while the
 * shoe is on the floor (the default) and 'Packed' once its Packing net
 * count hits +1 (automatic Packing trigger). An activation is allowed
 * ONLY for 'Packed' rows - 'Active' and every other status block the
 * scan, so a shoe can be activated exactly once, after packing.
 * ==================================================================== */

/** The ONLY msk status that may be activated (case-insensitive). */
export const REQUIRED_ACTIVATION_STATUS = 'Packed';

/**
 * Exact block message for a non-'Packed' status. The `{status}`
 * placeholder is resolved with the QR's current msk status.
 */
export const BLOCK_NOT_PACKED =
  "Activation Blocked — This QR code is not in 'Packed' status (Current status: {status})!";

/**
 * Fail-safe block when the msk status cannot be verified (msk table
 * unreachable) - the scan blocks instead of activating unverified.
 */
export const BLOCK_STATUS_UNREACHABLE =
  'Activation Blocked — The msk status of this QR code could not be verified. Please try again!';

/** Case-insensitive status comparison helper (trim + lowercase). */
function normalizeStatusValue(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Pure msk status gate for the QR Activation flow: a scan may ONLY be
 * activated when its msk row is in the 'Packed' lifecycle status.
 * 'Active' and every other status block the activation; a missing or
 * blank status (no msk row for the scanned QR) blocks as well and is
 * reported as 'not found'.
 *
 * @param {string|null|undefined} status the QR's current msk.status
 * @returns {null | {reason: string}} null when activation is allowed,
 *          otherwise the exact block message with the {status}
 *          placeholder already resolved.
 */
export function evaluateActivationStatus(status) {
  if (normalizeStatusValue(status) === REQUIRED_ACTIVATION_STATUS.toLowerCase()) {
    return null; // 'Packed' - activation allowed
  }
  const current =
    status == null || String(status).trim() === ''
      ? 'not found'
      : String(status).trim();
  return { reason: BLOCK_NOT_PACKED.replace('{status}', current) };
}

/**
 * Run the Dual-Scan Inner Box validations (V1-V3) plus the Duplicate
 * Inner Box Guard for one activation submit. NOTHING is written here -
 * the caller only continues to the cut_qty guard and the activation
 * inserts when the result is { ok: true }.
 *
 * @param {object} params
 * @param {string|null} params.innerQr  captured Inner Box QR or null
 *        (single scans skip every check and never query srl_num)
 * @param {string} params.orgQr  the shoe org_qr - the formatted
 *        ";mqc;po;size;scanned;" activation string (PO = 2nd, size =
 *        3rd ';' field), so V2/V3 compare against exactly the values
 *        that will be stored
 * @param {Function} params.getSrlSize  async (boxCode) => size|null;
 *        THROWS when the srl_num table cannot be reached - the scan
 *        blocks fail-safe (the size cannot be proven)
 * @param {Function} params.innerQrExists  async (innerQr) => boolean;
 *        true when the Inner Box QR already exists in data_updates.
 *        THROWS when the table cannot be reached - the scan blocks
 *        fail-safe (the duplicate status cannot be proven)
 * @param {string|null} [params.qcStatus] locked QC status. When it is
 *        'Return' the Duplicate Inner Box Guard is BYPASSED so the
 *        service layer can clear/nullify the inner_qr association
 *        (a Return reuses the box). V1-V3 still run on Return scans.
 * @returns {Promise<{ok: true} | {ok: false, reason: string, dualScan: boolean}>}
 */
export async function validateActivationScan({ innerQr, orgQr, getSrlSize, innerQrExists, qcStatus = null }) {
  const inner = innerQr == null ? '' : String(innerQr).trim();
  if (!inner) {
    // Single-scan mode (bypassed QC / non-Finishing): nothing to check.
    return { ok: true };
  }

  // V3 needs the srl_num size for the inner 13-digit Box Code; an
  // unreachable srl_num table blocks the scan fail-safe.
  let srlSize = null;
  try {
    const boxCode = extractInnerBoxCode(inner);
    srlSize = boxCode ? await getSrlSize(boxCode) : null;
  } catch {
    return { ok: false, reason: BLOCK_SRL_UNREACHABLE, dualScan: true };
  }

  // V1 (URL token) + V2 (PO match) + V3 (size match) - the exact same
  // code path the standard transaction guards run for Finishing pairs.
  const failure = validateDualScanPair({ innerQr: inner, orgQr, srlSize });
  if (failure) {
    return { ok: false, reason: failure.reason, dualScan: true };
  }

  // Duplicate Inner Box Guard - the captured Inner Box QR must not
  // already exist in data_updates (a box already paired with a shoe
  // cannot be reused). Runs AFTER the V1-V3 pair checks pass.
  // BYPASSED for QC 'Return': a Return is exactly how a box gets
  // released for reuse - the service layer clears/nullifies the
  // inner_qr association, so a registered box must be allowed
  // through to reach that clearing logic.
  if (qcStatus !== 'Return') {
    try {
      const innerExists = await innerQrExists(inner);
      if (innerExists) {
        return { ok: false, reason: BLOCK_DUPLICATE_INNER_BOX, dualScan: true };
      }
    } catch {
      // data_updates table unreachable - the duplicate status cannot be
      // proven, so the scan blocks fail-safe.
      return { ok: false, reason: BLOCK_DUPLICATE_INNER_BOX_CHECK_FAILED, dualScan: true };
    }
  }
  return { ok: true };
}