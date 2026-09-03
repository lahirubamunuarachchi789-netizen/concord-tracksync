import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickActiveMskRow,
  resolveDepartmentContext,
} from '../lib/transactionGuards.js';

/* ------------------- Rule 1 helper: pickActiveMskRow ---------------- */

test('pickActiveMskRow accepts case-insensitive Active statuses', () => {
  for (const status of ['Active', 'active', 'ACTIVE', '  Active ']) {
    const row = pickActiveMskRow([{ org_qr: 'ORG-1', status }]);
    assert.deepEqual(row, { org_qr: 'ORG-1' });
  }
});

test('pickActiveMskRow ignores Packed and every other non-Active status', () => {
  assert.equal(pickActiveMskRow([{ org_qr: 'ORG-1', status: 'Packed' }]), null);
  assert.equal(pickActiveMskRow([{ org_qr: 'ORG-1', status: 'Disabled' }]), null);
  assert.equal(pickActiveMskRow([{ org_qr: 'ORG-1' }]), null);
  assert.equal(pickActiveMskRow([{ org_qr: 'ORG-1', status: null }]), null);
  assert.equal(pickActiveMskRow([]), null);
  assert.equal(pickActiveMskRow(null), null);
});

test('pickActiveMskRow skips a Packed row and finds the Active one after it', () => {
  const rows = [
    { org_qr: 'OLD', status: 'Packed' },
    { org_qr: 'ORG-2', status: 'ACTIVE' },
  ];
  assert.deepEqual(pickActiveMskRow(rows), { org_qr: 'ORG-2' });
});

test('pickActiveMskRow ignores an Active row without an org_qr value', () => {
  assert.equal(pickActiveMskRow([{ org_qr: '', status: 'Active' }]), null);
});

/* ------------- department context: resolveDepartmentContext --------- */

const DEPARTMENTS = [
  { id: 1, department: 'Upper Line 01', sequence: 1 },
  { id: 2, department: 'Upper Line 02', sequence: 1 },
  { id: 3, department: 'Upper Line 03', sequence: 1 },
  { id: 4, department: 'Upper Line 04', sequence: 1 },
  { id: 5, department: 'Lasting 01', sequence: 3 },
  { id: 6, department: 'Lasting 02', sequence: 3 },
];

test('resolveDepartmentContext resolves current, previous and parallel sets', () => {
  const ctx = resolveDepartmentContext(DEPARTMENTS, 'Lasting 01');
  assert.equal(ctx.found, true);
  assert.equal(ctx.currentDepartment, 'Lasting 01');
  assert.equal(ctx.currentSeq, 3);
  // previous_seq = HIGHEST sequence strictly below 3 (sparse levels).
  assert.equal(ctx.previousSeq, 1);
  assert.deepEqual(ctx.previousDepartments, [
    'Upper Line 01',
    'Upper Line 02',
    'Upper Line 03',
    'Upper Line 04',
  ]);
  // parallel = same sequence, excluding the user's own department.
  assert.deepEqual(ctx.parallelDepartments, ['Lasting 02']);
});

test('resolveDepartmentContext: sequence 1 has no previous level', () => {
  const ctx = resolveDepartmentContext(DEPARTMENTS, 'Upper Line 03');
  assert.equal(ctx.currentSeq, 1);
  assert.equal(ctx.previousSeq, null);
  assert.deepEqual(ctx.previousDepartments, []);
  assert.deepEqual(ctx.parallelDepartments, [
    'Upper Line 01',
    'Upper Line 02',
    'Upper Line 04',
  ]);
});

test('resolveDepartmentContext matches case-insensitively and trims input', () => {
  const ctx = resolveDepartmentContext(DEPARTMENTS, '  lasting 01 ');
  assert.equal(ctx.found, true);
  assert.equal(ctx.currentSeq, 3);
});

test('resolveDepartmentContext reports unknown / blank departments', () => {
  assert.deepEqual(resolveDepartmentContext(DEPARTMENTS, 'Nowhere'), {
    found: false,
  });
  assert.deepEqual(resolveDepartmentContext(DEPARTMENTS, ''), { found: false });
  assert.deepEqual(resolveDepartmentContext(DEPARTMENTS, null), { found: false });
  assert.deepEqual(resolveDepartmentContext(null, 'Lasting 01'), { found: false });
});

test('resolveDepartmentContext ignores rows without department or sequence', () => {
  const rows = [
    { id: 1, department: 'Broken', sequence: null },
    { id: 2, department: null, sequence: 2 },
    ...DEPARTMENTS,
  ];
  const ctx = resolveDepartmentContext(rows, 'Lasting 01');
  assert.equal(ctx.currentSeq, 3);
  assert.deepEqual(ctx.parallelDepartments, ['Lasting 02']);
});
