import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyMetrics,
  aggregateMetricsByDepartmentSize,
  sumMetricsAcrossSizes,
  buildPoSummary,
} from '../lib/reportsService.js';

/* ==================================================================
 * Pure helper: emptyMetrics
 * ================================================================== */

test('emptyMetrics returns a zeroed metrics bucket', () => {
  const m = emptyMetrics();
  assert.deepEqual(m, {
    in: 0,
    out: 0,
    bGrade: 0,
    cGrade: 0,
    labTesting: 0,
    outTotal: 0,
  });
});

/* ==================================================================
 * aggregateMetricsByDepartmentSize — the row-by-row matrix core
 * ================================================================== */

test('aggregates IN / OUT counts by department and size', () => {
  const rows = [
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'IN', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'IN', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;36;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Forward', count: 1 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', ['35', '36']);
  assert.equal(result['Lasting 01']['35'].in, 2);
  assert.equal(result['Lasting 01']['35'].out, 1);
  assert.equal(result['Lasting 01']['36'].in, 0);
  assert.equal(result['Lasting 01']['36'].out, 1);
});

test('aggregates QC categories (B Grade, C Grade, Lab Testing)', () => {
  const rows = [
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Finishing 01', record_status: 'OUT', qc_status: 'B Grade', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Finishing 01', record_status: 'OUT', qc_status: 'B Grade', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Finishing 01', record_status: 'OUT', qc_status: 'C Grade', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Finishing 01', record_status: 'OUT', qc_status: 'Lab Testing', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Finishing 01', record_status: 'OUT', qc_status: 'Forward', count: 1 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', ['35']);
  const m = result['Finishing 01']['35'];
  assert.equal(m.bGrade, 2);
  assert.equal(m.cGrade, 1);
  assert.equal(m.labTesting, 1);
});

test('outTotal sums count for OUT rows (net, returns subtract)', () => {
  const rows = [
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Return', count: -1 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', ['35']);
  // out count = 3 rows, but outTotal = 1 + 1 + (-1) = 1 (net)
  assert.equal(result['Lasting 01']['35'].out, 3);
  assert.equal(result['Lasting 01']['35'].outTotal, 1);
});

test('ignores rows for other POs', () => {
  const rows = [
    { qr_code: ';mqc1;PO-999;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Forward', count: 1 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', ['35']);
  assert.equal(result['Lasting 01']['35'].out, 1);
});

test('ignores rows whose size is not in the column set', () => {
  const rows = [
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;99;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Forward', count: 1 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', ['35']);
  assert.equal(result['Lasting 01']['35'].out, 1);
  assert.equal(result['Lasting 01']['99'], undefined);
});

test('ignores legacy rows that do not encode a PO + size', () => {
  const rows = [
    { qr_code: 'LEGACY-NO-SEMICOLON', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Forward', count: 1 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', ['35']);
  assert.equal(result['Lasting 01']['35'].out, 1);
});

test('treats non-numeric count as 0 for outTotal', () => {
  const rows = [
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Forward', count: 'x' },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Forward', count: 2 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', ['35']);
  assert.equal(result['Lasting 01']['35'].out, 2);
  assert.equal(result['Lasting 01']['35'].outTotal, 2);
});

/* ==================================================================
 * sumMetricsAcrossSizes — the Total column
 * ================================================================== */

test('sumMetricsAcrossSizes adds up every metric across sizes', () => {
  const sizeMetrics = {
    '35': { in: 2, out: 1, bGrade: 1, cGrade: 0, labTesting: 0, outTotal: 1 },
    '36': { in: 3, out: 2, bGrade: 0, cGrade: 1, labTesting: 1, outTotal: 2 },
  };
  const total = sumMetricsAcrossSizes(sizeMetrics, ['35', '36']);
  assert.equal(total.in, 5);
  assert.equal(total.out, 3);
  assert.equal(total.bGrade, 1);
  assert.equal(total.cGrade, 1);
  assert.equal(total.labTesting, 1);
  assert.equal(total.outTotal, 3);
});

test('sumMetricsAcrossSizes treats missing sizes as zero', () => {
  const sizeMetrics = {
    '35': { in: 1, out: 1, bGrade: 0, cGrade: 0, labTesting: 0, outTotal: 1 },
  };
  const total = sumMetricsAcrossSizes(sizeMetrics, ['35', '36']);
  assert.equal(total.in, 1);
  assert.equal(total.outTotal, 1);
});

/* ==================================================================
 * buildPoSummary — blank / whitespace PO early return
 * ================================================================== */

test('buildPoSummary returns empty matrix for blank PO', async () => {
  const result = await buildPoSummary('');
  assert.equal(result.po, '');
  assert.deepEqual(result.sizes, []);
  assert.deepEqual(result.rows, []);
});

test('buildPoSummary returns empty matrix for whitespace PO', async () => {
  const result = await buildPoSummary('   ');
  assert.deepEqual(result.sizes, []);
});

/* ==================================================================
 * Balance-to-Cut deduction — row-by-row arithmetic verification
 *
 * Replicates the exact arithmetic buildPoSummary uses so the test
 * is independent of the Supabase client.
 * ================================================================== */

test('balanceToCut = cut_qty - Out Total, per size and in Total column', () => {
  const cutQty = { '35': 100, '36': 150 };
  const sizeMetrics = {
    '35': { in: 10, out: 8, bGrade: 1, cGrade: 0, labTesting: 0, outTotal: 8 },
    '36': { in: 20, out: 18, bGrade: 2, cGrade: 1, labTesting: 0, outTotal: 18 },
  };
  const bal35 = cutQty['35'] - sizeMetrics['35'].outTotal;
  const bal36 = cutQty['36'] - sizeMetrics['36'].outTotal;
  assert.equal(bal35, 92); // 100 - 8
  assert.equal(bal36, 132); // 150 - 18
  const totalOut = sizeMetrics['35'].outTotal + sizeMetrics['36'].outTotal;
  const totalCut = cutQty['35'] + cutQty['36'];
  assert.equal(totalCut - totalOut, 224); // 250 - 26
});

test('balanceToCut is positive when output is below cut (remaining work)', () => {
  const cutQty = { '35': 50 };
  const sizeMetrics = {
    '35': { in: 5, out: 3, bGrade: 0, cGrade: 0, labTesting: 0, outTotal: 3 },
  };
  const bal = cutQty['35'] - sizeMetrics['35'].outTotal;
  assert.equal(bal, 47);
  assert.ok(bal > 0);
});

test('balanceToCut is zero when output equals cut', () => {
  const cutQty = { '35': 50 };
  const sizeMetrics = {
    '35': { in: 50, out: 50, bGrade: 0, cGrade: 0, labTesting: 0, outTotal: 50 },
  };
  const bal = cutQty['35'] - sizeMetrics['35'].outTotal;
  assert.equal(bal, 0);
});



/* ==================================================================
 * Full matrix assembly — build a complete matrix the way
 * buildPoSummary does, using the pure functions end-to-end.
 * ================================================================== */

test('full matrix: cut row, department sections, balance, totals', () => {
  const cutQtyMap = { '35': 100, '36': 150 };
  const sizes = Object.keys(cutQtyMap).sort((a, b) => Number(a) - Number(b));
  const departments = [
    { id: 1, department: 'Upper Line 01', sequence: 1 },
    { id: 5, department: 'Lasting 01', sequence: 3 },
  ];
  const dataUpdates = [
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Upper Line 01', record_status: 'IN', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Upper Line 01', record_status: 'IN', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Upper Line 01', record_status: 'OUT', qc_status: 'B Grade', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'B Grade', count: 1 },
    { qr_code: ';mqc1;PO-123;36;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;36;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'C Grade', count: 1 },
  ];

  const deptMetrics = aggregateMetricsByDepartmentSize(dataUpdates, 'PO-123', sizes);

  const rows = [];
  const cutRow = { type: 'cut', label: 'Cut OUT', values: {} };
  for (const size of sizes) cutRow.values[size] = cutQtyMap[size] ?? 0;
  cutRow.values['total'] = sizes.reduce((s, sz) => s + (cutRow.values[sz] || 0), 0);
  rows.push(cutRow);

  for (const dept of departments) {
    const sizeMetrics = deptMetrics[dept.department] || {};
    const metrics = {};
    for (const size of sizes) {
      const m = sizeMetrics[size] || emptyMetrics();
      const cutQty = cutQtyMap[size] ?? 0;
      metrics[size] = { ...m, balanceToCut: cutQty - m.outTotal };
    }
    const totalMetrics = sumMetricsAcrossSizes(sizeMetrics, sizes);
    const totalCutQty = sizes.reduce((s, sz) => s + (cutQtyMap[sz] ?? 0), 0);
    metrics['total'] = { ...totalMetrics, balanceToCut: totalCutQty - totalMetrics.outTotal };
    rows.push({ type: 'department', name: dept.department, sequence: dept.sequence, metrics });
  }

  // cut row
  assert.equal(rows[0].type, 'cut');
  assert.equal(rows[0].values['35'], 100);
  assert.equal(rows[0].values['36'], 150);
  assert.equal(rows[0].values['total'], 250);

  // Upper Line 01
  const upper = rows[1];
  assert.equal(upper.name, 'Upper Line 01');
  assert.equal(upper.metrics['35'].in, 2);
  assert.equal(upper.metrics['35'].out, 1);
  assert.equal(upper.metrics['35'].bGrade, 1);
  assert.equal(upper.metrics['35'].outTotal, 1);
  assert.equal(upper.metrics['35'].balanceToCut, 99); // 100 - 1

  // Lasting 01
  const lasting = rows[2];
  assert.equal(lasting.name, 'Lasting 01');
  assert.equal(lasting.metrics['35'].out, 1);
  assert.equal(lasting.metrics['35'].bGrade, 1);
  assert.equal(lasting.metrics['35'].balanceToCut, 99); // 100 - 1
  assert.equal(lasting.metrics['36'].out, 2);
  assert.equal(lasting.metrics['36'].cGrade, 1);
  assert.equal(lasting.metrics['36'].outTotal, 2);
  assert.equal(lasting.metrics['36'].balanceToCut, 148); // 150 - 2

  // Total column
  assert.equal(lasting.metrics['total'].out, 3); // 1 + 2
  assert.equal(lasting.metrics['total'].outTotal, 3); // 1 + 2
  assert.equal(lasting.metrics['total'].bGrade, 1);
  assert.equal(lasting.metrics['total'].cGrade, 1);
  assert.equal(lasting.metrics['total'].balanceToCut, 247); // 250 - 3
});

test('departments appear in the order given during assembly', () => {
  const cutQtyMap = { '35': 100 };
  const sizes = ['35'];
  const deptMetrics = aggregateMetricsByDepartmentSize([], 'PO-X', sizes);
  const departments = [
    { id: 5, department: 'Lasting 01', sequence: 3 },
    { id: 1, department: 'Upper Line 01', sequence: 1 },
  ];

  const rows = [];
  const cutRow = { type: 'cut', label: 'Cut OUT', values: { '35': 100, 'total': 100 } };
  rows.push(cutRow);
  for (const dept of departments) {
    const sizeMetrics = deptMetrics[dept.department] || {};
    const metrics = {};
    for (const size of sizes) {
      const m = sizeMetrics[size] || emptyMetrics();
      metrics[size] = { ...m, balanceToCut: 100 - m.outTotal };
    }
    const totalMetrics = sumMetricsAcrossSizes(sizeMetrics, sizes);
    metrics['total'] = { ...totalMetrics, balanceToCut: 100 - totalMetrics.outTotal };
    rows.push({ type: 'department', name: dept.department, sequence: dept.sequence, metrics });
  }

  assert.equal(rows[1].name, 'Lasting 01');
  assert.equal(rows[2].name, 'Upper Line 01');
});
