'use client';

// ============================================================
// Concord TrackSync - QR Activation service
//  * PO             : PO list management (fetch / add / delete)
//    on the Supabase table `PO` (column `PO`).
//  * pod            : MQC lookup for the selected PO (+ size).
//  * data_updates   : instant auto-submitted scan records carrying the
//    formatted qr_code string `;mqc;po;size;scan;`. Dual-Scan pairs
//    (Finishing departments) additionally store the captured
//    `inner_qr` - the full standard transaction field set.
//  * msk            : duplicate guard + lifecycle status. Every valid
//    activation writes a row marking the QR as used (standard shoe
//    activation data ONLY, never inner_qr); a scan whose formatted
//    string already exists in org_qr is blocked before anything is
//    written. Activation is gated on the msk lifecycle status:
//    an msk row with status 'Packed' may be activated, a row with
//    any other status blocks (checkActivationMskStatus) - a QR with
//    NO msk row at all is allowed through.
// ============================================================

import { supabase } from './supabaseClient.js';
import {
  createSupabaseGuardDb,
  DEPARTMENTS_TABLE,
} from './transactionGuards.js';
import {
  buildActivationDataRow,
  buildActivationMskRow,
  evaluateActivationStatus,
  BLOCK_STATUS_UNREACHABLE,
} from './qrActivationDualScan.js';
import { isBannedStatus, BLOCK_QR_BANNED_ACTIVATION } from './qrBanGuard.js';
import { isFinishingDepartment } from './transactionDualScan.js';
import {
  resolveNextDepartments,
  evaluateDownstreamGuard,
  BLOCK_DOWNSTREAM_DEPT,
} from './activationDeptGuard.js';

/** Exact PO table/column names (as configured in Supabase). */
export const PO_TABLE = 'PO';
export const PO_COLUMN = 'PO';
export const POD_TABLE = 'pod';
export const DATA_UPDATES_TABLE = 'data_updates';
export const MSK_TABLE = 'msk';

/** Sizes offered in the quick-select grid (strictly 35 - 50). */
export const SIZES = Array.from({ length: 16 }, (_, i) => 35 + i);

const ACTIVATION_QUEUE_KEY = 'tracksync_activation_queue';

/* ------------------------ purchase orders ------------------------ */

/** Fetch the active PO list, ascending. Throws on failure. */
export async function fetchPurchaseOrders() {
  const { data, error } = await supabase
    .from(PO_TABLE)
    .select(PO_COLUMN)
    .order(PO_COLUMN, { ascending: true });
  if (error) throw error;
  return (data || []).map((r) => String(r[PO_COLUMN])).filter(Boolean);
}

/** Insert a new PO. Returns {ok, duplicate?, error?}. */
export async function addPurchaseOrder(po) {
  const value = String(po || '').trim();
  if (!value) return { ok: false, error: 'PO number cannot be empty.' };
  try {
    const { error } = await supabase.from(PO_TABLE).insert([{ [PO_COLUMN]: value }]);
    if (error) throw error;
    return { ok: true, po: value };
  } catch (err) {
    const raw = String(err?.message || err || '');
    if (err?.code === '23505' || /duplicate key|unique/i.test(raw)) {
      return { ok: false, duplicate: true, error: `PO "${value}" already exists.` };
    }
    return { ok: false, error: raw || 'Could not save the PO.' };
  }
}

/** Delete a PO by value. Returns {ok, error?}. */
export async function deletePurchaseOrder(po) {
  try {
    const { error } = await supabase
      .from(PO_TABLE)
      .delete()
      .eq(PO_COLUMN, String(po));
    if (error) throw error;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || 'Could not delete the PO.') };
  }
}

/* --------------------------- MQC lookup --------------------------- */

/**
 * Supabase-backed adapter reused for the activation Dual-Scan
 * Validation 3 - the srl_num size lookup (see transactionGuards).
 */
const activationGuardDb = createSupabaseGuardDb(supabase);

/**
 * srl_num size for one 13-digit Inner Box Box Code. Throws when the
 * table cannot be reached - the view blocks the scan fail-safe (the
 * inner size cannot be proven).
 */
export async function fetchSrlSizeForBoxCode(boxCode) {
  return activationGuardDb.getSrlSize(boxCode);
}

/**
 * Duplicate Inner Box Guard for the QR Activation flow - true when the
 * captured Inner Box QR already exists in data_updates (a box already
 * paired with a shoe and therefore NOT reusable). Throws when the
 * table cannot be reached - the view blocks the scan fail-safe.
 */
export async function innerQrExistsInDataUpdates(innerQr) {
  return activationGuardDb.innerQrExistsInDataUpdates(innerQr);
}

/**
 * Return handling for Finishing departments (01-03): clear/nullify the
 * inner_qr association in data_updates for the given QR code so the
 * Inner Box QR can be reused in future scans. No-op when no row matches.
 */
export async function clearInnerQrForQrCode(qrCode, client = supabase) {
  const { error } = await client
    .from(DATA_UPDATES_TABLE)
    .update({ inner_qr: null })
    .eq('qr_code', qrCode)
    .not('inner_qr', 'is', null);
  if (error) throw error;
}

/* --------------------- downstream dept guard -------------------- */

/**
 * Departments mapping ({ department, sequence }) from the departments
 * table. Returns [] when the table is unreachable so the floor keeps
 * working - downstream departments simply cannot be determined.
 */
export async function fetchDepartments() {
  try {
        const { data, error } = await supabase
      .from(DEPARTMENTS_TABLE)
      .select('department, sequence');
    if (error) throw error;
    return (data || []).filter(
      (row) => row && row.department != null && row.sequence != null
    );
  } catch {
    return [];
  }
}

/**
 * Net sum of `count` in data_updates for one org_qr across the given
 * departments (summed in JS). Returns 0 when the table is unreachable.
 */
export async function getNetCountForOrgQr(orgQr, departmentNames) {
  const activationGuardDb = createSupabaseGuardDb(supabase);
  return activationGuardDb.getNetCount(orgQr, departmentNames);
}

/**
 * Downstream Department Sequence Guard (Rule 5) for the QR Activation flow.
 * Resolves the next-sequence departments for the user's department and
 * blocks when their net count for the org_qr is non-zero.
 *
 * @param {string} orgQr formatted shoe qr_code string
 * @param {{department: string}|null} user session user
 * @param {Array} [deptRows] optional pre-fetched departments rows
 * @returns {Promise<{allowed: boolean, reason: string|null}>}
 */
export async function checkDownstreamNetCount(orgQr, user, deptRows) {
  const rows = deptRows && deptRows.length ? deptRows : await fetchDepartments();
  const dept = user?.department;
  const { found, nextDepartments } = resolveNextDepartments(rows, dept);
  if (!found || nextDepartments.length === 0) {
    return { allowed: true, reason: null };
  }
  let downstreamNet = 0;
  try {
    downstreamNet = await getNetCountForOrgQr(orgQr, nextDepartments);
  } catch {
    downstreamNet = 0;
  }
  return evaluateDownstreamGuard({ nextDepartments, downstreamNet });
}

// Pure downstream dept guard - implemented in lib/activationDeptGuard.js
export { evaluateDownstreamGuard, BLOCK_DOWNSTREAM_DEPT };

/**
 * Fetch the MQC for a PO from the `pod` table. Prefers an exact
 * PO + size row (pod is keyed per PO/size), falls back to any row
 * for the PO, and returns '' when nothing matches or the table is
 * unreachable - the semicolon structure stays intact either way.
 */
export async function fetchMqcForPo(po, size, client = supabase) {
  const poValue = String(po || '');
  try {
    if (size) {
      const { data } = await client
        .from(POD_TABLE)
        .select('mqc')
        .eq('po', poValue)
        .eq('size', String(size))
        .limit(1);
      if (data?.[0]?.mqc != null && String(data[0].mqc) !== '') return String(data[0].mqc);
    }
    const { data } = await client.from(POD_TABLE).select('mqc').eq('po', poValue).limit(1);
    if (data?.[0]?.mqc != null) return String(data[0].mqc);
  } catch {
    /* pod missing / RLS / offline - empty MQC fallback */
  }
  return '';
}

/** Build the exact `;mqc;po;size;scan;` string (empty MQC -> leading `;;`). */
export function buildQrCode(mqc, po, size, scannedValue) {
  return `;${mqc ?? ''};${po ?? ''};${size ?? ''};${scannedValue ?? ''};`;
}

/* ----------------------- cut_qty limit guard ----------------------- */

/**
 * Pure: sum the `count` of rows whose qr_code encodes this PO + size
 * (format ";mqc;po;size;scanned;"). Rows for other POs/sizes and
 * unparseable rows are ignored.
 */
export function sumCountsForPoSize(rows, po, size) {
  const poKey = String(po ?? '');
  const sizeKey = String(size ?? '');
  return (rows || []).reduce((sum, row) => {
    const parts = String(row?.qr_code ?? '').split(';');
    // ['', mqc, po, size, scanned, '']
    if (parts.length >= 5 && parts[2] === poKey && parts[3] === sizeKey) {
      return sum + (Number(row?.count) || 0);
    }
    return sum;
  }, 0);
}

/**
 * Current total `count` already recorded in data_updates for the
 * PO + size (most recent 2000 rows). Returns 0 when the table is
 * unreachable - the insert path surfaces any real failure itself.
 */
export async function getActivatedCountSum(po, size) {
  try {
    const { data, error } = await supabase
      .from(DATA_UPDATES_TABLE)
      .select('qr_code, count')
      .order('created_at', { ascending: false })
      .limit(2000);
    if (error) throw error;
    return sumCountsForPoSize(data || [], po, size);
  } catch {
    return 0;
  }
}

/**
 * Exact cut_qty for the selected PO + size from the `pod` table.
 * Returns null when no exact row exists or pod is unreachable -
 * meaning "no limit configured" and the scan is allowed.
 */
export async function fetchCutQtyForPoSize(po, size) {
  const poValue = String(po ?? '');
  const sizeValue = String(size ?? '');
  if (!poValue || !sizeValue) return null;
  try {
    const { data, error } = await supabase
      .from(POD_TABLE)
      .select('cut_qty')
      .eq('po', poValue)
      .eq('size', sizeValue)
      .limit(1);
    if (error) throw error;
    if (data?.[0]?.cut_qty != null) return Number(data[0].cut_qty);
  } catch {
    /* pod missing / RLS / offline - no limit configured */
  }
  return null;
}

// Pure cut_qty count guard - implemented in lib/activationCountGuard.js
// (prospective projected = currentSum + scanCount; zero floor + limit).
export { evaluateCutQtyLimit } from './activationCountGuard.js';

/* --------------------- msk duplicate guard ----------------------- */

/**
 * True when the exact formatted qr_code already exists in msk.org_qr.
 * Returns false when the table is unreachable (offline) so the floor
 * keeps working - the sync re-runs this check before flushing the
 * queue, so a queued scan can never create a duplicate.
 */
export async function isQrActivated(formattedQr, client = supabase) {
  if (!formattedQr) return false;
  try {
    const { data, error } = await client
      .from(MSK_TABLE)
      .select('id')
      .eq('org_qr', formattedQr)
      .limit(1);
    if (error) throw error;
    return Array.isArray(data) ? data.length > 0 : Boolean(data);
  } catch {
    return false;
  }
}

/**
 * Mark a QR as activated: insert { msk_qr, org_qr } into `msk`.
 * The row stores standard shoe activation data (status is left to the
 * DB default 'Active' - the lifecycle is driven by the Packing trigger).
 * Plain insert (no onConflict) - if a unique org_qr index exists a
 * raced duplicate simply lands in the queue and is dropped on sync.
 * @returns {Promise<boolean>} true when the row is in place.
 */
async function writeMskActivation({ msk_qr, org_qr }, client = supabase) {
  try {
    const { error } = await client.from(MSK_TABLE).insert([{ msk_qr, org_qr }]);
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure: rebuild the { msk_qr, org_qr } pair from a legacy queued
 * data_updates row (qr_code ";mqc;po;size;scanned;") so entries saved
 * before the dual-write flow also get their msk marker on sync.
 */
export function mskRowFromDataRow(row) {
  const orgQr = String(row?.qr_code ?? '');
  const parts = orgQr.split(';');
  // ['', mqc, po, size, scanned, '']
  return { msk_qr: parts.length >= 5 ? parts[4] : '', org_qr: orgQr };
}

/* ----------------- msk lifecycle status gate ---------------------- */

/**
 * Current msk lifecycle status for one scanned Shoe QR value.
 * The msk row is addressed by `msk_qr = qrValue` (the raw scanned QR -
 * exactly what activation writes and what the floor mappings use);
 * the latest row wins (id descending) for legacy tables without the
 * unique msk_qr index.
 *
 * @param {string} qrValue raw scanned Shoe QR
 * @param {object} [client] Supabase client (dependency-injected for
 *        tests; defaults to the app-wide singleton)
 * @returns {Promise<{found: boolean, status: string|null, offline: boolean}>}
 *          `offline: true` when the msk table cannot be reached - the
 *          activation blocks fail-safe (the status cannot be proven).
 */
export async function fetchMskStatusForQr(qrValue, client = supabase) {
  const value = String(qrValue || '').trim();
  if (!value) return { found: false, status: null, offline: false };
  try {
    const { data, error } = await client
      .from(MSK_TABLE)
      .select('status')
      .eq('msk_qr', value)
      .order('id', { ascending: false })
      .limit(1);
    if (error) throw error;
    const status = data?.[0]?.status ?? null;
    return {
      found: status != null,
      status: status == null ? null : String(status),
      offline: false,
    };
  } catch {
    // msk missing / RLS / network - the status cannot be proven, so
    // the activation blocks fail-safe (same policy as the scan guards).
    return { found: false, status: null, offline: true };
  }
}

/**
 * Activation status validation: combine the msk status lookup with the
 * pure 'Packed'-only gate (evaluateActivationStatus in
 * qrActivationDualScan.js).
 *
 *   no msk row (msk_qr unknown)    -> null            (activation ALLOWED)
 *   msk.status = 'Packed'          -> null            (activation allowed)
 *   msk.status = 'ban'             -> { reason }      (BANNED - always blocked)
 *   msk.status = 'Active'/other    -> { reason }      (exact block message)
 *   msk table unreachable          -> { reason, offline: true } (fail-safe)
 *
 * A QR that does not exist in the msk table at all (no matching
 * msk_qr row / null status) is allowed to proceed normally; only an
 * EXISTING row with a non-'Packed' status blocks the activation. A
 * BANNED row ('ban' status, set by the QR status search & ban panel)
 * always blocks with the dedicated banned message - checked BEFORE
 * the 'Packed' lifecycle gate so the operator sees the real reason.
 *
 * @param {string} qrValue raw scanned Shoe QR
 * @param {object} [client] Supabase client (dependency-injected for
 *        tests; defaults to the app-wide singleton)
 * @returns {Promise<null | {reason: string, status?: string, offline?: boolean}>}
 */
export async function checkActivationMskStatus(qrValue, client = supabase) {
  const lookup = await fetchMskStatusForQr(qrValue, client);
  if (lookup.offline) {
    // The status cannot be proven - the activation blocks fail-safe
    // instead of activating an unverified QR.
    return { reason: BLOCK_STATUS_UNREACHABLE, offline: true };
  }
  if (!lookup.found) {
    // Condition A: the scanned QR does NOT exist in the msk table
    // (no matching msk_qr row) - allow the activation to proceed
    // normally. Only an existing row's status can block it.
    return null;
  }
  // Condition B (BAN GATE): a row explicitly marked 'ban' freezes the
  // QR - it is rejected with the dedicated banned message BEFORE the
  // 'Packed' lifecycle gate, so no user can enter any data for it
  // through the QR Activation flow (this gate runs inside
  // createActivation before a single write, and the offline queue
  // flush re-checks it at sync time).
  if (isBannedStatus(lookup.status)) {
    return { reason: BLOCK_QR_BANNED_ACTIVATION, status: lookup.status };
  }
  const failure = evaluateActivationStatus(lookup.status);
  return failure ? { ...failure, status: lookup.status } : null;
}

/* -------------------------- activations -------------------------- */

function readQueue() {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(ACTIVATION_QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeQueue(rows) {
  try {
    localStorage.setItem(ACTIVATION_QUEUE_KEY, JSON.stringify(rows.slice(-200)));
  } catch {
    /* storage full / unavailable - queue is best-effort */
  }
}

export function getQueuedActivationCount() {
  return readQueue().length;
}

/**
 * Persist one activation:
 *   0. msk lifecycle status gate - when the scanned QR EXISTS in msk,
 *      its row MUST be in the 'Packed' status; 'Active' or any other
 *      status blocks the scan BEFORE anything is written to either
 *      table. A QR with NO msk row at all is allowed through, and an
 *      unreachable msk table still blocks fail-safe.
 *   1. Duplicate guard - reject when the formatted qr_code already
 *      exists in msk.org_qr (NOTHING is written to either table).
 *   2. Mark `msk` (msk_qr = raw scanned QR, org_qr = formatted string)
 *      FIRST; it is the authoritative duplicate guard for all scans.
 *      Standard shoe activation data ONLY - the Inner Box QR of a
 *      Dual-Scan pair is NEVER written to msk.
 *   3. Insert the data_updates record - ALL transaction fields exactly
 *      as in standard transactions: qr_code (org_qr), inner_qr (the
 *      captured Dual-Scan Inner Box QR, null for single scans),
 *      record_status, qc_status, department, count, created_by,
 *      created_at.
 *   data_updates payload:
 *     qr_code       ";mqc;po;size;scanned;"
 *     inner_qr      Inner Box QR (Dual-Scan pairs) | null
 *     record_status IN | OUT
 *     qc_status     Forward | B Grade | C Grade | Lab Testing | Return | Reworked
 *     created_at    scan timestamp (NOW unless a manual override is passed)
 *     department    logged-in user's department
 *     count         -1 when qc_status is 'Return', otherwise 1
 *     created_by    logged-in user's username
 * @param {string|null} [innerQr] Inner Box QR captured by the
 *        Dual-Scan process (Finishing departments); null for single
 *        scans.
 * @param {string|null} [createdAt] optional manual date & time
 *        override. When null the CURRENT system time (new Date()) is
 *        used - a manual value that cannot be parsed also falls back.
 * @param {object} [client] Supabase client (dependency-injected for
 *        tests; defaults to the app-wide singleton)
 * @returns {Promise<{ok, status: 'synced'|'queued'|'duplicate'|'blocked', reason?, row, qrCode, mqc, error?}>}
 */
export async function createActivation(
  user,
  qrValue,
  po,
  size,
  recordStatus,
  qcStatus,
  innerQr = null,
  createdAt = null,
  client = supabase
) {
  // 0. msk lifecycle status gate: when the scanned QR EXISTS in msk,
  //    activation is allowed ONLY for the 'Packed' status (set
  //    automatically when the shoe's Packing net count hits +1).
  //    'Active' - the default status of an un-activated floor mapping -
  //    and any other status block the scan here, before a single write
  //    happens. A QR with NO msk row at all is ALLOWED through; an
  //    unreachable msk table still blocks fail-safe. Never throws.
  const statusFailure = await checkActivationMskStatus(qrValue, client);
  if (statusFailure) {
    return {
      ok: false,
      status: 'blocked',
      reason: statusFailure.reason,
      row: null,
      qrCode: null,
      mqc: null,
    };
  }

  const mqc = await fetchMqcForPo(po, size, client);
  const qrCode = buildQrCode(mqc, po, size, qrValue);

  // 1. Duplicate guard: this QR has been activated before.
  if (await isQrActivated(qrCode, client)) {
    return { ok: false, status: 'duplicate', duplicate: true, row: null, qrCode, mqc };
  }

  // data_updates: ALL transaction fields, inner_qr included
  // (see buildActivationDataRow in lib/qrActivationDualScan.js).
  const dataRow = buildActivationDataRow({ user, qrCode, recordStatus, qcStatus, innerQr, createdAt });

  // Return handling for Finishing departments (01-03): instead of storing
  // the inner_qr association, clear/nullify it in data_updates for this
  // QR so the Inner Box QR can be reused in future scans. The Return
  // record itself is written with inner_qr = null.
  if (qcStatus === 'Return' && innerQr && isFinishingDepartment(user?.department)) {
    await clearInnerQrForQrCode(qrCode, client);
    dataRow.inner_qr = null;
  }

  // msk: standard shoe activation marking ONLY - never inner_qr
  // (see buildActivationMskRow in lib/qrActivationDualScan.js).
  const mskRow = buildActivationMskRow({ qrValue, qrCode });

  // 2. Mark the activation in `msk` first.
  const marked = await writeMskActivation(mskRow, client);
  if (!marked) {
    // msk unreachable (offline): queue BOTH writes so the sync can
    // re-run the duplicate check before touching the database.
    const queue = readQueue();
    queue.push({ kind: 'activation', data: dataRow, msk: mskRow });
    writeQueue(queue);
    return {
      ok: true,
      status: 'queued',
      row: dataRow,
      qrCode,
      mqc,
      error: 'Network unavailable - saved on this device and queued for sync.',
    };
  }

  // 3. Insert the data_updates record (msk now guards duplicates).
  try {
    // `.select('id')` turns the insert into an atomic
    // INSERT ... RETURNING id - the saved row carries the data_updates
    // primary key so the Recent Activations bin icon can target the
    // EXACT database record for deletion. dataRow itself is NEVER
    // mutated here (the failure branch below queues it for replay).
    const { data: inserted, error } = await client
      .from(DATA_UPDATES_TABLE)
      .insert([dataRow])
      .select('id');
    if (error) throw error;
    return {
      ok: true,
      status: 'synced',
      row: { ...dataRow, id: inserted?.[0]?.id ?? null },
      qrCode,
      mqc,
    };
  } catch (err) {
    // msk is already marked; queue only the data row for the next sync.
    const queue = readQueue();
    queue.push({ kind: 'activation', data: dataRow, msk: null });
    writeQueue(queue);
    const offline = err?.message?.includes('fetch') || err?.message?.includes('network');
    return {
      ok: true,
      status: 'queued',
      row: dataRow,
      qrCode,
      mqc,
      error: offline
        ? 'Network unavailable - saved on this device and queued for sync.'
        : `Saved on this device (server said: ${err.message || 'rejected'}).`,
    };
  }
}

/**
 * Flush queued activations to Supabase. Two queue entry shapes exist:
 *  - v2    { kind: 'activation', data, msk }   (dual-write entries)
 *  - legacy flat data_updates row              (upgraded on sync)
 * The duplicate guard is re-run at sync time: when the QR was already
 * activated (here or on another device) the entry is dropped as
 * skipped instead of being written twice. The BAN GUARD re-runs too:
 * an entry whose msk_qr was banned while queued is dropped as `banned`
 * (and an unprovable ban status keeps the entry queued - fail-safe).
 */
export async function retryQueuedActivations() {
  const queue = readQueue();
  if (queue.length === 0) return { flushed: 0, remaining: 0, skipped: 0, banned: 0 };
  const remaining = [];
  let flushed = 0;
  let skipped = 0;
  let banned = 0;

  for (const entry of queue) {
    const v2 = entry && entry.kind === 'activation' && entry.data;
    const dataRow = v2 ? entry.data : entry;
    const mskRow = v2 ? entry.msk : mskRowFromDataRow(dataRow);

    // BAN GUARD at sync time: a QR banned while its activation sat in
    // the offline queue must never be written. The msk row is
    // addressed by the raw scanned QR (msk_qr - exactly what the
    // search & ban panel updates). Fail-safe: when the ban status
    // cannot be proven (msk unreachable) the entry is KEPT for a
    // later pass instead of being written unverified.
    if (mskRow?.msk_qr) {
      const banLookup = await fetchMskStatusForQr(mskRow.msk_qr);
      if (banLookup.found && isBannedStatus(banLookup.status)) {
        banned += 1;
        continue;
      }
      if (banLookup.offline) {
        remaining.push(entry);
        continue;
      }
    }

    // Already activated? Drop the queued entry - never write twice.
    if (mskRow?.org_qr && (await isQrActivated(mskRow.org_qr))) {
      skipped += 1;
      continue;
    }

    // Mark in msk first; null out msk in the retained entry so a
    // failed data insert on a later pass never writes a 2nd msk row.
    if (mskRow?.org_qr) {
      const marked = await writeMskActivation(mskRow);
      if (!marked) {
        remaining.push(entry);
        continue;
      }
    }

    try {
      const { error } = await supabase.from(DATA_UPDATES_TABLE).insert([dataRow]);
      if (error) throw error;
      flushed += 1;
    } catch {
      remaining.push({ kind: 'activation', data: dataRow, msk: null });
    }
  }

  writeQueue(remaining);
  return { flushed, remaining: remaining.length, skipped, banned };
}

/** Recent activations: live rows from data_updates merged with the local queue. */
export async function getRecentActivations(limit = 25) {
  const queued = readQueue();
  // Unwrap v2 dual-write queue entries ({ kind, data, msk }) so the
  // log renders the plain data_updates row.
  const list = queued.map((entry) =>
    entry && entry.kind === 'activation' && entry.data
      ? { ...entry.data, _source: 'queued' }
      : { ...entry, _source: 'queued' }
  );
  try {
    const { data, error } = await supabase
      .from(DATA_UPDATES_TABLE)
      .select(
        'id, qr_code, inner_qr, record_status, qc_status, department, count, created_by, created_at'
      )
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    const seen = new Set(list.map((r) => `${r.created_at}|${r.qr_code}`));
    for (const row of data || []) {
      const key = `${row.created_at}|${row.qr_code}`;
      if (!seen.has(key)) list.push({ ...row, _source: 'synced' });
    }
  } catch {
    /* table missing / RLS / offline - local queue only */
  }
  return list
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
}
/* --------------------------- delete rows --------------------------- */

/**
 * Remove one pending offline activation from the local queue so a
 * deleted activation can never be re-synced afterwards. Queue entries
 * are v2 dual-write shapes ({ kind, data, msk }) or legacy flat rows.
 * @returns {number} how many pending queue entries were removed
 */
export function removeQueuedActivation(qrCode, createdAt) {
  if (!qrCode) return 0;
  const remaining = readQueue().filter((entry) => {
    const data = entry?.kind === 'activation' ? entry.data : entry;
    return !(data?.qr_code === qrCode && (!createdAt || data?.created_at === createdAt));
  });
  const removed = readQueue().length - remaining.length;
  writeQueue(remaining);
  return removed;
}

/**
 * Delete ONE activation record and revert its msk activation marking
 * (the bin icon on the Recent Activations log of the QR Activation
 * page) - a multi-table cascade:
 *
 *   1. data_updates - the activation record row is deleted, addressed
 *      by its `id` primary key when available (rows saved by
 *      createActivation capture it via INSERT ... RETURNING id),
 *      otherwise by the exact composite of every transaction field
 *      (created_at is the client-side scan timestamp, unique per scan).
 *   2. msk - the activation marking (msk.org_qr = the formatted
 *      ";mqc;po;size;scanned;" string written by createActivation,
 *      backed by the UNIQUE msk_org_qr_key index) is reverted so the
 *      shoe can be scanned / activated again:
 *        a) best effort: the lifecycle status of the marking row is
 *           restored to 'Packed' - the status that allows a fresh
 *           activation. Live tables without the status column reject
 *           this update; that failure is non-fatal by design.
 *        b) the marking row itself is deleted, clearing the
 *           org_qr-existence duplicate guard (isQrActivated).
 *
 * Every delete is VERIFIED: `.select('id')` makes the DELETE return the
 * removed rows, so BOTH a database error AND a silent no-op are
 * reported as an explicit failure. PostgREST resolves an RLS-blocked
 * or not-found DELETE as HTTP 200 with an EMPTY array (`error` stays
 * null!) - without this check the UI would remove the row while the
 * database records survive. A record that only ever lived in the
 * offline queue (never synced) is deleted by removing its pending
 * queue entry; in that case the msk revert is best-effort too (the
 * activation may not have reached msk yet).
 *
 * The cascade is all-or-nothing from the UI's point of view: the item
 * is only removed from the session list when EVERY step succeeds, and
 * any failure is reported through { ok: false, error } - the view opens
 * the centered ErrorModal and the row stays so a retry can complete the
 * cascade. Never throws.
 *
 * @param {object} row the history row to delete (payload fields with an
 *        optional `id`)
 * @param {object} [client] Supabase client (injectable for tests)
 */
export async function deleteActivationRecord(row, client = supabase) {
  const failures = [];
  const qrCode = String(row?.qr_code || '').trim();

  /* ---- 1. data_updates: the activation record itself (VERIFIED) --- */

  let dbDeleted = 0;
  try {
    const query =
      row?.id != null
        ? client.from(DATA_UPDATES_TABLE).delete().eq('id', row.id)
        : client.from(DATA_UPDATES_TABLE).delete().match({
            qr_code: row?.qr_code ?? null,
            inner_qr: row?.inner_qr ?? null,
            record_status: row?.record_status ?? null,
            qc_status: row?.qc_status ?? null,
            department: row?.department ?? null,
            count: row?.count ?? null,
            created_by: row?.created_by ?? null,
            created_at: row?.created_at ?? null,
          });
    // Await the delete response and VERIFY it actually removed a row.
    const { data: deletedRows, error } = await query.select('id');
    if (error) {
      throw new Error(error?.message || String(error));
    }
    dbDeleted = deletedRows?.length ?? 0;
  } catch (err) {
    // The record still exists (or its state is unproven) - keep it in
    // the list and skip the msk revert so a retry can complete the
    // full cascade.
    return {
      ok: false,
      error: `Could not delete the activation record: ${
        err?.message || err || 'unknown error'
      }`,
    };
  }

  /* ---- 2. msk: revert the activation marking ---------------------- */

  if (qrCode) {
    // a) BEST EFFORT status restore to 'Packed' (the re-activatable
    //    status). supabase-js resolves query failures to { error }
    //    instead of throwing, so a legacy table without the status
    //    column simply resolves with an error that is ignored here -
    //    the mark is cleared by the delete below either way.
    await client.from(MSK_TABLE).update({ status: 'Packed' }).eq('org_qr', qrCode);

    // b) Clear the activation mark itself: the marking row is addressed
    //    by org_qr = the formatted qr_code (exactly what the
    //    createActivation duplicate guard checks). VERIFIED - a no-op
    //    here (RLS-blocked DELETE) fails the cascade when the record
    //    actually existed in data_updates.
    try {
      const { data: mskDeleted, error } = await client
        .from(MSK_TABLE)
        .delete()
        .eq('org_qr', qrCode)
        .select('id');
      if (error) {
        throw new Error(error?.message || String(error));
      }
      if (dbDeleted > 0 && (mskDeleted?.length ?? 0) === 0) {
        // The data_updates record existed, so its duplicate-guard
        // marking row must exist too - the no-op means the msk DELETE
        // was silently blocked (missing DELETE policy).
        failures.push(
          'The msk activation mark could not be deleted (no matching row). The database is likely missing the msk DELETE policy (run supabase/qr-activation-schema.sql in the Supabase SQL Editor).'
        );
      }
    } catch (err) {
      failures.push(
        `Could not reset the msk activation mark: ${err?.message || err || 'unknown error'}`
      );
    }
  }

  /* ---- 3. queue cleanup: drop a pending offline copy ---------------- */

  const queueRemoved = removeQueuedActivation(qrCode, row?.created_at);

  /* ---- 4. verdict: explicit success/failure for the ErrorModal ------ */

  if (failures.length > 0) {
    return { ok: false, error: failures.join(' ') };
  }
  if (dbDeleted === 0 && queueRemoved === 0) {
    return {
      ok: false,
      error:
        'No matching activation record was deleted from data_updates. The record may have already been removed, or the database is missing the data_updates DELETE policy (run supabase/qr-activation-schema.sql in the Supabase SQL Editor).',
    };
  }
  return { ok: true, deleted: dbDeleted };
}