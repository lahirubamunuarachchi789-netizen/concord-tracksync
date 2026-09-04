// ============================================================
// Concord TrackSync - QR Activation department-sequence guard (pure)
//
// Downstream Department Sequence Guard for the QR Activation flow.
// Mirrors Rule 5 of the Standard Transactions guards: the immediately
// following department in the configured sequence (Next Department)
// MUST have a net count of exactly 0 for the scanned org_qr. A non-zero
// downstream net means the item has already been processed downstream
// and the current activation is blocked until the next department is
// cleared (Undo/Return).
//
// This file is dependency-free (pure decision logic) so it can be
// unit-tested under the plain-node runner. The Supabase lookups
// (departments + net counts) live in the service layer.
// ============================================================

/** Rule 5 message - must match the standard-transaction wording. */
export const BLOCK_DOWNSTREAM_DEPT =
  'Scan blocked — This item has already been processed in the next department ({Next Department Name})! Undo/Return the next department first!';

/**
 * Resolve the downstream department(s) for a user's department from the
 * departments mapping rows. Mirrors `resolveDepartmentContext` in
 * transactionGuards.js but returns only the next-sequence departments.
 *
 * @param {Array<{department: string, sequence: number}>} rows
 * @param {string} userDepartment
 * @returns {{found: boolean, nextDepartments: string[]}}
 */
export function resolveNextDepartments(rows, userDepartment) {
  const wanted = String(userDepartment || '').trim().toLowerCase();
  if (!wanted) {
    return { found: false, nextDepartments: [] };
  }
  const mapped = (rows || []).filter(
    (row) => row && row.department != null && row.sequence != null
  );
  const current = mapped.find(
    (row) => String(row.department).trim().toLowerCase() === wanted
  );
  if (!current) {
    return { found: false, nextDepartments: [] };
  }
  const currentSeq = Number(current.sequence);
  const higher = mapped
    .map((row) => Number(row.sequence))
    .filter((seq) => seq > currentSeq);
  if (higher.length === 0) {
    return { found: true, nextDepartments: [] };
  }
  const nextSeq = Math.min(...higher);
  const nextDepartments = mapped
    .filter((row) => Number(row.sequence) === nextSeq)
    .map((row) => String(row.department));
  return { found: true, nextDepartments };
}

/**
 * Pure decision for the downstream department sequence guard.
 *
 * @param {object} params
 * @param {string[]} params.nextDepartments departments on the next
 *        sequence level (empty = no downstream / final department)
 * @param {number} params.downstreamNet net count sum for org_qr across
 *        the nextDepartments (already fetched by the caller's db adapter)
 * @returns {{allowed: boolean, reason: string|null, downstreamNet: number}}
 *   allowed=true when there is no downstream department OR its net is 0.
 */
export function evaluateDownstreamGuard({ nextDepartments, downstreamNet }) {
  if (!nextDepartments || nextDepartments.length === 0) {
    // No downstream department (final department in the workflow) -
    // the guard is skipped, the scan may proceed.
    return {
      allowed: true,
      reason: null,
      downstreamNet: 0,
    };
  }
  if (Number(downstreamNet) > 0) {
    return {
      allowed: false,
      reason: BLOCK_DOWNSTREAM_DEPT.replace(
        '{Next Department Name}',
        nextDepartments.join(', ')
      ),
      downstreamNet: Number(downstreamNet),
    };
  }
  return {
        allowed: true,
    reason: null,
    downstreamNet: Number(downstreamNet) || 0,
  };
}
