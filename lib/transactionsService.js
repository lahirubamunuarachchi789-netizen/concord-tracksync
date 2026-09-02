'use client';

// ============================================================
// Concord TrackSync - Transactions service
// Persists scanned QR events to Supabase ("Transactions" table)
// and falls back to a localStorage queue when the write fails,
// so scanning never blocks the production floor.
// ============================================================

import { supabase } from '@/lib/supabaseClient';

export const TRANSACTIONS_TABLE = 'Transactions';

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

/* ------------------------- create transaction ---------------------- */

/**
 * Persist one transaction.
 * @returns {Promise<{ok: boolean, status: 'synced'|'queued'|'failed', row: object, error?: string}>}
 */
export async function createTransaction(user, qrValue, recordStatus, qcStatus) {
  const row = {
    qr_value: qrValue,
    RecordStatus: recordStatus,
    QCStatus: qcStatus,
    Username: user?.username || 'unknown',
    Department: user?.department || '-',
    client_ref: crypto.randomUUID(),
    created_at: new Date().toISOString(),
  };

  try {
    const { error } = await supabase.from(TRANSACTIONS_TABLE).insert([row], {
      // Idempotency: a retried sync must not duplicate the event.
      onConflict: 'client_ref',
      ignoreDuplicates: true,
    });
    if (error) throw error;
    return { ok: true, status: 'synced', row };
  } catch (err) {
    // Queue locally - surface an honest but non-blocking message.
    const queue = readQueue();
    queue.push(row);
    writeQueue(queue);
    const offline =
      err?.message?.includes('fetch') || err?.message?.includes('network');
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

/** Try to flush queued transactions to Supabase. Safe to call often. */
export async function retryQueuedTransactions() {
  const queue = readQueue();
  if (queue.length === 0) return { flushed: 0, remaining: 0 };
  const remaining = [];
  let flushed = 0;
  for (const row of queue) {
    try {
      const { error } = await supabase
        .from(TRANSACTIONS_TABLE)
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

/* ----------------------------- read rows --------------------------- */

/** Recent transactions: live rows from Supabase merged with the local queue. */
export async function getRecentTransactions(limit = 25) {
  const queued = readQueue();
  const list = queued.map((r) => ({ ...r, _source: 'queued' }));
  try {
    const { data, error } = await supabase
      .from(TRANSACTIONS_TABLE)
      .select('qr_value, RecordStatus, QCStatus, Username, Department, client_ref, created_at')
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