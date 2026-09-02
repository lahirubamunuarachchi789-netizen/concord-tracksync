'use client';

// ============================================================
// Concord TrackSync - QR Activation service
//  * PO             : PO list management (fetch / add / delete)
//    on the Supabase table `PO` (column `PO`).
//  * pod            : MQC lookup for the selected PO (+ size).
//  * data_updates   : instant auto-submitted scan records carrying the
//    formatted qr_code string `;mqc;po;size;scan;`, with a
//    localStorage queue fallback so scanning never blocks the floor.
// ============================================================

import { supabase } from '@/lib/supabaseClient';

/** Exact PO table/column names (as configured in Supabase). */
export const PO_TABLE = 'PO';
export const PO_COLUMN = 'PO';
export const POD_TABLE = 'pod';
export const DATA_UPDATES_TABLE = 'data_updates';

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
 * Persist one activation into `data_updates`:
 *   qr_code       ";mqc;po;size;scanned;"
 *   record_status IN | OUT
 *   qc_status     Forward | B Grade | C Grade | Lab Testing | Return | Reworked
 *   created_at    scan timestamp (NOW())
 *   department    logged-in user's department
 *   count         -1 when qc_status is 'Return', otherwise 1
 *   created_by    logged-in user's username
 * @returns {Promise<{ok, status: 'synced'|'queued'|'failed', row, qrCode, mqc, error?}>}
 */
export async function createActivation(user, qrValue, po, size, recordStatus, qcStatus) {
  const mqc = await fetchMqcForPo(po, size);
  const qrCode = buildQrCode(mqc, po, size, qrValue);
  const row = {
    qr_code: qrCode,
    record_status: recordStatus,
    qc_status: qcStatus,
    created_at: new Date().toISOString(),
    department: user?.department || '-',
    count: qcStatus === 'Return' ? -1 : 1,
    created_by: user?.username || 'unknown',
  };

  try {
    const { error } = await supabase.from(DATA_UPDATES_TABLE).insert([row]);
    if (error) throw error;
    return { ok: true, status: 'synced', row, qrCode, mqc };
  } catch (err) {
    const queue = readQueue();
    queue.push(row);
    writeQueue(queue);
    const offline = err?.message?.includes('fetch') || err?.message?.includes('network');
    return {
      ok: true,
      status: 'queued',
      row,
      qrCode,
      mqc,
      error: offline
        ? 'Network unavailable - saved on this device and queued for sync.'
        : `Saved on this device (server said: ${err.message || 'rejected'}).`,
    };
  }
}

/** Try to flush queued activations to Supabase. Safe to call often. */
export async function retryQueuedActivations() {
  const queue = readQueue();
  if (queue.length === 0) return { flushed: 0, remaining: 0 };
  const remaining = [];
  let flushed = 0;
  for (const row of queue) {
    try {
      const { error } = await supabase.from(DATA_UPDATES_TABLE).insert([row]);
      if (error) throw error;
      flushed += 1;
    } catch {
      remaining.push(row);
    }
  }
  writeQueue(remaining);
  return { flushed, remaining: remaining.length };
}

/** Recent activations: live rows from data_updates merged with the local queue. */
export async function getRecentActivations(limit = 25) {
  const queued = readQueue();
  const list = queued.map((r) => ({ ...r, _source: 'queued' }));
  try {
    const { data, error } = await supabase
      .from(DATA_UPDATES_TABLE)
      .select('id, qr_code, record_status, qc_status, department, count, created_by, created_at')
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