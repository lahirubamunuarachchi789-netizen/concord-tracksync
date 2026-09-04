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
//   3. Current department net count guard (data_updates): the net
//      sum of counts for this org_qr in the user's own department
//      MUST be 0 before a new scan is accepted.
//   4. Parallel sequence mutual exclusion (departments +
//      data_updates): departments sharing the SAME sequence must
//      have a net count of 0 for this org_qr.
//
// The module is dependency-injected (a `db` adapter) so the whole
// ruleset is testable without Supabase or a network. The Supabase
// adapter is built with createSupabaseGuardDb(supabaseClient).
// ============================================================

import {
  extractInnerBoxCode,
  validateDualScanPair,
} from './transactionDualScan.js';

/** Table names (exact, as configured in Supabase). */
export const MSK_TABLE = 'msk';
export const DEPARTMENTS_TABLE = 'departments';
export const DATA_UPDATES_TABLE = 'data_updates';
export const SRL_NUM_TABLE = 'srl_num';

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

/** Rule 4 - a parallel department with the same sequence holds a count. */
export const BLOCK_PARALLEL_SEQ =
  'Scan blocked — QR code has an active count in a parallel department with the same sequence!';

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
 * @returns {{found: boolean, currentDepartment?: string, currentSeq?: number,
 *            previousSeq?: number|null, previousDepartments?: string[],
 *            parallelDepartments?: string[]}}
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

  return {
    found: true,
    currentDepartment: String(current.department),
    currentSeq,
    previousSeq,
    previousDepartments,
    parallelDepartments,
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
 * @returns {Promise<{ok: true, orgQr: string, departmentContext: object} |
 *                    {ok: false, reason: string, offline?: boolean,
 *                     dualScan?: boolean}>}
 */
export async function validateStandardScan({ scannedQr, user, db, innerQr = null, qcStatus = null }) {
  const scanned = String(scannedQr || '').trim();

  /* ---- Rule 1: Active-status MSK gate ---------------------------- */
  let orgQr = null;
  let mskOffline = false;
  try {
    const rows = await db.listMskRowsByMskQr(scanned);
    const active = pickActiveMskRow(rows);
    orgQr = active?.org_qr || null;
  } catch {
    // Table unreachable (network / RLS / missing): no active mapping
    // can be proven, so the scan is blocked under Rule 1.
    mskOffline = true;
  }
  if (!orgQr) {
    return { ok: false, reason: BLOCK_NO_ACTIVE_MSK, offline: mskOffline };
  }

  /* ---- Dual-Scan Inner Box checks (V1-V3, Finishing pairs) -------- */
  // Runs whenever an Inner Box QR was captured, BEFORE the sequence
  // guards - a mismatched pair must never reach the net-count checks.
  // V3 needs the srl_num size for the inner 13-digit Box Code; an
  // unreachable srl_num table blocks the scan fail-safe.
  const inner = innerQr == null ? '' : String(innerQr).trim();
  if (inner) {
    let srlSize = null;
    try {
      const boxCode = extractInnerBoxCode(inner);
      srlSize = boxCode ? await db.getSrlSize(boxCode) : null;
    } catch {
      return { ok: false, reason: BLOCK_SRL_UNREACHABLE, dualScan: true };
    }
    const dualFailure = validateDualScanPair({ innerQr: inner, orgQr, srlSize });
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
    const previousNet = await db.getNetCount(orgQr, ctx.previousDepartments);
    if (previousNet !== 1) {
      return { ok: false, reason: BLOCK_PREVIOUS_SEQ };
    }
  }

  /* ---- Rule 3: current department net count guard ----------------- */
  // The net sum in the user's own department MUST be 0 before the new
  // scan - anything else means this QR already holds a count here.
  const currentNet = await db.getNetCount(orgQr, [ctx.currentDepartment]);
  if (currentNet !== 0) {
    return { ok: false, reason: BLOCK_CURRENT_SEQ };
  }

  /* ---- Rule 4: parallel sequence department mutual exclusion ------ */
  // Any OTHER department sharing the exact same sequence holding a
  // net count greater than 0 for this org QR blocks the scan.
  const parallelNet = await db.getNetCount(orgQr, ctx.parallelDepartments);
  if (parallelNet > 0) {
    return { ok: false, reason: BLOCK_PARALLEL_SEQ };
  }

  /* ---- All checks passed - caller may write the transaction ------- */
  return { ok: true, orgQr, departmentContext: ctx };
}