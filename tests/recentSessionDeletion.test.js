'use strict';

// Tests for the verified deletion services behind the Recent
// Transactions / Recent Activations bin icons:
//   - lib/transactionsService.js -> deleteTransactionRecord
//   - lib/qrActivationService.js -> deleteActivationRecord (cascade:
//     data_updates delete + msk activation-mark revert)
//
// KEY REGRESSION COVERED HERE: PostgREST resolves an RLS-blocked or
// not-found DELETE as HTTP 200 with an EMPTY array (`error` stays
// null). The services must treat a no-op delete as an explicit failure
// (ErrorModal in the view) instead of pretending it succeeded.
//
// A fake Supabase client records every call and returns the configured
// { data, error } responses without network access.

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
 * Minimal supabase-js double. Mirrors the real builder chain:
 *   delete().eq()/match().select('id') -> Promise<{ data, error }>
 *   update(patch).eq()                 -> Promise<{ data, error }>
 * `duDeletedRows` / `mskDeletedRows` simulate what the DELETE returned
 * (an EMPTY array = the silent RLS-blocked no-op).
 */
function createFakeClient({
  duError = null,
  duDeletedRows = [{ id: 42 }],
  mskUpdateError = null,
  mskDeleteError = null,
  mskDeletedRows = [{ id: 9 }],
} = {}) {
  const calls = {
    duDeleteEq: null,
    duDeleteMatch: null,
    duSelect: null,
    mskUpdate: null,
    mskDeleteEq: null,
    mskDeleteSelect: null,
    order: [],
  };
  const dataUpdates = {
    delete: () => {
      calls.order.push('du.delete');
      const builder = {
        eq: (col, value) => {
          calls.duDeleteEq = { col, value };
          return builder;
        },
        match: (match) => {
          calls.duDeleteMatch = match;
          return builder;
        },
        select: (columns) => {
          calls.duSelect = columns;
          return Promise.resolve({ data: duDeletedRows, error: duError });
        },
      };
      return builder;
    },
  };
  const msk = {
    update: (patch) => ({
      eq: (col, value) => {
        calls.mskUpdate = { patch, col, value };
        calls.order.push('msk.update');
        return Promise.resolve({ data: [], error: mskUpdateError });
      },
    }),
    delete: () => {
      calls.order.push('msk.delete');
      const builder = {
        eq: (col, value) => {
          calls.mskDeleteEq = { col, value };
          return builder;
        },
        select: (columns) => {
          calls.mskDeleteSelect = columns;
          return Promise.resolve({ data: mskDeletedRows, error: mskDeleteError });
        },
      };
      return builder;
    },
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

test('deleteTransactionRecord: deletes by the data_updates primary key and verifies the response', async () => {
  const client = createFakeClient();
  const result = await deleteTransactionRecord({ ...TX_ROW }, client);
  assert.deepEqual(result, { ok: true, deleted: 1 });
  assert.deepEqual(client.calls.duDeleteEq, { col: 'id', value: 42 });
  assert.equal(client.calls.duDeleteMatch, null);
  assert.equal(client.calls.duSelect, 'id');
});

test('deleteTransactionRecord: in-session rows (no id) delete by the exact composite match', async () => {
  const client = createFakeClient();
  const { id, ...noIdRow } = TX_ROW;
  const result = await deleteTransactionRecord(noIdRow, client);
  assert.deepEqual(result, { ok: true, deleted: 1 });
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

test('deleteTransactionRecord: a database error is surfaced as an explicit failure', async () => {
  const client = createFakeClient({ duError: { message: 'permission denied' } });
  const result = await deleteTransactionRecord(TX_ROW, client);
  assert.equal(result.ok, false);
  assert.match(result.error, /Could not delete the transaction from data_updates/);
  assert.match(result.error, /permission denied/);
});

test('deleteTransactionRecord: a SILENT NO-OP delete (RLS-blocked, 0 rows) is an explicit failure', async () => {
  // THE regression: PostgREST returns 200 with an empty array and
  // error = null when RLS blocks the DELETE - the service must NOT
  // report success while the database record survives.
  const client = createFakeClient({ duDeletedRows: [] });
  const result = await deleteTransactionRecord(TX_ROW, client);
  assert.equal(result.ok, false);
  assert.match(result.error, /No matching data_updates record was deleted/);
  assert.match(result.error, /DELETE policy/);
});

test('deleteTransactionRecord: never touches tables other than data_updates', async () => {
  const client = createFakeClient();
  await deleteTransactionRecord(TX_ROW, client);
  assert.equal(client.calls.mskUpdate, null);
  assert.equal(client.calls.mskDeleteEq, null);
});

/* ==================== activation cascade delete ====================== */

test('deleteActivationRecord: full cascade - verified data_updates delete, msk status restore, mark cleared', async () => {
  const client = createFakeClient();
  const result = await deleteActivationRecord(TX_ROW, client);
  assert.deepEqual(result, { ok: true, deleted: 1 });
  // 1. The activation record is deleted from data_updates by its id...
  assert.deepEqual(client.calls.duDeleteEq, { col: 'id', value: 42 });
  assert.equal(client.calls.duSelect, 'id');
  // 2. ...the msk status restore targets the marking row...
  assert.deepEqual(client.calls.mskUpdate, {
    patch: { status: 'Packed' },
    col: 'org_qr',
    value: TX_ROW.qr_code,
  });
  // 3. ...and the verified mark delete clears the duplicate guard.
  assert.deepEqual(client.calls.mskDeleteEq, { col: 'org_qr', value: TX_ROW.qr_code });
  assert.equal(client.calls.mskDeleteSelect, 'id');
  // Strict order: record first, then the msk revert.
  assert.deepEqual(client.calls.order, ['du.delete', 'msk.update', 'msk.delete']);
});

test('deleteActivationRecord: rows without an id cascade through the composite data_updates match', async () => {
  const client = createFakeClient();
  const { id, ...noIdRow } = TX_ROW;
  const result = await deleteActivationRecord(noIdRow, client);
  assert.deepEqual(result, { ok: true, deleted: 1 });
  assert.equal(client.calls.duDeleteEq, null);
  assert.equal(client.calls.duDeleteMatch.created_at, TX_ROW.created_at);
  assert.equal(client.calls.duDeleteMatch.qr_code, TX_ROW.qr_code);
  assert.deepEqual(client.calls.mskDeleteEq, { col: 'org_qr', value: TX_ROW.qr_code });
});

test('deleteActivationRecord: a data_updates error skips the msk revert and surfaces the error', async () => {
  const client = createFakeClient({ duError: { message: 'row is referenced' } });
  const result = await deleteActivationRecord(TX_ROW, client);
  assert.equal(result.ok, false);
  assert.match(result.error, /Could not delete the activation record/);
  assert.match(result.error, /row is referenced/);
  assert.equal(client.calls.mskUpdate, null);
  assert.equal(client.calls.mskDeleteEq, null);
});

test('deleteActivationRecord: a SILENT NO-OP data_updates delete (RLS-blocked) is an explicit failure', async () => {
  // THE regression: 0 rows deleted + no pending offline copy must fail
  // instead of pretending the cascade succeeded.
  const client = createFakeClient({ duDeletedRows: [] });
  const result = await deleteActivationRecord(TX_ROW, client);
  assert.equal(result.ok, false);
  assert.match(result.error, /No matching activation record was deleted/);
  assert.match(result.error, /DELETE policy/);
});

test('deleteActivationRecord: a failed msk mark delete fails the whole cascade', async () => {
  const client = createFakeClient({ mskDeleteError: { message: 'rls blocked' } });
  const result = await deleteActivationRecord(TX_ROW, client);
  assert.equal(result.ok, false);
  assert.match(result.error, /Could not reset the msk activation mark/);
  assert.match(result.error, /rls blocked/);
});

test('deleteActivationRecord: a SILENT NO-OP msk delete fails the cascade when the record existed', async () => {
  // The data_updates row existed, so its duplicate-guard marking row
  // must exist too - an empty result means the msk DELETE was blocked.
  const client = createFakeClient({ mskDeletedRows: [] });
  const result = await deleteActivationRecord(TX_ROW, client);
  assert.equal(result.ok, false);
  assert.match(result.error, /msk activation mark could not be deleted/);
  assert.match(result.error, /msk DELETE policy/);
});

test('deleteActivationRecord: the msk status restore is best-effort - a rejected update does not fail the cascade', async () => {
  // Legacy live tables without the `status` column reject the update;
  // the marking row is still cleared and the deletion succeeds.
  const client = createFakeClient({
    mskUpdateError: { message: "column 'status' does not exist" },
  });
  const result = await deleteActivationRecord(TX_ROW, client);
  assert.deepEqual(result, { ok: true, deleted: 1 });
  assert.deepEqual(client.calls.mskDeleteEq, { col: 'org_qr', value: TX_ROW.qr_code });
  assert.equal(client.calls.mskDeleteSelect, 'id');
});

