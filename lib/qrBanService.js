'use client';

// ============================================================
// Concord TrackSync - QR Ban service (search + ban management)
//
// Backs the "QR status search & ban" panel on the QR Activation tab:
//
//  * searchMskQr : query the msk table by the msk_qr column for one
//    raw scanned/typed QR value (latest row wins via id desc, the same
//    addressing fetchMskStatusForQr uses). The row's org_qr encodes
//    the activation details ";mqc;po;size;scanned;" - describeMskOrgQr
//    parses it into the PO / size / style (MQC) details the panel
//    displays when the row's status is explicitly 'active'.
//
//  * banMskQr    : update msk.status -> 'ban' for that record (the
//    exact value the guards check). VERIFIED via UPDATE ... RETURNING
//    id, so both a database error AND a silent no-op (RLS-blocked
//    UPDATE / row already gone) are reported as explicit failures.
//
// Once a QR is banned every entry path is rejected by the guards:
// validateStandardScan (standard transactions, scanned msk_qr mode AND
// the Packing single-scan lookup mode) and checkActivationMskStatus
// (QR activation), plus the offline queue flushes (see qrBanGuard.js).
// ============================================================

import { supabase } from './supabaseClient.js';
import { parseOrgQr } from './transactionDualScan.js';
import { BANNED_STATUS } from './qrBanGuard.js';

/** Exact msk table name (as configured in Supabase). */
export const MSK_TABLE = 'msk';

/**
 * Pure: parse the PO / size / style details encoded in one msk row's
 * org_qr. The activation format ';mqc;po;size;scanned;' carries all
 * three (MQC doubles as the style reference); a plain legacy value
 * without the semicolon structure has no MQC/size and is reported as
 * the PO/reference itself.
 * @param {string} orgQr the msk row's org_qr
 * @returns {{mqc: string|null, po: string|null, size: string|null, scanned: string|null}}
 */
export function describeMskOrgQr(orgQr) {
  const parsed = parseOrgQr(orgQr);
  return {
    mqc: parsed.mqc ?? null,
    po: parsed.po ?? null,
    size: parsed.size ?? null,
    scanned: parsed.scanned ?? null,
  };
}

/**
 * Search ONE msk record by the raw QR value (msk_qr column).
 *
 * @param {string} qrValue raw scanned or typed QR code
 * @param {object} [client] Supabase client (dependency-injected for
 *        tests; defaults to the app-wide singleton)
 * @returns {Promise<{found: boolean, offline: boolean,
 *            row: null | {id, msk_qr, org_qr, status},
 *            details: null | {mqc, po, size, scanned}}>}
 *          `offline: true` when the msk table cannot be reached.
 */
export async function searchMskQr(qrValue, client = supabase) {
  const value = String(qrValue || '').trim();
  if (!value) return { found: false, offline: false, row: null, details: null };
  try {
    const { data, error } = await client
      .from(MSK_TABLE)
      .select('id, msk_qr, org_qr, status')
      .eq('msk_qr', value)
      .order('id', { ascending: false })
      .limit(1);
    if (error) throw error;
    const row = data?.[0] ?? null;
    if (!row) return { found: false, offline: false, row: null, details: null };
    return {
      found: true,
      offline: false,
      row: {
        id: row.id ?? null,
        msk_qr: row.msk_qr == null ? null : String(row.msk_qr),
        org_qr: row.org_qr == null ? null : String(row.org_qr),
        status: row.status == null ? null : String(row.status),
      },
      details: describeMskOrgQr(row.org_qr),
    };
  } catch {
    // msk missing / RLS / network - the search cannot be completed.
    return { found: false, offline: true, row: null, details: null };
  }
}

/**
 * Ban ONE msk record: update msk.status from its current value to
 * 'ban' for the row addressed by msk_qr (the record the search found).
 * Never throws - returns { ok: true, rows } | { ok: false, error } so
 * the panel can decide between a success toast and the error state.
 *
 * @param {string} qrValue the searched QR value (msk_qr)
 * @param {object} [client] Supabase client (dependency-injected for
 *        tests; defaults to the app-wide singleton)
 * @returns {Promise<{ok: boolean, rows?: number, error?: string}>}
 */
export async function banMskQr(qrValue, client = supabase) {
  const value = String(qrValue || '').trim();
  if (!value) return { ok: false, error: 'No QR code was provided.' };
  try {
    // `.select('id')` turns the update into UPDATE ... RETURNING id -
    // the number of returned rows VERIFIES the write. PostgREST
    // resolves an RLS-blocked or missing-row UPDATE as HTTP 200 with
    // an EMPTY array (error stays null!), so without this check the
    // panel could report a ban that never reached the database.
    const { data, error } = await client
      .from(MSK_TABLE)
      .update({ status: BANNED_STATUS })
      .eq('msk_qr', value)
      .select('id');
    if (error) throw error;
    const rows = data?.length ?? 0;
    if (rows === 0) {
      return {
        ok: false,
        error:
          'No msk record was updated. The record may have been removed, or the database is missing the msk UPDATE policy (run supabase/qr-activation-schema.sql in the Supabase SQL Editor).',
      };
    }
    return { ok: true, rows };
  } catch (err) {
    return {
      ok: false,
      error: `Could not ban the QR code: ${err?.message || err || 'unknown error'}`,
    };
  }
}
