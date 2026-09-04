// ============================================================
// Concord TrackSync - QR Activation count guard (pure logic)
//
// Prospective count guard for the QR Activation flow. The count after
// this scan (projected = currentSum + scanCount, where scanCount is
// -1 for QC 'Return' and +1 for every other QC status) must never:
//   - drop below 0  (a Return on an item with no recorded count would
//     drive the total negative - the "0 error"),
//   - exceed the PO/size cut_qty limit (the upper bound - a +1 scan
//     that would overflow the production quantity is blocked).
// A null/unknown cut_qty means "no limit configured" - only the zero
// floor applies.
// ============================================================

/**
 * Pure limit decision: projected_total = currentSum + scanCount.
 * Blocked when projected < 0 (negative flag) or projected > cut_qty.
 * @param {number|string|null} currentSum current total count for the PO/size
 * @param {number|string|null} cutQty production quantity limit (null = none)
 * @param {number|string} scanCount +1 for a normal scan, -1 for a Return
 * @returns {{allowed: boolean, negative: boolean, currentSum: number,
 *            cutQty: number|null, projected: number}}
 */
export function evaluateCutQtyLimit(currentSum, cutQty, scanCount) {
  const base = Number(currentSum) || 0;
  const inc = Number(scanCount) || 0;
  const projected = base + inc;
  // Zero floor: a Return / -1 scan must never drive the PO/size total
  // below 0 (nothing has been recorded for it yet - the "0 error").
  if (projected < 0) {
    return {
      allowed: false,
      negative: true,
      currentSum: base,
      cutQty: cutQty == null ? null : Number(cutQty),
      projected,
    };
  }
  if (cutQty === null || cutQty === undefined || Number.isNaN(Number(cutQty))) {
    return { allowed: true, negative: false, currentSum: base, cutQty: null, projected };
  }
  const limit = Number(cutQty);
  return {
    allowed: projected <= limit,
    negative: false,
    currentSum: base,
    cutQty: limit,
    projected,
  };
}