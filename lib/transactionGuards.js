'use client';

// ============================================================
// Concord TrackSync - Standard Transaction scan guards
//
// Strict validation executed on EVERY standard scan before any
// write to data_updates, in this exact order:
//   1. Active-status MSK gate   (msk table)
//      msk_qr -> org_qr is only honored from a row whose status
//      is 'Active' (case-insensitive). 'Packed' / other statuses
//      are ignored -> the scan is blocked when no active row exists.
//   1b. Dual-Scan Inner Box checks (Finishing pairs) - when an Inner
//       Box QR was captured: blaklader URL token check, PO code match
//       and the srl_num size match, all BEFORE the sequence guards.
//   2. Preceding department net count guard (departments +
//      data_updates): for current_seq > 1 the net sum of counts
//      across ALL departments on the highest sequence strictly
//      below current_seq MUST be exactly +1.
//   3. Current department net count guard (data_updates, PROSPECTIVE):
//      the net AFTER this scan (current net + the scan's +/-1
//      increment, -1 for QC Return) MUST stay between 0 and 1
//      inclusive. Return on a +1 net clears it to 0 (allowed);
//      +1 on a +1 net (prospective 2) and Return on a 0 net
//      (prospective -1) are both blocked.
//   4. Parallel sequence mutual exclusion (departments +
//      data_updates): departments sharing the SAME sequence must
//      have a net count of 0 for this org_qr.
//   5. Downstream department sequence guard: the immediately following
//      department(s) in the sequence MUST have a net count of 0 for
//      this org_qr (a non-zero downstream net blocks the scan until
//      the next department is cleared).
//   6. PO + Size Cut Quantity limit guard (pod + data_updates): the
//      prospective department quantity for the scanned item's PO/size
//      (current PO+Size sum + the scan's +/-1 increment) must stay
//      within the pod.cut_qty limit. A missing pod row / null cut_qty
//      blocks fail-closed and an unreachable pod/data_updates blocks
//      fail-safe. Skipped for org_qrs that do not encode a PO + size.
//
// PACKING SINGLE-SCAN LOOKUP MODE (Standard Transactions): the Packing
// Department scans ONLY the Inner Box QR - its Shoe QR (org_qr) is
// resolved from data_updates (inner_qr -> qr_code) before validation
// and handed to validateStandardScan pre-resolved. When `orgQr` is
// provided the msk gate (Rule 1) is skipped, and the Finishing
// Dual-Scan Inner Box checks (1b) are SKIPPED as well: the scanned box
// is by definition already registered in data_updates (exactly how the
// org_qr was resolved), so the Duplicate Inner Box Guard would block
// every valid Packing scan. ONLY the sequence / net count / downstream
// guards (Rules 2-5) run against the resolved org_qr.
//
// The module is dependency-injected (a `db` adapter) so the whole
// ruleset is testable without Supabase or a network. The Supabase
// adapter is built with createSupabaseGuardDb(supabaseClient).
// ============================================================

import {
  extractInnerBoxCode,
  normalizeSizeValue,
  parseOrgQr,
  validateDualScanPair,
} from './transactionDualScan.js';

/** Table names (exact, as configured in Supabase). */
export const MSK_TABLE = 'msk';
export const DEPARTMENTS_TABLE = 'departments';
export const DATA_UPDATES_TABLE = 'data_updates';
export const SRL_NUM_TABLE = 'srl_num';
export const POD_TABLE = 'pod';

/* ------------------------- exact block toasts ---------------------- */

/** Rule 1 - no row with status 'Active' for the scanned MSK QR. */
export const BLOCK_NO_ACTIVE_MSK =
  'Scan blocked — No active MSK QR mapping found!';

/** Rule 2 - previous sequence net count is not exactly +1. */
export const BLOCK_PREVIOUS_SEQ =
  'Scan blocked — Previous department sequence scan is incomplete or net count is not +1!';

/** Rule 3 - this department already holds a net count for the org QR. */
export const BLOCK_CURRENT_SEQ =
  'Scan blocked — QR code has already been scanned in this department (Net count is already +1)!';

/**
 * Rule 3 (0-error) - a negative scan (Return) would drive the
 * current department net count below zero (there is nothing to clear).
 */
export const BLOCK_CURRENT_SEQ_NEGATIVE =
  'Scan blocked — QR code has no Net Count in this department (a Return would drive net count below zero)!';

/** Rule 4 - a parallel department with the same sequence holds a count. */
export const BLOCK_PARALLEL_SEQ =
  'Scan blocked — QR code has an active count in a parallel department with the same sequence!';

/**
 * Rule 5 - downstream department sequence guard: the immediately following
 * department in the configured sequence (Next Department) MUST have a net
 * count of 0 for this org_qr. A non-zero "net count" in the next department
 * means the item has already been processed downstream and the current scan
 * is blocked until the downstream department is cleared.
 */
export const BLOCK_DOWNSTREAM_DEPT =
  'Scan blocked — This item has already been processed in the next department ({Next Department Name})! Undo/Return the next department first!';

/**
 * Additional safety gates beyond the four rules - the guards must be
 * able to PROVE every check before allowing a write, so an unmapped
 * department (or an unreachable departments table) also blocks.
 */
export const BLOCK_DEPARTMENT_UNMAPPED =
  'Scan blocked — Your department is not mapped in the departments table!';
export const BLOCK_DEPARTMENTS_UNREACHABLE =
  'Scan blocked — The departments table could not be reached - try again!';

/**
 * Fail-safe gate for the Dual-Scan size check - when srl_num cannot be
 * reached the inner box size cannot be proven, so the scan blocks.
 */
export const BLOCK_SRL_UNREACHABLE =
  'Scan blocked — The srl_num table could not be reached - size cannot be verified!';

/**
 * Duplicate Inner Box Guard - the captured Inner Box QR already exists
 * in data_updates (a box already paired with a shoe cannot be reused).
 */
export const BLOCK_DUPLICATE_INNER_BOX =
  'Duplicate Inner Box: This Inner Box QR has already been scanned in the system.';

/**
 * Duplicate Inner Box Guard fail-safe - the data_updates table could not
 * be reached for the uniqueness check, so the scan blocks (the duplicate
 * status cannot be proven).
 */
export const BLOCK_DUPLICATE_INNER_BOX_CHECK_FAILED =
  'Scan blocked — Could not verify Inner Box QR uniqueness. Please try again.';

/**
 * Rule 6 - the scan's prospective department PO+Size quantity would
 * exceed the cut_qty limit configured in the pod table. Dynamic so the
 * limit, PO, size, department and the current department quantity are
 * all included for debugging.
 */
export function cutQtyExceededReason({
  cutQty,
  po,
  size,
  department,
  currentDeptPoSizeSum,
}) {
  return `Scan blocked — Exceeds Cut Quantity limit (${cutQty}) for PO ${po} / Size ${size} in ${department} (Current: ${currentDeptPoSizeSum})!`;
}

/**
 * Rule 6 (missing limit) - no pod row (or a null cut_qty) exists for
 * the scanned item's PO + size, so no quantity may be recorded.
 */
export function noCutQtyReason(po, size) {
  return `Scan blocked — No Cut Quantity defined in pod table for PO ${po} / Size ${size}!`;
}

/**
 * Rule 6 fail-safe - the pod or data_updates table could not be reached,
 * so the Cut Quantity cannot be verified and the scan blocks.
 */
export const BLOCK_CUT_QTY_UNREACHABLE =
  'Scan blocked — The pod table could not be reached - Cut Quantity cannot be verified!';

const ACTIVE_STATUS = 'active';

/** Normalize a status value for the case-insensitive Active comparison. */
function normalizeStatus(status) {
  return String(status ?? '').trim().toLowerCase();
}

/* ----------------------------- pure helpers ------------------------ */

/**
 * Rule 1 (pure): pick the row that grants an active mapping.
 * 'Packed' and every other non-Active status is ignored, and the
 * comparison is case-insensitive ('Active', 'ACTIVE', 'active'...).
 * @param {Array<{org_qr?: string, status?: string}>} rows
 * @returns {{org_qr: string}|null} the active row, or null when none.
 */
export function pickActiveMskRow(rows) {
  for (const row of rows || []) {
    if (normalizeStatus(row?.status) === ACTIVE_STATUS && row?.org_qr) {
      return { org_qr: String(row.org_qr) };
    }
  }
  return null;
}

/**
 * Pure: resolve the sequence context for the logged-in user's
 * department from the departments table rows
 * ({ id, department, sequence }).
 *  - currentSeq         : sequence of the user's department
 *  - previousSeq        : HIGHEST sequence strictly below currentSeq
 *                         (sequences may be sparse / non-contiguous)
 *  - previousDepartments: every department on previousSeq
 *  - parallelDepartments: every OTHER department sharing currentSeq
 *  - nextSeq            : LOWEST sequence strictly above currentSeq
 *                         (null when the user is on the final level)
 *  - nextDepartments    : every department on nextSeq
 * @returns {{found: boolean, currentDepartment?: string, currentSeq?: number,
 *            previousSeq?: number|null, previousDepartments?: string[],
 *            parallelDepartments?: string[],
 *            nextSeq?: number|null, nextDepartments?: string[]}}
 */
export function resolveDepartmentContext(departmentRows, userDepartment) {
  const wanted = String(userDepartment || '').trim().toLowerCase();
  if (!wanted) return { found: false };

  const rows = (departmentRows || []).filter(
    (row) => row && row.department != null && row.sequence != null
  );
  const current = rows.find(
    (row) => String(row.department).trim().toLowerCase() === wanted
  );
  if (!current) return { found: false };

  const currentSeq = Number(current.sequence);
  const lower = rows
    .map((row) => Number(row.sequence))
    .filter((seq) => seq < currentSeq);
  const previousSeq = lower.length ? Math.max(...lower) : null;

  const nameOf = (row) => String(row.department);
  const previousDepartments =
    previousSeq == null
      ? []
      : rows.filter((row) => Number(row.sequence) === previousSeq).map(nameOf);
  const parallelDepartments = rows
    .filter(
      (row) =>
        Number(row.sequence) === currentSeq &&
        String(row.department).trim().toLowerCase() !== wanted
    )
    .map(nameOf);
  const higher = rows
    .map((row) => Number(row.sequence))
    .filter((seq) => seq > currentSeq);
  const nextSeq = higher.length ? Math.min(...higher) : null;
  const nextDepartments =
    nextSeq == null
      ? []
      : rows.filter((row) => Number(row.sequence) === nextSeq).map(nameOf);

  return {
    found: true,
    currentDepartment: String(current.department),
    currentSeq,
    previousSeq,
    previousDepartments,
    parallelDepartments,
    nextSeq,
    nextDepartments,
  };
}

/* --------------------------- db adapters --------------------------- */

/**
 * Supabase-backed adapter consumed by validateStandardScan.
 * Every method resolves with data or THROWS when the table cannot be
 * reached (offline / RLS / missing) - the orchestrator decides how a
 * failure blocks the scan.
 * @param {object} supabase a @supabase/supabase-js client
 */
export function createSupabaseGuardDb(supabase) {
  return {
    /** ALL msk rows for the scanned QR (active filtering happens in JS). */
    async listMskRowsByMskQr(mskQr) {
      const { data, error } = await supabase
        .from(MSK_TABLE)
        .select('org_qr, status')
        .eq('msk_qr', mskQr);
      if (error) throw error;
      return data || [];
    },

    /** The full departments mapping ({ id, department, sequence }). */
    async listDepartments() {
      const { data, error } = await supabase
        .from(DEPARTMENTS_TABLE)
        .select('id, department, sequence');
      if (error) throw error;
      return data || [];
    },

    /**
     * Net sum of `count` in data_updates for one org QR across the
     * given departments (summed in JS - the row set for a single
     * org_qr is tiny by design: IN +1 / OUT -1 style records).
     */
    async getNetCount(qrCode, departmentNames) {
      if (!departmentNames || departmentNames.length === 0) return 0;
      const { data, error } = await supabase
        .from(DATA_UPDATES_TABLE)
        .select('count')
        .eq('qr_code', qrCode)
        .in('department', departmentNames);
      if (error) throw error;
      return (data || []).reduce(
        (sum, row) =>
          sum + (Number.isFinite(Number(row?.count)) ? Number(row.count) : 0),
        0
      );
    },

    /**
     * Size stored in srl_num for one 13-digit Inner Box code
     * (null when the row does not exist). Throws when the table
     * cannot be reached - the orchestrator blocks fail-safe.
     */
    async getSrlSize(boxCode) {
      const { data, error } = await supabase
        .from(SRL_NUM_TABLE)
        .select('size')
        .eq('box_num', boxCode)
        .limit(1);
      if (error) throw error;
      return data?.[0]?.size ?? null;
    },

    /**
     * Duplicate Inner Box Guard - true when the captured Inner Box QR
     * already exists in data_updates (a box already paired with a shoe
     * and therefore NOT reusable). Throws when the table cannot be
     * reached - the orchestrator blocks fail-safe.
     */
    async innerQrExistsInDataUpdates(innerQr) {
      const { data, error } = await supabase
        .from(DATA_UPDATES_TABLE)
        .select('id')
        .eq('inner_qr', innerQr)
        .limit(1);
      if (error) throw error;
      return Array.isArray(data) ? data.length > 0 : false;
    },

    /**
     * Rule 6 - exact cut_qty for one PO + size from the pod table.
     * Size matching is case/whitespace-insensitive and numeric-equality
     * tolerant (the same normalizeSizeValue rules the Dual-Scan V3
     * check uses), so a pod row stored as '35.0' or '035' still matches
     * a scanned size of '35'. Returns null when no row matches (or the
     * matched row has a null cut_qty) - the orchestrator blocks when no
     * limit is defined. Throws when the pod table cannot be reached -
     * the orchestrator blocks fail-safe.
     */
    async getCutQtyForPoSize(po, size) {
      const poValue = String(po ?? '').trim();
      if (!poValue) return null;
      const { data, error } = await supabase
        .from(POD_TABLE)
        .select('size, cut_qty')
        .eq('po', poValue);
      if (error) throw error;
      const wanted = normalizeSizeValue(size);
      const row = (data || []).find(
        (r) => r?.cut_qty != null && normalizeSizeValue(r?.size) === wanted
      );
      return row ? Number(row.cut_qty) : null;
    },

    /**
     * Rule 6 - current sum of `count` in data_updates for one department
     * across all rows whose qr_code encodes the same PO + size (the
     * formatted ';mqc;po;size;scanned;' activation string; rows that do
     * not encode the PO + size are ignored). Size matching is case/
     * whitespace-insensitive (normalizeSizeValue), PO matching is exact
     * after trimming. Bounded to the most recent 2000 rows of the
     * department (same bound as the QR Activation count guard). Throws
     * when the table cannot be reached - the orchestrator blocks
     * fail-safe.
     */
    async getDeptPoSizeSum(department, po, size) {
      const dept = String(department ?? '').trim();
      if (!dept) return 0;
      const { data, error } = await supabase
        .from(DATA_UPDATES_TABLE)
        .select('qr_code, count')
        .eq('department', dept)
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) throw error;
      const poValue = String(po ?? '').trim();
      const wantedSize = normalizeSizeValue(size);
      return (data || []).reduce((sum, row) => {
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

/* --------------------------- orchestrator -------------------------- */

/**
 * Run every standard-transaction guard for one scan. NOTHING is
 * written here - the caller only inserts into data_updates when the
 * result is { ok: true }.
 *
 * @param {object} params
 * @param {string} params.scannedQr  raw scanned MSK QR value
 * @param {{department?: string}} params.user logged-in session user
 * @param {object} params.db         adapter (see createSupabaseGuardDb)
 * @param {string|null} [params.innerQr] Inner Box QR captured by the
 *        Dual-Scan process (Finishing departments); null for single
 *        scans - when present, the V1-V3 pair checks run first
 * @param {string|null} [params.qcStatus] locked QC status. When it is
 *        'Return' the Duplicate Inner Box Guard is BYPASSED so the
 *        service layer can clear/nullify the inner_qr association
 *        (a Return reuses the box). V1-V3 still run on Return scans.
 * @param {string|null} [params.orgQr] pre-resolved org_qr for the
 *        Packing single-scan lookup mode (resolved from data_updates
 *        by the scanned Inner Box QR). When provided, Rule 1 (msk
 *        gate) AND rule 1b (V1-V3 pair checks + Duplicate Inner Box
 *        Guard) are SKIPPED - the scanned box is already registered in
 *        data_updates - and ONLY Rules 2-5 run on this org_qr.
 * @returns {Promise<{ok: true, orgQr: string, departmentContext: object} |
 *                    {ok: false, reason: string, offline?: boolean,
 *                     dualScan?: boolean}>}
 */
export async function validateStandardScan({ scannedQr, user, db, innerQr = null, qcStatus = null, orgQr = null }) {
  const scanned = String(scannedQr || '').trim();

  /* ---- Rule 1: Active-status MSK gate ---------------------------- */
  // If an org_qr is pre-resolved (e.g., from data_updates for Packing mode),
  // skip the msk lookup entirely.
  let resolvedOrgQr = orgQr;
  let mskOffline = false;
  
  if (!orgQr) {
    try {
      const rows = await db.listMskRowsByMskQr(scanned);
      const active = pickActiveMskRow(rows);
      resolvedOrgQr = active?.org_qr || null;
    } catch {
      // Table unreachable (network / RLS / missing): no active mapping
      // can be proven, so the scan is blocked under Rule 1.
      mskOffline = true;
    }
    if (!resolvedOrgQr) {
      return { ok: false, reason: BLOCK_NO_ACTIVE_MSK, offline: mskOffline };
    }
  }

  /* ---- Dual-Scan Inner Box checks (V1-V3, Finishing pairs) -------- */
  // SKIPPED for the Packing single-scan lookup mode (`orgQr` was
  // pre-resolved from data_updates by the scanned Inner Box QR): the
  // V1-V3 pair checks and the Duplicate Inner Box Guard belong to the
  // Finishing Dual-Scan process ONLY. In Packing mode the scanned
  // Inner Box QR is by definition already registered in data_updates
  // (it is exactly how the org_qr was resolved), so the duplicate
  // guard would block every valid Packing scan. The requirement is to
  // run ONLY the sequence / net count / downstream guards (Rules 2-5)
  // on the resolved org_qr.
  const packingLookupMode = Boolean(orgQr);
  // Runs whenever an Inner Box QR was captured, BEFORE the sequence
  // guards - a mismatched pair must never reach the net-count checks.
  // V3 needs the srl_num size for the inner 13-digit Box Code; an
  // unreachable srl_num table blocks the scan fail-safe.
  const inner = innerQr == null ? '' : String(innerQr).trim();
  if (inner && !packingLookupMode) {
    let srlSize = null;
    try {
      const boxCode = extractInnerBoxCode(inner);
      srlSize = boxCode ? await db.getSrlSize(boxCode) : null;
    } catch {
      return { ok: false, reason: BLOCK_SRL_UNREACHABLE, dualScan: true };
    }
    const dualFailure = validateDualScanPair({ innerQr: inner, orgQr: resolvedOrgQr, srlSize });
    if (dualFailure) {
      return { ok: false, reason: dualFailure.reason, dualScan: true };
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
        const innerExists = await db.innerQrExistsInDataUpdates(inner);
        if (innerExists) {
          return { ok: false, reason: BLOCK_DUPLICATE_INNER_BOX, dualScan: true };
        }
      } catch {
        // data_updates table unreachable - the duplicate status cannot be
        // proven, so the scan blocks fail-safe.
        return { ok: false, reason: BLOCK_DUPLICATE_INNER_BOX_CHECK_FAILED, dualScan: true };
      }
    }
  }

  /* ---- Resolve the user's department sequence -------------------- */
  let ctx;
  try {
    ctx = resolveDepartmentContext(await db.listDepartments(), user?.department);
  } catch {
    return { ok: false, reason: BLOCK_DEPARTMENTS_UNREACHABLE };
  }
  if (!ctx.found) {
    return { ok: false, reason: BLOCK_DEPARTMENT_UNMAPPED };
  }

  /* ---- Rule 2: preceding department net count guard --------------- */
  // Only enforced above the first sequence level. previous_seq is the
  // HIGHEST sequence strictly below current_seq; the net sum across
  // ALL departments on that level must be exactly +1 (a missing prior
  // scan, or a net 0 caused by a Return, both fail this check).
  if (ctx.currentSeq > 1) {
    const previousNet = await db.getNetCount(resolvedOrgQr, ctx.previousDepartments);
    if (previousNet !== 1) {
      return { ok: false, reason: BLOCK_PREVIOUS_SEQ };
    }
  }

  /* ---- Rule 3: current department net count guard (prospective) */
  // Prospective net-count check: the net AFTER this scan (current + the
  // new scan's +/-1 increment) MUST stay between 0 and 1 inclusive.
  //   Return (-1) on a +1 net clears it to 0       -> allowed (the fix)
  //   Pass  (+1) on a +1 net would push it to +2   -> blocked (+1 error)
  //   Return (-1) on a 0 net would drive it to -1  -> blocked (0 error)
  const increment = qcStatus === 'Return' ? -1 : 1;
  const currentNet = await db.getNetCount(resolvedOrgQr, [ctx.currentDepartment]);
  const prospectiveNet = currentNet + increment;
  if (prospectiveNet > 1) {
    return { ok: false, reason: BLOCK_CURRENT_SEQ };
  }
  if (prospectiveNet < 0) {
    return { ok: false, reason: BLOCK_CURRENT_SEQ_NEGATIVE };
  }

  /* ---- Rule 4: parallel sequence department mutual exclusion ------ */
  // Any OTHER department sharing the exact same sequence holding a
  // net count greater than 0 for this org QR blocks the scan.
  const parallelNet = await db.getNetCount(resolvedOrgQr, ctx.parallelDepartments);
  if (parallelNet > 0) {
    return { ok: false, reason: BLOCK_PARALLEL_SEQ };
  }

  /* ---- Rule 5: downstream department sequence guard --------------- */
  // The immediately following department in the configured sequence
  // (nextDepartments / nextSeq) MUST have a net count of exactly 0 for
  // this org_qr. A non-zero net downstream means the item has already been
  // processed in the next department; the current scan is blocked until
  // the downstream department is cleared (Undo/Return). When there is no
  // next department (final department in the workflow) the check is skipped.
  if (ctx.nextDepartments.length > 0) {
    const downstreamNet = await db.getNetCount(resolvedOrgQr, ctx.nextDepartments);
    if (downstreamNet > 0) {
      const nextName = ctx.nextDepartments.join(', ');
      return {
        ok: false,
        reason: BLOCK_DOWNSTREAM_DEPT.replace('{Next Department Name}', nextName),
      };
    }
  }

  /* ---- Rule 6: PO + Size Cut Quantity limit guard ----------------- */
  // Aggregate production-quantity cap per PO + size in the CURRENT
  // department (pod.cut_qty), enforced for every department including
  // the Packing single-scan mode. Runs ONLY for org_qrs that encode a
  // PO + size (the ';mqc;po;size;' activation format) - plain/legacy
  // org_qrs carry no PO/size and cannot be limit-checked, so the guard
  // skips them. A missing pod row or a null cut_qty blocks fail-closed:
  // no quantity may be recorded without a configured limit. The
  // prospective department quantity (current PO+Size sum + this scan's
  // +/-1 increment, -1 for QC Return) must stay within cut_qty -
  // Returns reduce the sum and pass as long as the other bounds hold.
  const parsedOrg = parseOrgQr(resolvedOrgQr);
  const poValue = parsedOrg.po == null ? '' : String(parsedOrg.po).trim();
  const sizeValue = parsedOrg.size == null ? '' : String(parsedOrg.size).trim();
  if (poValue && sizeValue) {
    let cutQty = null;
    try {
      cutQty = await db.getCutQtyForPoSize(poValue, sizeValue);
    } catch {
      // pod unreachable - the limit cannot be proven, so the scan
      // blocks fail-safe.
      return { ok: false, reason: BLOCK_CUT_QTY_UNREACHABLE };
    }
    if (cutQty == null) {
      // No Cut Quantity configured for this PO + size - the scan is
      // blocked (fail-closed by requirement).
      return { ok: false, reason: noCutQtyReason(poValue, sizeValue) };
    }
    let currentDeptPoSizeSum = 0;
    try {
      currentDeptPoSizeSum = await db.getDeptPoSizeSum(
        ctx.currentDepartment,
        poValue,
        sizeValue
      );
    } catch {
      // data_updates unreachable - the current quantity cannot be
      // proven, so the scan blocks fail-safe.
      return { ok: false, reason: BLOCK_CUT_QTY_UNREACHABLE };
    }
    const prospectiveDeptQty = currentDeptPoSizeSum + increment;
    if (prospectiveDeptQty > cutQty) {
      return {
        ok: false,
        reason: cutQtyExceededReason({
          cutQty,
          po: poValue,
          size: sizeValue,
          department: ctx.currentDepartment,
          currentDeptPoSizeSum,
        }),
      };
    }
  }


  /* ---- All checks passed - caller may write the transaction ------- */
  return { ok: true, orgQr: resolvedOrgQr, departmentContext: ctx };
}