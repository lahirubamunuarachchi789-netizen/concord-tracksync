// ============================================================
// Concord TrackSync - QR Ban guard (shared, pure)
//
// A QR can be BANNED from the QR status search & ban panel (QR
// Activation tab): banning writes msk.status = 'ban' for the searched
// msk_qr row. From that moment the QR is frozen - NO user may enter
// any data for it through either flow:
//   * Standard Transactions - validateStandardScan (transactionGuards.js)
//     blocks a banned row in BOTH modes: the scanned msk_qr mode (the
//     rows are already in hand from the Rule 1 lookup) and the Packing
//     single-scan lookup mode (which skips Rule 1, so the ban status
//     is verified directly from msk by the resolved org_qr).
//   * QR Activation - checkActivationMskStatus (qrActivationService.js)
//     blocks with the dedicated banned message BEFORE the 'Packed'
//     lifecycle gate, and the offline queue flushes re-check the ban
//     status so a queued record can never sync after a ban.
//
// This module is pure and dependency-free: status constants, the
// case-insensitive comparison helpers and the exact block messages
// shared by both flows. The database adapters live in
// transactionGuards.js (createSupabaseGuardDb) / qrActivationService.js
// (fetchMskStatusForQr) and the search/ban writes in qrBanService.js.
// ============================================================

/** The exact msk.status value written when a QR is banned. */
export const BANNED_STATUS = 'ban';

/**
 * The msk.status value that marks an active, processable row. The QR
 * status search treats a row as banable ONLY when its status is
 * explicitly 'active' (case-insensitive).
 */
export const ACTIVE_MSK_STATUS = 'active';

/** Case-insensitive status normalizer (trim + lowercase). */
export function normalizeMskStatus(status) {
  return String(status ?? '').trim().toLowerCase();
}

/** True when the status value is the banned status (case-insensitive). */
export function isBannedStatus(status) {
  return normalizeMskStatus(status) === BANNED_STATUS;
}

/** True when the status value is explicitly 'active' (case-insensitive). */
export function isActiveStatus(status) {
  return normalizeMskStatus(status) === ACTIVE_MSK_STATUS;
}

/**
 * Pure: pick the FIRST msk row whose status is 'ban'. Used by the
 * standard transaction guards (scanned msk_qr rows and the Packing
 * lookup mode) so a banned row blocks the scan outright.
 * @param {Array<{msk_qr?: string, org_qr?: string, status?: string}>} rows
 * @returns {{msk_qr: string|null, org_qr: string|null, status: string}|null}
 *          the banned row, or null when none is banned.
 */
export function pickBannedMskRow(rows) {
  for (const row of rows || []) {
    if (isBannedStatus(row?.status)) {
      return {
        msk_qr: row?.msk_qr == null ? null : String(row.msk_qr),
        org_qr: row?.org_qr == null ? null : String(row.org_qr),
        status: String(row.status),
      };
    }
  }
  return null;
}

/**
 * Exact block message for the Standard Transactions flow - a banned QR
 * is rejected no matter which mode scanned it (gun msk_qr scan or the
 * Packing single-scan Inner Box lookup).
 */
export const BLOCK_QR_BANNED_TRANSACTION =
  'Scan blocked — This QR code has been banned and cannot be processed!';

/**
 * Exact block message for the QR Activation flow - fired BEFORE the
 * 'Packed' lifecycle gate so the operator sees the real reason.
 */
export const BLOCK_QR_BANNED_ACTIVATION =
  'Activation Blocked — This QR code has been banned and cannot be activated!';

/**
 * Fail-safe block for the Packing single-scan lookup mode: the ban
 * status of the resolved org_qr cannot be proven (msk unreachable),
 * so the scan blocks instead of writing unverified data.
 */
export const BLOCK_BAN_STATUS_UNREACHABLE =
  'Scan blocked — The ban status of this QR code could not be verified. Please try again!';
