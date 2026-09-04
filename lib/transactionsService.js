'use client';

// ============================================================
// Concord TrackSync - Standard Transactions service
//  * msk          : resolves a scanned MSK QR to its org_qr.
//    ONLY rows with status 'Active' (case-insensitive) resolve -
//    'Packed' / other statuses are ignored (Rule 1 gate).
//  * transactionGuards : strict pre-write validation (Active MSK
//    gate + preceding/current/parallel sequence net count guards
//    + downstream department sequence guard).
//  * data_updates : standard transaction records (qr_code =
//    the resolved org_qr), with a localStorage queue fallback
//    so scanning never blocks the production floor.
//  * Packing Department single-scan mode: the user scans ONLY the
//    Inner Box QR and resolveOrgQrFromInnerBox() resolves its
//    recorded Shoe QR (org_qr) from data_updates first.
// ============================================================

import { supabase } from './supabaseClient.js';
import {
  createSupabaseGuardDb,
  pickActiveMskRow,
  validateStandardScan,
} from './transactionGuards.js';
import { buildStandardTransactionPayload, isFinishingDepartment } from './transactionDualScan.js';

export const MSK_TABLE = 'msk';
export const DATA_UPDATES_TABLE = 'data_updates';

/** Record Status options (dual buttons) */
export const RECORD_STATUSES = ['IN', 'OUT'];

/** QC Status options (six-button grid) */
export const QC_STATUSES = [
  'Forward',
  'B Grade',
  'C Grade',
  'Lab Testing',
  'Return',
  'Reworked',
];

const QUEUE_KEY = 'tracksync_tx_queue';

/* --------------------------- local queue --------------------------- */

function readQueue() {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeQueue(rows) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(rows.slice(-200)));
  } catch {
    /* storage full / unavailable - queue is best-effort */
  }
}

export function getQueuedCount() {
  return readQueue().length;
}

/* --------------------------- msk lookup ---------------------------- */

/** Supabase-backed adapter for the scan guards (built once). */
const guardDb = createSupabaseGuardDb(supabase);

/**
 * Run ALL strict standard-transaction validation rules for one scan:
 *   1. Active-status MSK gate (msk)      -> resolves the org_qr
 *   1b. Dual-Scan Inner Box checks (only when `innerQr` was captured):
 *       V1 blaklader URL token, V2 PO code match, V3 srl_num size match
 *   2. Preceding sequence net count = +1 (departments + data_updates)
 *   3. Prospective net count (current + scan +/-1) in [0, 1]
 *   4. Parallel same-sequence net count = 0 (departments + data_updates)
 * The scan must be blocked (and NOTHING written) whenever this
 * returns { ok: false } - `reason` carries the exact toast text and
 * `dualScan: true` marks failures of the Inner Box pair checks.
 *
 * @param {string|null} scannedQr raw scanned MSK QR (Shoe QR). Pass
 *        null in Packing single-scan lookup mode (the orgQr is
 *        pre-resolved instead).
 * @param {{department?: string}} user logged-in session user
 * @param {string|null} [innerQr] captured Inner Box QR or null
 * @param {string|null} [qcStatus] locked QC status. A 'Return' value
 *        bypasses the Duplicate Inner Box Guard (see validateStandardScan).
 * @param {string|null} [orgQr] pre-resolved org_qr for the Packing
 *        Department single-scan mode (resolved from data_updates by the
 *        scanned Inner Box QR). When provided, SKIPS the msk lookup
 *        (Rule 1) AND the Finishing Dual-Scan Inner Box checks (1b) -
 *        the scanned box is already registered in data_updates - and
 *        runs ONLY the sequence / net count / downstream guards
 *        (Rules 2-5) against this org_qr.
 * @returns {Promise<{ok: true, orgQr: string, departmentContext: object} |
 *                    {ok: false, reason: string, offline?: boolean,
 *                     dualScan?: boolean}>}
 */
export function validateStandardTransactionScan(scannedQr, user, innerQr = null, qcStatus = null, orgQr = null) {
  return validateStandardScan({ scannedQr, user, db: guardDb, innerQr, qcStatus, orgQr });
}

/**
 * Duplicate Inner Box Guard for the Standard Transactions flow - true
 * when the captured Inner Box QR already exists in data_updates (a box
 * already paired with a shoe and therefore NOT reusable). Throws when
 * the table cannot be reached - the view blocks the scan fail-safe.
 */
export async function innerQrExistsInDataUpdates(innerQr) {
  return guardDb.innerQrExistsInDataUpdates(innerQr);
}

/**
 * Return handling for Finishing departments (01-03): clear/nullify the
 * inner_qr association in data_updates for the given org QR code so the
 * Inner Box QR can be reused in future scans. No-op when no row matches.
 */
export async function clearInnerQrForOrgQr(orgQr, client = supabase) {
  const { error } = await client
    .from(DATA_UPDATES_TABLE)
    .update({ inner_qr: null })
    .eq('qr_code', orgQr)
    .not('inner_qr', 'is', null);
  if (error) throw error;
}

/**
 * Resolve a scanned MSK QR to its org_qr via the msk mapping table.
 * STRICT: only rows whose status is 'Active' (case-insensitive)
 * resolve - 'Packed' and other non-Active statuses are ignored, so a
 * packed QR is reported as not found (Rule 1 gate).
 * @returns {Promise<{found: boolean, orgQr: string|null, offline: boolean, active: boolean}>}
 */
export async function lookupOrgQr(scannedQr) {
  const value = String(scannedQr || '').trim();
  if (!value) return { found: false, orgQr: null, offline: false, active: false };
  try {
    const { data, error } = await supabase
      .from(MSK_TABLE)
      .select('org_qr, status')
      .eq('msk_qr', value);
    if (error) throw error;
    const active = pickActiveMskRow(data);
    const org = active?.org_qr || null;
    return {
      found: Boolean(org),
      orgQr: org ? String(org) : null,
      offline: false,
      active: Boolean(org),
    };
  } catch {
    // Table missing / RLS / network - the mapping is unreachable.
    return { found: false, orgQr: null, offline: true, active: false };
  }
}

/* ------------------------- create transaction ---------------------- */

/**
 * Build the exact data_updates payload for a standard transaction.
 * `count` is -1 for Return and 1 for every other QC status.
 * `innerQr` carries the Inner Box QR captured by the Dual-Scan process
 * (Finishing departments) and is null for single scans (bypassed QC
 * statuses / non-Finishing departments).
 */
export function buildTransactionPayload(user, orgQr, recordStatus, qcStatus, innerQr = null) {
  return buildStandardTransactionPayload({
    user,
    orgQr,
    recordStatus,
    qcStatus,
    innerQr,
  });
}

/* ------------- Packing single-scan Inner Box lookup ---------------- */

/** Exact toast title for an unlinked Inner Box scan in Packing mode. */
export const PACKING_UNLINKED_INNER_BOX_TITLE = 'Unlinked Inner Box';

/** Exact toast message for an unlinked Inner Box scan in Packing mode. */
export const PACKING_UNLINKED_INNER_BOX_MESSAGE =
  'This Inner Box QR has no recorded Shoe QR in the system.';

/** Honest offline message when data_updates cannot be reached (Packing mode). */
export const PACKING_LOOKUP_OFFLINE_MESSAGE =
  'The data_updates table could not be reached - check your connection and try again.';

/**
 * Resolve the Shoe QR (org_qr) from the data_updates table using the
 * scanned Inner Box QR. Used exclusively by the Packing Department's
 * single-scan lookup mode: the user scans ONLY the Inner Box QR (no
 * Dual-Scan pair, no msk gate) and its recorded partner Shoe QR is
 * resolved automatically.
 *
 * When a box has been re-paired over its lifetime the LATEST
 * association wins (rows are ordered by created_at descending).
 * The scan is blocked fail-safe whenever the link cannot be proven -
 * an unreachable table is reported via `offline: true` so the view can
 * show an honest message instead of the "unlinked box" text.
 *
 * @param {string} innerQr scanned Inner Box QR
 * @param {object} [client] Supabase client (dependency-injected for
 *        tests; defaults to the app-wide singleton)
 * @returns {Promise<{found: boolean, orgQr: string|null, offline: boolean}>}
 */
export async function resolveOrgQrFromInnerBox(innerQr, client = supabase) {
  const inner = String(innerQr || '').trim();
  if (!inner) return { found: false, orgQr: null, offline: false };
  try {
    const { data, error } = await client
      .from(DATA_UPDATES_TABLE)
      .select('qr_code')
      .eq('inner_qr', inner)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    const orgQr = data?.[0]?.qr_code ?? null;
    return {
      found: Boolean(orgQr),
      orgQr: orgQr ? String(orgQr) : null,
      offline: false,
    };
  } catch {
    // Table missing / RLS / network - the link cannot be proven, so
    // the scan is blocked fail-safe (same policy as the msk gate).
    return { found: false, orgQr: null, offline: true };
  }
}

/* ----------------- Packing msk lifecycle trigger ------------------- */

/** The exact department name that runs the single-scan Packing flow. */
export const PACKING_DEPARTMENT = 'Packing';

/**
 * Exact-name check mirroring the view's Packing single-scan gate
 * (`userRef.current?.department === 'Packing'`). Departments are
 * registered byte-for-byte from the departments table, so the trigger
 * fires exactly when the view entered Packing mode.
 */
export function isPackingDepartment(department) {
  return department === PACKING_DEPARTMENT;
}

/**
 * Update the lifecycle status of the msk row for one Shoe QR (org_qr).
 *
 * The `msk` table maps `msk_qr -> org_qr` with a `status` column that
 * gates every standard scan (Rule 1): ONLY 'Active' rows resolve.
 * The value stored in `data_updates.qr_code` for a shoe IS its org_qr,
 * so the row is addressed by `msk.org_qr = orgQr`.
 *
 * @param {string} orgQr the Shoe QR (org_qr) to re-status
 * @param {'Active'|'Packed'} status the new lifecycle status
 * @param {object} [client] Supabase client (dependency-injected for
 *        tests; defaults to the app-wide singleton)
 * @returns {Promise<{updated: boolean, rows: number, reason?: string}>}
 *          THROWS when the msk table cannot be reached - callers decide
 *          how a failure blocks (this trigger treats it as non-fatal).
 */
export async function updateMskStatusForOrgQr(orgQr, status, client = supabase) {
  const value = String(orgQr || '').trim();
  if (!value) return { updated: false, rows: 0, reason: 'missing-org-qr' };
  const { data, error } = await client
    .from(MSK_TABLE)
    .update({ status })
    .eq('org_qr', value)
    .select('id');
  if (error) throw error;
  return { updated: true, rows: data?.length ?? 0 };
}

/**
 * Automatic msk lifecycle trigger for the Packing Department. Called
 * right after a Packing transaction has been SAVED to data_updates:
 *
 *   Packing net count AFTER the save = +1  ->  msk.status = 'Packed'
 *     (the shoe is fully packed - no further floor scans allowed)
 *   Packing net count AFTER the save =  0  ->  msk.status = 'Active'
 *     (a Return/Undo reverted the packing - the shoe scans again)
 *
 * Any other net cannot occur right after a successful write (the Rule 3
 * prospective guard keeps the net within [0, 1]) - msk is left untouched.
 * This function NEVER throws: the transaction is already saved, so a
 * failed status sync is reported non-fatally instead of queueing the
 * record a second time.
 *
 * @param {{department?: string, username?: string}} user the session
 *        user whose department gates the trigger (Packing ONLY)
 * @param {string} orgQr the resolved Shoe QR of the saved transaction
 * @param {object} [client] Supabase client (dependency-injected for
 *        tests; defaults to the app-wide singleton)
 * @returns {Promise<{triggered: boolean, reason?: string, net?: number,
 *                    status?: 'Packed'|'Active', updated?: boolean,
 *                    rows?: number, error?: string}>}
 */
export async function syncMskStatusForPackingTransaction(user, orgQr, client = supabase) {
  const department = user?.department;
  if (!isPackingDepartment(department)) {
    // Non-Packing departments must NEVER mutate msk.status.
    return { triggered: false, reason: 'not-packing' };
  }
  const value = String(orgQr || '').trim();
  if (!value) return { triggered: false, reason: 'missing-org-qr' };

  // Net count in the Packing department AFTER the just-saved record.
  let net;
  try {
    net = await createSupabaseGuardDb(client).getNetCount(value, [department]);
  } catch (err) {
    // data_updates unreachable - the new net cannot be proven, so msk
    // is left untouched (fail-safe, same policy as the scan guards).
    return {
      triggered: false,
      reason: 'net-count-unavailable',
      error: err?.message || String(err),
    };
  }

  let status = null;
  if (net === 1) status = 'Packed';
  else if (net === 0) status = 'Active';
  else return { triggered: false, reason: 'unexpected-net-count', net };

  try {
    const res = await updateMskStatusForOrgQr(value, status, client);
    return { triggered: true, net, status, updated: res.updated, rows: res.rows };
  } catch (err) {
    // msk unreachable - non-fatal: the transaction stays saved and the
    // next successful Packing scan for this shoe retries the sync.
    return {
      triggered: true,
      net,
      status,
      updated: false,
      error: err?.message || String(err),
    };
  }
}

/**
 * Persist one standard transaction to data_updates using the org_qr
 * resolved from the msk mapping (validateStandardTransactionScan must
 * run first). `innerQr` is the Dual-Scan Inner Box QR or null.
 * @returns {Promise<{ok: boolean, status: 'synced'|'queued'|'failed', row: object, error?: string, mskStatus?: object}>}
 */
export async function createTransaction(user, orgQr, recordStatus, qcStatus, innerQr = null, client = supabase) {
  const payload = buildTransactionPayload(user, orgQr, recordStatus, qcStatus, innerQr);

  // Return handling for Finishing departments (01-03): instead of storing
  // the inner_qr association, clear/nullify it in data_updates for this
  // org QR so the Inner Box QR can be reused in future scans. The Return
  // record itself is written with inner_qr = null.
  if (qcStatus === 'Return' && innerQr && isFinishingDepartment(user?.department)) {
    await clearInnerQrForOrgQr(orgQr);
    payload.inner_qr = null;
  }

  // Local-only dedup key: data_updates has a serial id and no
  // client_ref column, so this never travels to the database.
  const clientRef = crypto.randomUUID();

  let result;
  try {
    const { error } = await client.from(DATA_UPDATES_TABLE).insert([payload]);
    if (error) throw error;
    result = { ok: true, status: 'synced', row: { ...payload, client_ref: clientRef } };
  } catch (err) {
    // Queue locally - surface an honest but non-blocking message.
    const queue = readQueue();
    queue.push({ client_ref: clientRef, payload });
    writeQueue(queue);
    const offline =
      err?.message?.includes('fetch') || err?.message?.includes('network');
    result = {
      ok: true,
      status: 'queued',
      row: { ...payload, client_ref: clientRef },
      error: offline
        ? 'Network unavailable - saved on this device and queued for sync.'
        : `Saved on this device (server said: ${err.message || 'rejected'}).`,
    };
  }

  // AUTOMATIC msk LIFECYCLE TRIGGER (Packing Department only): right
  // after the record is SAVED, a Packing net of +1 marks the msk row
  // 'Packed' and a net back at 0 reverts it to 'Active'. Runs ONLY for
  // actually-synced records (a queued record is not in the DB yet - the
  // trigger fires when the queue flushes instead) and is placed AFTER
  // the insert try/catch so an msk failure can never re-route an
  // already-saved transaction into the offline queue (a duplicate on
  // flush). Non-Packing departments never reach this call, and the
  // sync itself never throws.
  if (result.status === 'synced' && isPackingDepartment(user?.department)) {
    result.mskStatus = await syncMskStatusForPackingTransaction(user, orgQr, client);
  }

  return result;
}

/** Try to flush queued transactions to Supabase. Safe to call often. */
export async function retryQueuedTransactions() {
  const queue = readQueue();
  if (queue.length === 0) return { flushed: 0, remaining: 0 };
  const remaining = [];
  let flushed = 0;
  let dropped = 0;
  for (const entry of queue) {
    // v2 queue entries are { client_ref, payload }; v1 entries were
    // bare rows for the deprecated "Transactions" table - convert
    // them through the msk mapping or drop them if unresolvable.
    let payload = entry?.payload;
    if (!payload) {
      const lookup = await lookupOrgQr(entry?.qr_value);
      if (!lookup.found) {
        dropped += 1;
        continue;
      }
      payload = buildTransactionPayload(
        { username: entry.Username, department: entry.Department },
        lookup.orgQr,
        entry.RecordStatus,
        entry.QCStatus
      );
    }
    try {
      const { error } = await supabase.from(DATA_UPDATES_TABLE).insert([payload]);
      if (error) throw error;
      flushed += 1;
      // AUTOMATIC msk LIFECYCLE TRIGGER (Packing Department only): a
      // queued record only lands in the DB here, so this is the moment
      // its Packing net actually changes - a +1 net marks the msk row
      // 'Packed', a net back at 0 reverts it to 'Active'. Non-Packing
      // payloads never reach the sync, and a failure here must NOT
      // re-queue the already-saved record - syncMskStatusForPacking-
      // Transaction never throws.
      if (isPackingDepartment(payload?.department)) {
        await syncMskStatusForPackingTransaction(
          { username: payload.created_by, department: payload.department },
          payload.qr_code
        );
      }
    } catch {
      remaining.push(entry);
    }
  }
  writeQueue(remaining);
  return { flushed, remaining: remaining.length, dropped };
}

/* ----------------------------- read rows --------------------------- */

/** Recent transactions: live data_updates rows merged with the local queue. */
export async function getRecentTransactions(limit = 25) {
  const queued = readQueue();
  const list = queued.map((entry, index) => ({
    ...(entry?.payload || entry),
    client_ref: entry?.client_ref || `queued-${index}`,
    _source: 'queued',
  }));
  try {
    const { data, error } = await supabase
      .from(DATA_UPDATES_TABLE)
      .select(
        'qr_code, inner_qr, record_status, qc_status, department, count, created_by, created_at'
      )
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    const known = new Set(
      list.map((r) => `${r.qr_code}|${r.created_at}|${r.record_status}|${r.qc_status}`)
    );
    for (const row of data || []) {
      const key = `${row.qr_code}|${row.created_at}|${row.record_status}|${row.qc_status}`;
      if (!known.has(key)) list.push({ ...row, _source: 'synced' });
    }
  } catch {
    /* table missing / RLS / offline - local queue only */
  }
  return list
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
}