'use strict';

// Tests for the session-scoped deletion services (Recent Transactions
// / Recent Activations bin icons):
//   - lib/transactionsService.js -> deleteTransactionRecord
//   - lib/qrActivationService.js -> deleteActivationRecord (cascade:
//     data_updates delete + msk activation-mark revert)
// A fake Supabase client records every call so the exact table /
// filter / payload shape can be asserted without network access.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DATA_UPDATES_TABLE,
  deleteTransactionRecord,
} from '../lib/transactionsService.js';

import {
  DATA_UPDATES_TABLE as ACTIVATION_DATA_UPDATES_TABLE,
  MSK_TABLE,
  deleteActivationRecord,
} from '../lib/qrActivationService.js';

/* ============================== fakes ================================ */

/**
 * Minimal Supabase client double. `delete().eq()` / `delete().match()` /
 * `update().eq()` calls are recorded per table and resolve with the
 * configured errors (supabase-js resolves query failures to
 * { error } instead of throwing - the fakes mirror that).
 */
function createFakeClient({ duError = null, mskUpdateError = null, mskDeleteError = null } = {}) {
  const calls = {
    duDeleteEq: null,
    duDeleteMatch: null,
    mskUpdate: null,
    mskDeleteEq: null,
    order: [],
  };
  const dataUpdates = {
    delete: () => ({
      eq: (col, value) => {
        calls.duDeleteEq = { col, value };
        calls.order.push('du.delete.eq');
        return Promise.resolve({ error: duError });
      },
      match: (match) => {
        calls.duDeleteMatch = match;
        calls.order.push('du.delete.match');
        return Promise.resolve({ error: duError });
      },
    }),
  };
  const msk = {
    update: (patch) => ({
      eq: (col, value) => {
        calls.mskUpdate = { patch, col, value };
        calls.order.push('msk.update.eq');
        return Promise.resolve({ error: mskUpdateError });
      },
    }),
    delete: () => ({
      eq: (col, value) => {
        calls.mskDeleteEq = { col, value };
        calls.order.push('msk.delete.eq');
        return Promise.resolve({ error: mskDeleteError });
      },
    }),
  };
  return {
    calls,
    from(table) {
      if (table === DATA_UPDATES_TABLE || table === ACTIVATION_DATA_UPDATES_TABLE) {
        return dataUpdates;
      }
      if (table === MSK_TABLE) return msk;
      throw new Error(`Unexpected table requested: ${table}`);
    },
  };
}

const TX_ROW = {
  client_ref: 'tx-abc-123',
  id: 42,
  qr_code: ';MQC-9;PO123;42;scanned;',
  inner_qr: null,
  record_status: 'IN',
  qc_status: 'Forward',
  department: 'Finishing 01',
  count: 1,
  created_by: 'Lahiru',
  created_at: '2026-09-08T04:15:30.123Z',
};


/* ==================== standard transaction delete ==================== */

test('deleteTransactionRecord: uses the data_updates primary key when the row carries an id', async () => {
  const client = createFakeClient();
  const result = await deleteTransactionRecord({ ...TX_ROW }, client);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(client.calls.duDeleteEq, { col: 'id', value: 42 });
  assert.equal(client.calls.duDeleteMatch, null);
});

test('deleteTransactionRecord: in-session rows (no id) delete by the exact composite match', async () => {
  const client = createFakeClient();
  const { id, ...noIdRow } = TX_ROW;
  const result = await deleteTransactionRecord(noIdRow, client);
  assert.deepEqual(result, { ok: true });
  assert.equal(client.calls.duDeleteEq, null);
  assert.deepEqual(client.calls.duDeleteMatch, {
    qr_code: TX_ROW.qr_code,
    inner_qr: null,
    record_status: 'IN',
    qc_status: 'Forward',
    department: 'Finishing 01',
    count: 1,
    created_by: 'Lahiru',
    created_at: TX_ROW.created_at,
  });
});

test('deleteTransactionRecord: a Supabase error resolves to { ok: false, error } without throwing', async () => {
  const client = createFakeClient({ duError: { message: 'permission denied' } });
  const result = await deleteTransactionRecord(TX_ROW, client);
  assert.equal(result.ok, false);
  assert.match(result.error, /permission denied/);
});

test('deleteTransactionRecord: never touches tables other than data_updates', async () => {
  const client = createFakeClient();
  await deleteTransactionRecord(TX_ROW, client);
  assert.equal(client.calls.mskUpdate, null);
  assert.equal(client.calls.mskDeleteEq, null);
});

/* ==================== activation cascade delete ====================== */

test('deleteActivationRecord: full cascade - data_updates row deleted, msk status restored, mark cleared', async () => {
  const client = createFakeClient();
  const result = await deleteActivationRecord(TX_ROW, client);
  assert.deepEqual(result, { ok: true });
  // 1. The activation record is deleted from data_updates (by id here).
  assert.deepEqual(client.calls.duDeleteEq, { col: 'id', value: 42 });
  // 2. msk status restore attempt ('Packed' = the re-activatable status).
  assert.deepEqual(client.calls.mskUpdate, {
    patch: { status: 'Packed' },
    col: 'org_qr',
    value: TX_ROW.qr_code,
  });
  // 3. The activation marking row is cleared so the duplicate guard
  //    no longer blocks a fresh activation.
  assert.deepEqual(client.calls.mskDeleteEq, { col: 'org_qr', value: TX_ROW.qr_code });
  // Strict order: record first, then the msk revert.
  assert.deepEqual(client.calls.order, ['du.delete.eq', 'msk.update.eq', 'msk.delete.eq']);
});

test('deleteActivationRecord: rows without an id cascade through the composite data_updates match', async () => {
  const client = createFakeClient();
  const { id, ...noIdRow } = TX_ROW;
  const result = await deleteActivationRecord(noIdRow, client);
  assert.deepEqual(result, { ok: true });
  assert.equal(client.calls.duDeleteEq, null);
  assert.equal(client.calls.duDeleteMatch.created_at, TX_ROW.created_at);
  assert.equal(client.calls.duDeleteMatch.qr_code, TX_ROW.qr_code);
  assert.deepEqual(client.calls.mskDeleteEq, { col: 'org_qr', value: TX_ROW.qr_code });
});

test('deleteActivationRecord: when the data_updates delete fails the msk revert is SKIPPED and the error surfaces', async () => {
  const client = createFakeClient({ duError: { message: 'row is referenced' } });
  const result = await deleteActivationRecord(TX_ROW, client);
  assert.equal(result.ok, false);
  assert.match(result.error, /activation record/);
  assert.match(result.error, /row is referenced/);
  assert.equal(client.calls.mskUpdate, null);
  assert.equal(client.calls.mskDeleteEq, null);
});

test('deleteActivationRecord: a failed msk mark delete fails the whole cascade (ErrorModal in the view)', async () => {
  const client = createFakeClient({ mskDeleteError: { message: 'rls blocked' } });
  const result = await deleteActivationRecord(TX_ROW, client);
  assert.equal(result.ok, false);
  assert.match(result.error, /msk activation mark/);
  assert.match(result.error, /rls blocked/);
});

test('deleteActivationRecord: the msk status restore is best-effort - a rejected update does not fail the cascade', async () => {
  // Legacy live tables without the `status` column reject the update;
  // the marking row is still cleared and the deletion succeeds.
  const client = createFakeClient({
    mskUpdateError: { message: "column 'status' does not exist" },
  });
  const result = await deleteActivationRecord(TX_ROW, client);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(client.calls.mskDeleteEq, { col: 'org_qr', value: TX_ROW.qr_code });
});
