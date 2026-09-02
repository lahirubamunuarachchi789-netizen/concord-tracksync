'use client';

// ============================================================
// Concord TrackSync - QR Activation service
//  * PO             : PO list management (fetch / add / delete)
//    on the Supabase table `PO` (column `PO`).
//  * qr_activations : instant auto-submitted scan records
//    (qr_value + PO + size), with a localStorage queue fallback
//    so scanning never blocks the production floor.
// ============================================================

import { supabase } from '@/lib/supabaseClient';

/** Exact PO table/column names (as configured in Supabase). */
export const PO_TABLE = 'PO';
export const PO_COLUMN = 'PO';
export const QR_ACTIVATIONS_TABLE = 'qr_activations';

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
 * Persist one activation (qr_value + PO + size + record/QC status).
 * @returns {Promise<{ok: boolean, status: 'synced'|'queued'|'failed', row: object, error?: string}>}
 */
export async function createActivation(user, qrValue, po, size, recordStatus, qcStatus) {
  const row = {
    qr_value: qrValue,
    po,
    size,
    record_status: recordStatus,
    qc_status: qcStatus,
    username: user?.username || 'unknown',
    department: user?.department || '-',
    client_ref: crypto.randomUUID(),
    created_at: new Date().toISOString(),
  };

  try {
    const { error } = await supabase.from(QR_ACTIVATIONS_TABLE).insert([row], {
      // Idempotency: a retried sync must not duplicate the activation.
      onConflict: 'client_ref',
      ignoreDuplicates: true,
    });
    if (error) throw error;
    return { ok: true, status: 'synced', row };
  } catch (err) {
    const queue = readQueue();
    queue.push(row);
    writeQueue(queue);
    const offline = err?.message?.includes('fetch') || err?.message?.includes('network');
    return {
      ok: true,
      status: 'queued',
      row,
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
      const { error } = await supabase
        .from(QR_ACTIVATIONS_TABLE)
        .insert([row], { onConflict: 'client_ref', ignoreDuplicates: true });
      if (error) throw error;
      flushed += 1;
    } catch {
      remaining.push(row);
    }
  }
  writeQueue(remaining);
  return { flushed, remaining: remaining.length };
}

/** Recent activations: live rows from Supabase merged with the local queue. */
export async function getRecentActivations(limit = 25) {
  const queued = readQueue();
  const list = queued.map((r) => ({ ...r, _source: 'queued' }));
  try {
    const { data, error } = await supabase
      .from(QR_ACTIVATIONS_TABLE)
      .select(
        'qr_value, po, size, record_status, qc_status, username, department, client_ref, created_at'
      )
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    const known = new Set(list.map((r) => r.client_ref));
    for (const row of data || []) {
      if (!known.has(row.client_ref)) list.push({ ...row, _source: 'synced' });
    }
  } catch {
    /* table missing / RLS / offline - local queue only */
  }
  return list
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
}