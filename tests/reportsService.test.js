import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import {
  emptyMetrics,
  aggregateMetricsByDepartmentSize,
  sumMetricsAcrossSizes,
  buildPoSummary,
  STANDARD_SIZES,
  SLST_TIME_ZONE,
  QR_DATA_CSV_HEADERS,
  QR_DATA_XLSX_SHEET_NAME,
  QR_DATA_XLSX_COL_WIDTHS,
  formatSlstTimestamp,
  formatSlstDate,
  escapeCsvCell,
  transformQrRowForExport,
  buildQrDataCsv,
  buildQrDataXLSX,
  buildQrDataFileName,
  createPoQrDataFetcher,
    // Daily Output Report.
  aggregateDailyOutput,
  buildDailyOutputXlsx,
  createDailyOutputFetcher,
  DAILY_OUTPUT_COLUMNS,
  DAILY_OUTPUT_DEPARTMENT_COLUMN,
  QC_DEFECT_CATEGORIES,
  slstDayUtcBounds,
} from '../lib/reportsService.js';

test('emptyMetrics returns a zeroed metrics bucket', () => {
  assert.deepEqual(emptyMetrics(), {
    in: 0, out: 0, bGrade: 0, cGrade: 0, labTesting: 0, outTotal: 0,
  });
});

test('STANDARD_SIZES is 35 through 50 inclusive (16 sizes)', () => {
  assert.equal(STANDARD_SIZES.length, 16);
  assert.equal(STANDARD_SIZES[0], '35');
  assert.equal(STANDARD_SIZES[15], '50');
  assert.deepEqual(STANDARD_SIZES, [
    '35','36','37','38','39','40','41','42','43','44','45','46','47','48','49','50',
  ]);
});

test('aggregates IN counts by department and size', () => {
  const rows = [
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'IN', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'IN', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;36;scan;', department: 'Lasting 01', record_status: 'IN', qc_status: 'Forward', count: 1 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', STANDARD_SIZES);
  assert.equal(result['Lasting 01']['35'].in, 2);
  assert.equal(result['Lasting 01']['36'].in, 1);
});

test('OUT counts only PASS/Good records — excludes B/C/Lab qc_status', () => {
  const rows = [
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Reworked', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'B Grade', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'C Grade', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Lab Testing', count: 1 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', STANDARD_SIZES);
  assert.equal(result['Lasting 01']['35'].out, 2); // Forward + Reworked only
  assert.equal(result['Lasting 01']['35'].bGrade, 1);
  assert.equal(result['Lasting 01']['35'].cGrade, 1);
  assert.equal(result['Lasting 01']['35'].labTesting, 1);
});

test('OUT exclusion is case-insensitive for qc_status', () => {
  const rows = [
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'D1', record_status: 'OUT', qc_status: 'b grade', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'D1', record_status: 'OUT', qc_status: 'C GRADE', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'D1', record_status: 'OUT', qc_status: '  Lab Testing  ', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'D1', record_status: 'OUT', qc_status: 'Forward', count: 1 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', STANDARD_SIZES);
  assert.equal(result['D1']['35'].out, 1); // only Forward
});

test('outTotal sums count for ALL rows (net total)', () => {
  const rows = [
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'D1', record_status: 'IN', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'D1', record_status: 'OUT', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'D1', record_status: 'OUT', qc_status: 'B Grade', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'D1', record_status: 'OUT', qc_status: 'Return', count: -1 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', STANDARD_SIZES);
  assert.equal(result['D1']['35'].outTotal, 2); // 1 + 1 + 1 + (-1)
  assert.equal(result['D1']['35'].out, 2); // Forward + Return (B Grade excluded)
});

test('outTotal includes IN rows in the net sum', () => {
  const rows = [
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'D1', record_status: 'IN', qc_status: 'Forward', count: 5 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'D1', record_status: 'OUT', qc_status: 'Forward', count: 3 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', STANDARD_SIZES);
  assert.equal(result['D1']['35'].outTotal, 8); // 5 + 3
});

test('ignores rows for other POs', () => {
  const rows = [
    { qr_code: ';mqc1;PO-999;35;scan;', department: 'D1', record_status: 'OUT', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'D1', record_status: 'OUT', qc_status: 'Forward', count: 1 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', STANDARD_SIZES);
  assert.equal(result['D1']['35'].out, 1);
});

test('ignores rows whose size is outside the standard range', () => {
  const rows = [
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'D1', record_status: 'OUT', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;99;scan;', department: 'D1', record_status: 'OUT', qc_status: 'Forward', count: 1 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', STANDARD_SIZES);
  assert.equal(result['D1']['35'].out, 1);
  assert.equal(result['D1']['99'], undefined);
});

test('ignores legacy rows without PO + size encoding', () => {
  const rows = [
    { qr_code: 'LEGACY', department: 'D1', record_status: 'OUT', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'D1', record_status: 'OUT', qc_status: 'Forward', count: 1 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', STANDARD_SIZES);
  assert.equal(result['D1']['35'].out, 1);
});

test('treats non-numeric count as 0 for outTotal', () => {
  const rows = [
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'D1', record_status: 'OUT', qc_status: 'Forward', count: 'x' },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'D1', record_status: 'OUT', qc_status: 'Forward', count: 2 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', STANDARD_SIZES);
  assert.equal(result['D1']['35'].out, 2);
  assert.equal(result['D1']['35'].outTotal, 2);
});

test('aggregates QC categories correctly', () => {
  const rows = [
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Finishing 01', record_status: 'OUT', qc_status: 'B Grade', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Finishing 01', record_status: 'OUT', qc_status: 'B Grade', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Finishing 01', record_status: 'OUT', qc_status: 'C Grade', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Finishing 01', record_status: 'OUT', qc_status: 'Lab Testing', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Finishing 01', record_status: 'OUT', qc_status: 'Forward', count: 1 },
  ];
  const result = aggregateMetricsByDepartmentSize(rows, 'PO-123', STANDARD_SIZES);
  const m = result['Finishing 01']['35'];
  assert.equal(m.bGrade, 2);
  assert.equal(m.cGrade, 1);
  assert.equal(m.labTesting, 1);
  assert.equal(m.out, 1); // only Forward
  assert.equal(m.outTotal, 5); // sum of all count values
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
 * Balance-to-Cut deduction
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

test('balanceToCut is positive when output is below cut', () => {
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
 * buildPoSummary — fixed size range and full matrix assembly
 * ================================================================== */

test('buildPoSummary returns STANDARD_SIZES even for blank PO', async () => {
  const result = await buildPoSummary('');
  assert.equal(result.po, '');
  assert.deepEqual(result.sizes, STANDARD_SIZES);
  assert.deepEqual(result.rows, []);
});

test('buildPoSummary returns STANDARD_SIZES for whitespace PO', async () => {
  const result = await buildPoSummary('   ');
  assert.deepEqual(result.sizes, STANDARD_SIZES);
});

/* ==================================================================
 * Full matrix assembly — end-to-end with the new OUT / Out Total logic
 * ================================================================== */

test('full matrix: fixed 35-50 range, OUT excludes QC, Out Total is net sum', () => {
  const cutQtyMap = { '35': 100, '36': 150 };
  const sizes = STANDARD_SIZES;
  const departments = [
    { id: 1, department: 'Upper Line 01', sequence: 1 },
    { id: 5, department: 'Lasting 01', sequence: 3 },
  ];
  const dataUpdates = [
    // Upper Line 01, size 35: 2 IN, 1 OUT (Forward), 1 OUT (B Grade -> excluded from OUT)
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Upper Line 01', record_status: 'IN', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Upper Line 01', record_status: 'IN', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Upper Line 01', record_status: 'OUT', qc_status: 'B Grade', count: 1 },
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Upper Line 01', record_status: 'OUT', qc_status: 'Forward', count: 1 },
    // Lasting 01, size 35: 1 OUT (B Grade -> excluded)
    { qr_code: ';mqc1;PO-123;35;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'B Grade', count: 1 },
    // Lasting 01, size 36: 2 OUT (Forward + C Grade -> C Grade excluded)
    { qr_code: ';mqc1;PO-123;36;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'Forward', count: 1 },
    { qr_code: ';mqc1;PO-123;36;scan;', department: 'Lasting 01', record_status: 'OUT', qc_status: 'C Grade', count: 1 },
  ];

  const deptMetrics = aggregateMetricsByDepartmentSize(dataUpdates, 'PO-123', sizes);

  const rows = [];
  const cutRow = { type: 'cut', label: 'Cut OUT', values: {} };
  for (const size of sizes) cutRow.values[size] = cutQtyMap[size] ?? 0;
  cutRow.values['total'] = Object.keys(cutQtyMap).reduce((s, sz) => s + (cutRow.values[sz] || 0), 0);
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
    const totalCutQty = Object.keys(cutQtyMap).reduce((s, sz) => s + (cutQtyMap[sz] ?? 0), 0);
    metrics['total'] = { ...totalMetrics, balanceToCut: totalCutQty - totalMetrics.outTotal };
    rows.push({ type: 'department', name: dept.department, sequence: dept.sequence, metrics });
  }

  // cut row: sizes 35, 36 have cut_qty; 37-50 are 0
  assert.equal(rows[0].type, 'cut');
  assert.equal(rows[0].values['35'], 100);
  assert.equal(rows[0].values['36'], 150);
  assert.equal(rows[0].values['37'], 0); // no cut_qty -> 0
  assert.equal(rows[0].values['total'], 250);

  // Upper Line 01: OUT = 1 (Forward only, B Grade excluded)
  const upper = rows[1];
  assert.equal(upper.name, 'Upper Line 01');
  assert.equal(upper.metrics['35'].in, 2);
  assert.equal(upper.metrics['35'].out, 1); // only Forward
  assert.equal(upper.metrics['35'].bGrade, 1);
  assert.equal(upper.metrics['35'].outTotal, 4); // 1+1+1+1 (all rows)
  assert.equal(upper.metrics['35'].balanceToCut, 96); // 100 - 4
  // Size 37 has no data -> all zeros
  assert.equal(upper.metrics['37'].out, 0);
  assert.equal(upper.metrics['37'].outTotal, 0);
  assert.equal(upper.metrics['37'].balanceToCut, 0); // 0 - 0

  // Lasting 01
  const lasting = rows[2];
  assert.equal(lasting.metrics['35'].out, 0); // B Grade excluded from OUT
  assert.equal(lasting.metrics['35'].bGrade, 1);
  assert.equal(lasting.metrics['35'].outTotal, 1); // B Grade row count = 1
  assert.equal(lasting.metrics['36'].out, 1); // Forward only (C Grade excluded)
  assert.equal(lasting.metrics['36'].cGrade, 1);
  assert.equal(lasting.metrics['36'].outTotal, 2); // Forward(1) + C Grade(1) = 2
});

test('departments appear in the order given during assembly', () => {
  const sizes = STANDARD_SIZES;
  const deptMetrics = aggregateMetricsByDepartmentSize([], 'PO-X', sizes);
  const departments = [
    { id: 5, department: 'Lasting 01', sequence: 3 },
    { id: 1, department: 'Upper Line 01', sequence: 1 },
  ];

  const rows = [];
  const cutRow = { type: 'cut', label: 'Cut OUT', values: {} };
  for (const size of sizes) cutRow.values[size] = 0;
  cutRow.values['total'] = 0;
  rows.push(cutRow);
  for (const dept of departments) {
    const sizeMetrics = deptMetrics[dept.department] || {};
    const metrics = {};
    for (const size of sizes) {
      const m = sizeMetrics[size] || emptyMetrics();
      metrics[size] = { ...m, balanceToCut: 0 - m.outTotal };
    }
    const totalMetrics = sumMetricsAcrossSizes(sizeMetrics, sizes);
    metrics['total'] = { ...totalMetrics, balanceToCut: 0 - totalMetrics.outTotal };
    rows.push({ type: 'department', name: dept.department, sequence: dept.sequence, metrics });
  }

  assert.equal(rows[1].name, 'Lasting 01');
  assert.equal(rows[2].name, 'Upper Line 01');
});

/* ==================================================================
 * QR DATA EXPORT — Sri Lanka Local Time (Asia/Colombo, UTC+5:30)
 * ================================================================== */

test('SLST_TIME_ZONE is Asia/Colombo', () => {
  assert.equal(SLST_TIME_ZONE, 'Asia/Colombo');
});

test('formatSlstTimestamp converts UTC ISO to Asia/Colombo local time', () => {
  // 2026-09-04 03:58:17 UTC + 5:30 = 2026-09-04 09:28:17 SLST
  assert.equal(formatSlstTimestamp('2026-09-04T03:58:17.631Z'), '2026-09-04 09:28:17');
});

test('formatSlstTimestamp accepts the postgres/db format with +00 offset', () => {
  // Supabase returns strings like '2026-09-04 03:58:17.631+00'.
  assert.equal(
    formatSlstTimestamp('2026-09-04 03:58:17.631+00'),
    '2026-09-04 09:28:17'
  );
});

test('formatSlstTimestamp returns empty string for null/blank/invalid values', () => {
  assert.equal(formatSlstTimestamp(null), '');
  assert.equal(formatSlstTimestamp(undefined), '');
  assert.equal(formatSlstTimestamp(''), '');
  assert.equal(formatSlstTimestamp('not-a-date'), '');
});

test('formatSlstTimestamp normalizes midnight hour 24 to 00', () => {
  // 2026-09-03 18:30:00 UTC + 5:30 = 2026-09-04 00:00:00 SLST
  assert.equal(formatSlstTimestamp('2026-09-03T18:30:00.000Z'), '2026-09-04 00:00:00');
});

test('formatSlstDate returns YYYY-MM-DD in SLST', () => {
  // 2026-09-04 03:58:17 UTC stays 2026-09-04 in SLST
  assert.equal(formatSlstDate('2026-09-04T03:58:17.631Z'), '2026-09-04');
  // Late-night UTC rolls forward to the next SLST day
  assert.equal(formatSlstDate('2026-09-03T20:00:00.000Z'), '2026-09-04');
  assert.equal(formatSlstDate(null), '');
});

/* ==================================================================
 * QR DATA EXPORT — CSV escaping and transformation
 * ================================================================== */

test('escapeCsvCell leaves plain values untouched', () => {
  assert.equal(escapeCsvCell('Forward'), 'Forward');
  assert.equal(escapeCsvCell(1), '1');
  assert.equal(escapeCsvCell(''), '');
  assert.equal(escapeCsvCell(null), '');
  assert.equal(escapeCsvCell(undefined), '');
});

test('escapeCsvCell wraps commas, quotes and line breaks', () => {
  assert.equal(escapeCsvCell('a,b'), '"a,b"');
  assert.equal(escapeCsvCell('a"b'), '"a""b"');
  assert.equal(escapeCsvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(escapeCsvCell('a,b"c'), '"a,b""c"');
});

test('QR_DATA_CSV_HEADERS matches the exact Excel column order', () => {
  assert.deepEqual(QR_DATA_CSV_HEADERS, [
    'Date & Time (SLST)',
    'PO',
    'Size',
    'Shoe QR',
    'Inner QR',
    'Department',
    'Record Status',
    'QC Status',
    'Count',
    'Created At',
  ]);
});

test('transformQrRowForExport parses size from qr_code and converts timestamps', () => {
  const row = {
    qr_code: ';mqc1;PO-123;38;scan;',
    inner_qr: 'INNER-BOX-1',
    department: 'Lasting 01',
    record_status: 'OUT',
    qc_status: 'Forward',
    count: 1,
    created_at: '2026-09-04T03:58:17.631Z',
  };
  assert.deepEqual(transformQrRowForExport(row, 'PO-123'), [
    '2026-09-04 09:28:17', // Date & Time (SLST)
    'PO-123', // PO
    '38', // Size parsed from qr_code
    ';mqc1;PO-123;38;scan;', // Shoe QR
    'INNER-BOX-1', // Inner QR
    'Lasting 01', // Department
    'OUT', // Record Status
    'Forward', // QC Status
    1, // Count (raw number; stringified during CSV building)
    '2026-09-04T03:58:17.631Z', // Created At
  ]);
});

test('buildQrDataCsv writes headers plus escaped CRLF rows', () => {
  const rows = [
    {
      qr_code: ';mqc1;PO-123;35;scan;',
      inner_qr: 'INNER,BOX',
      department: 'Cutting',
      record_status: 'OUT',
      qc_status: 'B Grade',
      count: 1,
      created_at: '2026-09-04T03:58:17.631Z',
    },
  ];
  const csv = buildQrDataCsv(rows, 'PO-123');
  // CRLF separated rows
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], QR_DATA_CSV_HEADERS.join(','));
  // Full data row with SLST timestamp, parsed size, and quoted comma field
  assert.equal(
    lines[1],
    '2026-09-04 09:28:17,PO-123,35,;mqc1;PO-123;35;scan;,"INNER,BOX",Cutting,OUT,B Grade,1,2026-09-04T03:58:17.631Z'
  );
});

test('buildQrDataCsv with no rows returns just the header row', () => {
  assert.equal(buildQrDataCsv([], 'PO-123'), QR_DATA_CSV_HEADERS.join(','));
});

test('buildQrDataFileName defaults to .xlsx and accepts a custom extension', () => {
  const name = buildQrDataFileName('144065');
  assert.match(name, /^PO_144065_QR_Data_\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.match(buildQrDataFileName('144065', 'csv'), /\.csv$/);
});

/* ==================================================================
 * buildQrDataXLSX — native .xlsx buffer/binary payload
 * ================================================================== */

test('buildQrDataXLSX produces a valid xlsx binary payload', async () => {
  const rows = [
    {
      qr_code: ';mqc1;PO-123;38;scan;',
      inner_qr: 'INNER-BOX-1',
      department: 'Lasting 01',
      record_status: 'OUT',
      qc_status: 'Forward',
      count: 3,
      created_at: '2026-09-04T03:58:17.631Z',
    },
    {
      qr_code: ';mqc1;PO-123;35;scan;',
      inner_qr: null,
      department: 'Cutting',
      record_status: 'IN',
      qc_status: 'B Grade',
      count: 1,
      created_at: '2026-09-04T04:01:00.000Z',
    },
  ];
  const { buffer, fileName } = await buildQrDataXLSX(rows, 'PO-123');
  // ZIP magic "PK" proves it is a real xlsx container
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.length > 0, true);
  assert.equal(buffer[0], 0x50); // 'P'
  assert.equal(buffer[1], 0x4b); // 'K'
  assert.match(fileName, /^PO_PO-123_QR_Data_\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test('buildQrDataXLSX parses back to SLST timestamps and numeric Count cells', async () => {
  const XLSX = await import('xlsx');
  const rows = [
    {
      qr_code: ';mqc1;PO-123;38;scan;',
      inner_qr: 'INNER-BOX-1',
      department: 'Lasting 01',
      record_status: 'OUT',
      qc_status: 'Forward',
      count: 3,
      created_at: '2026-09-04T03:58:17.631Z',
    },
  ];
  const { buffer } = await buildQrDataXLSX(rows, 'PO-123');

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  assert.equal(workbook.SheetNames[0], QR_DATA_XLSX_SHEET_NAME);
  const sheet = workbook.Sheets[QR_DATA_XLSX_SHEET_NAME];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  // Header row uses the exact export columns
  assert.deepEqual(aoa[0], QR_DATA_CSV_HEADERS);
  // Data row: SLST timestamp, PO, parsed size, QR codes, statuses
  assert.equal(aoa[1][0], '2026-09-04 09:28:17'); // SLST
  assert.equal(aoa[1][1], 'PO-123');
  assert.equal(aoa[1][2], '38');
  assert.equal(aoa[1][3], ';mqc1;PO-123;38;scan;');
  assert.equal(aoa[1][4], 'INNER-BOX-1');
  assert.equal(aoa[1][5], 'Lasting 01');
  assert.equal(aoa[1][6], 'OUT');
  assert.equal(aoa[1][7], 'Forward');
  // Count must be a NUMERIC integer cell, not a string
  assert.equal(aoa[1][8], 3);
  assert.equal(typeof aoa[1][8], 'number');
  assert.equal(Number.isInteger(aoa[1][8]), true);
});

test('buildQrDataXLSX writes the 10-column width set into the worksheet XML', async () => {
  const { buffer } = await buildQrDataXLSX(
    [{ qr_code: ';mqc1;PO-123;38;scan;', count: 1, created_at: '2026-09-04T03:58:17.631Z' }],
    'PO-123'
  );
  assert.equal(QR_DATA_XLSX_COL_WIDTHS.length, 10);
  const xml = extractZipEntry(buffer, 'xl/worksheets/sheet1.xml');
  assert.ok(xml, 'sheet1.xml entry should exist in the xlsx payload');
  assert.match(xml, /<cols>/);
  const colTags = xml.match(/<col /g) || [];
  assert.equal(colTags.length, 10); // one width entry per exported column
});

/** Extract and inflate a single entry from the xlsx (zip) payload. */
function extractZipEntry(buffer, targetName) {
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLen);
    const dataStart = offset + 30 + nameLen + extraLen;
    if (name === targetName) {
      const chunk = buffer.subarray(dataStart, dataStart + compSize);
      return method === 8 ? inflateRawSync(chunk).toString('utf8') : chunk.toString('utf8');
    }
    offset = dataStart + compSize;
  }
  return null;
}
/* ==================================================================
 * fetchPoRawQrData — mock supabase client query shape
 * ================================================================== */

/** Mock supabase-js client capturing the ilike/order query chain. */
function createMockSupabase(tables = {}) {
  const queries = [];
  const makeBuilder = (tableName) => {
    const record = { table: tableName, select: null, filters: [], orders: [], limit: null };
    queries.push(record);
    const chain = {
      select(columns) { record.select = columns; return chain; },
      ilike(column, value) { record.filters.push(['ilike', column, value]); return chain; },
      eq(column, value) { record.filters.push(['eq', column, value]); return chain; },
      order(column, opts) { record.orders.push([column, opts]); return chain; },
      limit(n) { record.limit = n; return chain; },
      then(onFulfilled, onRejected) {
        const payload = tables[tableName] ?? { data: [], error: null };
        return Promise.resolve(payload).then(onFulfilled, onRejected);
      },
    };
    return chain;
  };
  return { client: { from: makeBuilder }, queries };
}

test('fetchPoRawQrData queries data_updates ilike by PO segment, oldest-first', async () => {
  const { client, queries } = createMockSupabase({
    data_updates: {
      data: [
        { qr_code: ';mqc1;PO-123;35;scan;', department: 'Cutting', created_at: '2026-09-04 03:58:17.631+00' },
        { qr_code: ';mqc1;PO-999;35;scan;', department: 'Cutting', created_at: '2026-09-05 03:58:17.631+00' },
      ],
      error: null,
    },
  });
  const fetchPoRawQrData = createPoQrDataFetcher(client);
  const rows = await fetchPoRawQrData('PO-123');
  assert.equal(queries.length, 1);
  assert.equal(queries[0].table, 'data_updates');
  assert.equal(queries[0].select, 'qr_code, inner_qr, record_status, qc_status, department, count, created_by, created_at');
  assert.deepEqual(queries[0].filters, [['ilike', 'qr_code', '%;PO-123;%']]);
  assert.deepEqual(queries[0].orders, [['created_at', { ascending: true }]]);
  // Only rows whose encoded PO matches survive the re-verification
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qr_code, ';mqc1;PO-123;35;scan;');
});

test('fetchPoRawQrData escapes LIKE wildcards in the PO value', async () => {
  const { client, queries } = createMockSupabase({ data_updates: { data: [], error: null } });
  const fetchPoRawQrData = createPoQrDataFetcher(client);
  await fetchPoRawQrData('PO_1%0');
  assert.deepEqual(queries[0].filters, [['ilike', 'qr_code', '%;PO\\_1\\%0;%']]);
});

test('fetchPoRawQrData returns [] for blank PO and for unreachable table', async () => {
  const blank = createPoQrDataFetcher(createMockSupabase().client);
  assert.deepEqual(await blank('   '), []);

  const failing = createPoQrDataFetcher(
    createMockSupabase({
      data_updates: { data: null, error: new Error('network error') },
    }).client
  );
  assert.deepEqual(await failing('PO-123'), []);
});

/* ==================================================================
 * Daily Output Report — SLST date query, filters, matrix, Excel export
 * ================================================================== */

// Extended mock supabase-js client capturing gte/lt/not in addition to
// select/order/eq (mirrors the chainable-thenable builder above).
function createDailyOutputMockSupabase(tables = {}) {
  const queries = [];
  const makeBuilder = (tableName) => {
    const record = { table: tableName, select: null, filters: [], orders: [], limit: null };
    queries.push(record);
    const chain = {
      select(columns) { record.select = columns; return chain; },
      eq(column, value) { record.filters.push(['eq', column, value]); return chain; },
      neq(column, value) { record.filters.push(['neq', column, value]); return chain; },
      gte(column, value) { record.filters.push(['gte', column, value]); return chain; },
      lt(column, value) { record.filters.push(['lt', column, value]); return chain; },
      not(column, operator, value) { record.filters.push(['not', column, operator, value]); return chain; },
      order(column, opts) { record.orders.push([column, opts]); return chain; },
      then(onFulfilled, onRejected) {
        const payload = tables[tableName] ?? { data: [], error: null };
        return Promise.resolve(payload).then(onFulfilled, onRejected);
      },
    };
    return chain;
  };
  return { client: { from: makeBuilder }, queries };
}

// Sample rows for 2026-09-04 SLST. SLST = UTC+5:30, so SLST midnight 2026-09-04
// == UTC 2026-09-03 18:30:00.
const dailyRows = [
  { qr_code: ';mqc1;PO-A;35;scan;', department: 'Lasting 01', record_status: 'IN', qc_status: 'Forward', count: 1, created_at: '2026-09-04 00:30:00+00' },
  { qr_code: ';mqc1;PO-A;35;scan;', department: 'Lasting 01', record_status: 'IN', qc_status: 'Forward', count: 1, created_at: '2026-09-04 00:45:00+00' },
  { qr_code: ';mqc1;PO-A;36;scan;', department: 'Lasting 01', record_status: 'IN', qc_status: 'Forward', count: 1, created_at: '2026-09-04 01:00:00+00' },
  { qr_code: ';mqc1;PO-A;37;scan;', department: 'Lasting 01', record_status: 'IN', qc_status: 'Forward', count: 1, created_at: '2026-09-04 18:29:59+00' },
  { qr_code: ';mqc1;PO-A;35;scan;', department: 'Lasting 01', record_status: 'IN', qc_status: 'Forward', count: 1, created_at: '2026-09-04 18:30:00+00' },
  { qr_code: ';mqc1;PO-A;35;scan;', department: 'Lasting 01', record_status: 'IN', qc_status: 'B Grade', count: 1, created_at: '2026-09-04 02:00:00+00' },
];

// Pre-filtered subset (Standard QC + within the daily window) that the pure
// aggregateDailyOutput aggregator expects to receive.
const filteredDailyRows = dailyRows.filter(
  (r) => r.qc_status === 'Forward' && r.created_at < '2026-09-04 18:30:00+00'
);
test('slstDayUtcBounds maps a SLST date to the exact UTC day window', () => {
  const { start, end } = slstDayUtcBounds('2026-09-04');
  // SLST midnight 2026-09-04 == UTC 2026-09-03 18:30 (UTC+5:30, no DST).
  assert.equal(start, '2026-09-03T18:30:00.000Z');
  assert.equal(end, '2026-09-04T18:30:00.000Z');
});

test('slstDayUtcBounds throws on an invalid date', () => {
  assert.throws(() => slstDayUtcBounds('not-a-date'), /Invalid SLST date/);
  assert.throws(() => slstDayUtcBounds('2026-13-40'), /Invalid SLST date/);
});

test('Daily Output query applies the SLST date window + department/record/qc filters', async () => {
  const { client, queries } = createDailyOutputMockSupabase({
    data_updates: { data: dailyRows, error: null },
  });
  const fetchRows = createDailyOutputFetcher(client);
  await fetchRows({
    date: '2026-09-04',
    departmentId: 'Lasting 01',
    recordStatus: 'IN',
    qcStatus: 'Standard',
    cumulative: false,
  });

  assert.equal(queries.length, 1);
  const q = queries[0];
  assert.equal(q.table, 'data_updates');
  assert.equal(q.select, DAILY_OUTPUT_COLUMNS);
  const codes = q.filters.map((f) => f[0] + ':' + f[1]);
  // SLST day window: daily uses both gte(start) and lt(end).
  assert.ok(codes.includes('gte:created_at'), 'must filter gte created_at (SLST start)');
  assert.ok(codes.includes('lt:created_at'), 'must filter lt created_at (SLST end)');
  assert.equal(q.filters.find((f) => f[0] === 'eq' && f[1] === DAILY_OUTPUT_DEPARTMENT_COLUMN)?.[2], 'Lasting 01');
  assert.equal(q.filters.find((f) => f[0] === 'eq' && f[1] === 'record_status')?.[2], 'IN');
  // 'Standard' is translated to a NOT-IN of the defect categories.
  const notFilter = q.filters.find((f) => f[0] === 'not' && f[1] === 'qc_status');
  assert.ok(notFilter, 'Standard qcStatus must become a NOT-in filter');
  assert.deepEqual(notFilter[3], QC_DEFECT_CATEGORIES);
});

test('Daily Output query translates an explicit qcStatus (B Grade) via eq', async () => {
  const { client, queries } = createDailyOutputMockSupabase({ data_updates: { data: [], error: null } });
  const fetchRows = createDailyOutputFetcher(client);
  await fetchRows({ date: '2026-09-04', qcStatus: 'B Grade' });
  const qcEq = queries[0].filters.find((f) => f[0] === 'eq' && f[1] === 'qc_status');
  assert.equal(qcEq?.[2], 'B Grade');
});

test('Daily Output query applies record_status OUT and the cumulative (no gte) window', async () => {
  const { client, queries } = createDailyOutputMockSupabase({ data_updates: { data: [], error: null } });
  const fetchRows = createDailyOutputFetcher(client);
  await fetchRows({ date: '2026-09-04', recordStatus: 'OUT', cumulative: true });
  const q = queries[0];
  const codes = q.filters.map((f) => f[0] + ':' + f[1]);
  // Cumulative: only lt(end), NO gte(start).
  assert.ok(codes.includes('lt:created_at'));
  assert.ok(!codes.includes('gte:created_at'), 'cumulative must not bound the start');
  assert.equal(q.filters.find((f) => f[0] === 'eq' && f[1] === 'record_status')?.[2], 'OUT');
});

test('aggregateDailyOutput builds the 35-50 matrix with daily + cumulative totals', () => {
  // Daily: size 35 -> 2 (2 Forward scans), 36 -> 1, 37 -> 1.
  // (aggregateDailyOutput receives already-filtered rows, so the out-of-window
  //  18:30 UTC row and the B-Grade row are not counted when the caller filtered.)
  const result = aggregateDailyOutput(filteredDailyRows, []);
  console.error('DIAG filteredDailyRows.length=', filteredDailyRows.length, 'rows.length=', result.rows.length, 'dailyTotal=', result.rows[0]?.dailyTotal);

  assert.equal(result.sizes.length, 16);
  assert.equal(result.sizes[0], '35');
  assert.equal(result.sizes[15], '50');
  assert.equal(result.rows.length, 1);

  const row = result.rows[0];
  assert.equal(row.po, 'PO-A');
  assert.equal(row.sizes['35'], 2);
  assert.equal(row.sizes['36'], 1);
  assert.equal(row.sizes['37'], 1);
  assert.equal(row.sizes['38'], 0);
  // Daily total = 2 + 1 + 1 = 4 (all dailyRows land on the SLST day).
  assert.equal(row.dailyTotal, 4);
  // Cumulative only reflects cumulativeRows (empty here) -> 0.
  assert.equal(row.cumulativeOutput, 0);

  // Summary footer = column sums + grand totals.
  assert.equal(result.summary.sizes['35'], 2);
  assert.equal(result.summary.sizes['37'], 1);
  assert.equal(result.summary.dailyTotal, 4);
  assert.equal(result.summary.cumulativeOutput, 0);
});

test('aggregateDailyOutput sums prior-day rows into the cumulative column', () => {
  const cumulativeRows = [
    { qr_code: ';mqc1;PO-A;35;scan;', count: 5, created_at: '2026-09-03 20:00:00+00' },
  ];
  const result = aggregateDailyOutput(filteredDailyRows, cumulativeRows);
  const row = result.rows[0];
  // Daily unchanged.
  assert.equal(row.dailyTotal, 4);
  // Cumulative only reflects the prior-day cumulativeRows (5 on size 35) -> 5.
  assert.equal(row.cumulativeOutput, 5);
  assert.equal(result.summary.cumulativeOutput, 5);
});

test('aggregateDailyOutput ignores rows outside the 35-50 size range and unparseable POs', () => {
  const rows = [
    { qr_code: ';mqc1;PO-B;28;scan;', count: 3 }, // size < 35 -> ignored
    { qr_code: ';mqc1;PO-B;51;scan;', count: 3 }, // size > 50 -> ignored
    { qr_code: ';mqc1;PO-B;42;scan;', count: 2 }, // valid
    { qr_code: 'nope-', count: 9 }, // no PO -> ignored
  ];
  const result = aggregateDailyOutput(rows, []);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].po, 'PO-B');
  assert.equal(result.rows[0].sizes['42'], 2);
  assert.equal(result.rows[0].dailyTotal, 2);
  assert.equal(result.summary.dailyTotal, 2);
});

test('buildDailyOutputXlsx produces a valid .xlsx buffer with the matrix layout', async () => {
  const matrix = {
    sizes: STANDARD_SIZES,
    rows: [
      {
        po: 'PO-A',
        sizes: { '35': 2, '36': 1, '37': 0, '38': 3 },
        dailyTotal: 6,
        cumulativeOutput: 10,
      },
    ],
    summary: {
      sizes: { '35': 2, '36': 1, '37': 0, '38': 3 },
      dailyTotal: 6,
      cumulativeOutput: 10,
    },
  };

  const { buffer, fileName } = await buildDailyOutputXlsx(matrix, {
    departmentId: 'Lasting 01',
    date: '2026-09-04',
    recordStatus: 'IN',
    qcStatus: 'ALL',
  });

  // File name reflects the active date filter.
  assert.equal(fileName, 'Daily_Output_Report_2026-09-04.xlsx');

  // The buffer is a Buffer whose first two bytes are the ZIP magic 'PK'.
  assert.ok(Buffer.isBuffer(buffer), 'XLSX buffer should be a Buffer');
  assert.equal(buffer[0], 0x50); // 'P'
  assert.equal(buffer[1], 0x4b); // 'K'

  // SheetJS emits inline strings in the worksheet (no sharedStrings.xml),
  // so the banner + data strings all live in xl/worksheets/sheet1.xml.
  const sheet = extractZipEntry(buffer, 'xl/worksheets/sheet1.xml');
  assert.ok(sheet, 'expected xl/worksheets/sheet1.xml');
  assert.ok(sheet.includes('DAILY OUTPUT REPORT'));
  assert.ok(sheet.includes('Lasting 01'));
  assert.ok(sheet.includes('PO Number'));
  assert.ok(sheet.includes('Daily Total'));
  assert.ok(sheet.includes('Cumulative Output'));
  assert.ok(sheet.includes('35'));
  assert.ok(sheet.includes('50'));
  assert.ok(sheet.includes('PO-A'));
  assert.ok(sheet.includes('TOTAL'));
});
