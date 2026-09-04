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
//  * msk            : duplicate guard (id, msk_qr, org_qr - no status
//    column). Every valid activation writes a row marking the QR as
//    used (standard shoe activation data ONLY, never inner_qr); a
//    scan whose formatted string already exists in org_qr is
//    blocked before anything is written.
// ============================================================

import { supabase } from '@/lib/supabaseClient';
import { createSupabaseGuardDb } from '@/lib/transactionGuards';
import {
  buildActivationDataRow,
  buildActivationMskRow,
} from '@/lib/qrActivationDualScan';

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
 * Fetch the MQC for a PO from the `pod` table. Prefers an exact
 * PO + size row (pod is keyed per PO/size), falls back to any row
 * for the PO, and returns '' when nothing matches or the table is
 * unreachable - the semicolon structure stays intact either way.
 */
export async function fetchMqcForPo(po, size) {
  const poValue = String(po || '');
  try {
    if (size) {
      const { data } = await supabase
        .from(POD_TABLE)
        .select('mqc')
        .eq('po', poValue)
        .eq('size', String(size))
        .limit(1);
      if (data?.[0]?.mqc != null && String(data[0].mqc) !== '') return String(data[0].mqc);
    }
    const { data } = await supabase.from(POD_TABLE).select('mqc').eq('po', poValue).limit(1);
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

/**
 * Pure limit decision: projected_total = currentSum + scanCount must
 * stay within cut_qty. A null/unknown cut_qty always allows.
 * @returns {{allowed: boolean, currentSum: number, cutQty: number|null, projected: number}}
 */
export function evaluateCutQtyLimit(currentSum, cutQty, scanCount) {
  const projected = (Number(currentSum) || 0) + (Number(scanCount) || 0);
  if (cutQty === null || cutQty === undefined || Number.isNaN(Number(cutQty))) {
    return { allowed: true, currentSum: Number(currentSum) || 0, cutQty: null, projected };
  }
  const limit = Number(cutQty);
  return {
    allowed: projected <= limit,
    currentSum: Number(currentSum) || 0,
    cutQty: limit,
    projected,
  };
}

/* --------------------- msk duplicate guard ----------------------- */

/**
 * True when the exact formatted qr_code already exists in msk.org_qr.
 * Returns false when the table is unreachable (offline) so the floor
 * keeps working - the sync re-runs this check before flushing the
 * queue, so a queued scan can never create a duplicate.
 */
export async function isQrActivated(formattedQr) {
  if (!formattedQr) return false;
  try {
    const { data, error } = await supabase
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
 * The msk table is exactly id / msk_qr / org_qr (no status column).
 * Plain insert (no onConflict) - if a unique org_qr index exists a
 * raced duplicate simply lands in the queue and is dropped on sync.
 * @returns {Promise<boolean>} true when the row is in place.
 */
async function writeMskActivation({ msk_qr, org_qr }) {
  try {
    const { error } = await supabase.from(MSK_TABLE).insert([{ msk_qr, org_qr }]);
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
 *   0. Duplicate guard - reject when the formatted qr_code already
 *      exists in msk.org_qr (NOTHING is written to either table).
 *   1. Mark `msk` (msk_qr = raw scanned QR, org_qr = formatted string)
 *      FIRST; it is the authoritative duplicate guard for all scans.
 *      Standard shoe activation data ONLY - the Inner Box QR of a
 *      Dual-Scan pair is NEVER written to msk.
 *   2. Insert the data_updates record - ALL transaction fields exactly
 *      as in standard transactions: qr_code (org_qr), inner_qr (the
 *      captured Dual-Scan Inner Box QR, null for single scans),
 *      record_status, qc_status, department, count, created_by,
 *      created_at.
 *   data_updates payload:
 *     qr_code       ";mqc;po;size;scanned;"
 *     inner_qr      Inner Box QR (Dual-Scan pairs) | null
 *     record_status IN | OUT
 *     qc_status     Forward | B Grade | C Grade | Lab Testing | Return | Reworked
 *     created_at    scan timestamp (NOW())
 *     department    logged-in user's department
 *     count         -1 when qc_status is 'Return', otherwise 1
 *     created_by    logged-in user's username
 * @param {string|null} [innerQr] Inner Box QR captured by the
 *        Dual-Scan process (Finishing departments); null for single
 *        scans.
 * @returns {Promise<{ok, status: 'synced'|'queued'|'duplicate', row, qrCode, mqc, error?}>}
 */
export async function createActivation(user, qrValue, po, size, recordStatus, qcStatus, innerQr = null) {
  const mqc = await fetchMqcForPo(po, size);
  const qrCode = buildQrCode(mqc, po, size, qrValue);

  // 0. Duplicate guard: this QR has been activated before.
  if (await isQrActivated(qrCode)) {
    return { ok: false, status: 'duplicate', duplicate: true, row: null, qrCode, mqc };
  }

  // data_updates: ALL transaction fields, inner_qr included
  // (see buildActivationDataRow in lib/qrActivationDualScan.js).
  const dataRow = buildActivationDataRow({ user, qrCode, recordStatus, qcStatus, innerQr });
  // msk: standard shoe activation marking ONLY - never inner_qr
  // (see buildActivationMskRow in lib/qrActivationDualScan.js).
  const mskRow = buildActivationMskRow({ qrValue, qrCode });

  // 1. Mark the activation in `msk` first.
  const marked = await writeMskActivation(mskRow);
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

  // 2. Insert the data_updates record (msk now guards duplicates).
  try {
    const { error } = await supabase.from(DATA_UPDATES_TABLE).insert([dataRow]);
    if (error) throw error;
    return { ok: true, status: 'synced', row: dataRow, qrCode, mqc };
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
 * skipped instead of being written twice.
 */
export async function retryQueuedActivations() {
  const queue = readQueue();
  if (queue.length === 0) return { flushed: 0, remaining: 0, skipped: 0 };
  const remaining = [];
  let flushed = 0;
  let skipped = 0;

  for (const entry of queue) {
    const v2 = entry && entry.kind === 'activation' && entry.data;
    const dataRow = v2 ? entry.data : entry;
    const mskRow = v2 ? entry.msk : mskRowFromDataRow(dataRow);

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
  return { flushed, remaining: remaining.length, skipped };
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