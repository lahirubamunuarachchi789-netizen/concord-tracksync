'use client';

// ============================================================
// Concord TrackSync - Standard Transactions service
//  * msk          : resolves a scanned MSK QR to its org_qr.
//    ONLY rows with status 'Active' (case-insensitive) resolve -
//    'Packed' / other statuses are ignored (Rule 1 gate).
//  * transactionGuards : strict pre-write validation (Active MSK
//    gate + preceding/current/parallel sequence net count guards).
//  * data_updates : standard transaction records (qr_code =
//    the resolved org_qr), with a localStorage queue fallback
//    so scanning never blocks the production floor.
// ============================================================

import { supabase } from '@/lib/supabaseClient';
import {
  createSupabaseGuardDb,
  pickActiveMskRow,
  validateStandardScan,
} from '@/lib/transactionGuards';
import { buildStandardTransactionPayload } from '@/lib/transactionDualScan';

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
 *   3. Current department net count = 0  (data_updates)
 *   4. Parallel same-sequence net count = 0 (departments + data_updates)
 * The scan must be blocked (and NOTHING written) whenever this
 * returns { ok: false } - `reason` carries the exact toast text and
 * `dualScan: true` marks failures of the Inner Box pair checks.
 *
 * @param {string} scannedQr raw scanned MSK QR (Shoe QR)
 * @param {{department?: string}} user logged-in session user
 * @param {string|null} [innerQr] captured Inner Box QR or null
 * @returns {Promise<{ok: true, orgQr: string, departmentContext: object} |
 *                    {ok: false, reason: string, offline?: boolean,
 *                     dualScan?: boolean}>}
 */
export function validateStandardTransactionScan(scannedQr, user, innerQr = null) {
  return validateStandardScan({ scannedQr, user, db: guardDb, innerQr });
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

/**
 * Persist one standard transaction to data_updates using the org_qr
 * resolved from the msk mapping (validateStandardTransactionScan must
 * run first). `innerQr` is the Dual-Scan Inner Box QR or null.
 * @returns {Promise<{ok: boolean, status: 'synced'|'queued'|'failed', row: object, error?: string}>}
 */
export async function createTransaction(user, orgQr, recordStatus, qcStatus, innerQr = null) {
  const payload = buildTransactionPayload(user, orgQr, recordStatus, qcStatus, innerQr);
  // Local-only dedup key: data_updates has a serial id and no
  // client_ref column, so this never travels to the database.
  const clientRef = crypto.randomUUID();

  try {
    const { error } = await supabase.from(DATA_UPDATES_TABLE).insert([payload]);
    if (error) throw error;
    return { ok: true, status: 'synced', row: { ...payload, client_ref: clientRef } };
  } catch (err) {
    // Queue locally - surface an honest but non-blocking message.
    const queue = readQueue();
    queue.push({ client_ref: clientRef, payload });
    writeQueue(queue);
    const offline =
      err?.message?.includes('fetch') || err?.message?.includes('network');
    return {
      ok: true,
      status: 'queued',
      row: { ...payload, client_ref: clientRef },
      error: offline
        ? 'Network unavailable - saved on this device and queued for sync.'
        : `Saved on this device (server said: ${err.message || 'rejected'}).`,
    };
  }
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