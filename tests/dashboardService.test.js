'use strict';

// Tests for the Live Dashboard service layer (lib/dashboardService.js):
// shift bucketing, validity filtering, week building and the aggregation
// functions backing the horse-race progress + hourly/weekly charts.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DASH_SHIFTS,
  DASH_INVALID_QC_STATUSES,
  isValidProductionRow,
  buildWeekDates,
  shiftMinutes,
  aggregateHourlyOutput,
  aggregateWeeklyOutput,
  elapsedPlannedHours,
  computeGpsTarget,
  createDashPlannedHoursFetcher,
  ROTATION_INTERVAL_MS,
} from '../lib/dashboardService.js';

test('shift plan exposes the exact 10 SLST hour ranges', () => {
  assert.equal(DASH_SHIFTS.length, 10);
  assert.deepEqual(
    DASH_SHIFTS.map((s) => s.range),
    [
      '7.45 - 8.45',
      '8.45 - 9.45',
      '9.45 - 10.45',
      '10.45 - 11.45',
      '11.45 - 1.15',
      '1.15 - 2.15',
      '2.15 - 3.15',
      '3.15 - 4.30',
      '4.30 - 5.30',
      '5.30 - 6.30',
    ]
  );
});

test('ROTATION_INTERVAL_MS is 15 seconds', () => {
  assert.equal(ROTATION_INTERVAL_MS, 15000);
});

test('invalid QC statuses cover B/C grade, return, rework and lab testing', () => {
  for (const status of ['B Grade', 'C Grade', 'Return', 'Reworked', 'Lab Testing']) {
    assert.ok(DASH_INVALID_QC_STATUSES.includes(status), status);
  }
});

test('isValidProductionRow excludes defect categories but keeps null and valid', () => {
  assert.equal(isValidProductionRow({ qc_status: null }), true);
  assert.equal(isValidProductionRow({ qc_status: 'Standard' }), true);
  assert.equal(isValidProductionRow({ qc_status: 'B Grade' }), false);
  assert.equal(isValidProductionRow({ qc_status: 'Return' }), false);
  assert.equal(isValidProductionRow({ qc_status: 'Reworked' }), false);
});

test('buildWeekDates returns Monday-first week containing the date', () => {
  const week = buildWeekDates('2026-09-09'); // Wednesday
  assert.deepEqual(week, [
    '2026-09-07',
    '2026-09-08',
    '2026-09-09',
    '2026-09-10',
    '2026-09-11',
    '2026-09-12',
    '2026-09-13',
  ]);
  assert.equal(buildWeekDates('2026-09-06')[0], '2026-08-31'); // Sunday week
  assert.throws(() => buildWeekDates('not-a-date'));
});

test('shiftMinutes converts HH:mm to minutes since midnight', () => {
  assert.equal(shiftMinutes('07:45'), 465);
  assert.equal(shiftMinutes('13:15'), 795);
  assert.equal(shiftMinutes(''), 0);
});

test('aggregateHourlyOutput buckets valid scans and drops excluded statuses', () => {
  const rows = [
    { created_at: '2026-09-09 02:30:00+00', count: 10, qc_status: null }, // 08:00 SLST -> Hour 1
    { created_at: '2026-09-09 03:00:00+00', count: 5, qc_status: 'B Grade' }, // excluded
    { created_at: '2026-09-09 04:00:00+00', count: 7, qc_status: 'Return' }, // excluded
    { created_at: '2026-09-09 04:30:00+00', count: 20, qc_status: 'Standard' }, // 10:00 -> Hour 3
    { created_at: '2026-09-09 09:00:00+00', count: 3, qc_status: '' }, // 14:30 SLST -> Hour 7
    { created_at: '2026-09-09 08:50:00+00', count: -2, qc_status: 'Reworked' }, // excluded
  ];
  const buckets = aggregateHourlyOutput(rows);
  assert.equal(buckets.length, 10);
  assert.equal(buckets[0].qty, 10); // Hour 1
  assert.equal(buckets[1].qty, 0);
  assert.equal(buckets[2].qty, 20); // Hour 3
  assert.equal(buckets[6].qty, 3); // Hour 7
  const total = buckets.reduce((s, b) => s + b.qty, 0);
  assert.equal(total, 33);
});

test('aggregateWeeklyOutput buckets scans into Mon-Sun by SLST date', () => {
  const week = buildWeekDates('2026-09-09');
  const rows = [
    { created_at: '2026-09-07 05:00:00+00', count: 12 }, // Mon 10:30 SLST
    { created_at: '2026-09-08 06:00:00+00', count: 8, qc_status: 'C Grade' }, // excluded
    { created_at: '2026-09-09 04:00:00+00', count: 15 }, // Wed
    { created_at: '2026-09-14 04:00:00+00', count: 99 }, // next Monday -> ignored
  ];
  const weekly = aggregateWeeklyOutput(rows, week);
  assert.equal(weekly.length, 7);
  assert.equal(weekly[0].day, 'Mon');
  assert.equal(weekly[0].qty, 12);
  assert.equal(weekly[2].qty, 15);
  assert.equal(weekly.reduce((s, w) => s + w.qty, 0), 27);
});

// ---------------- Data Admin service (lib/dashAdminService.js) ----------------

const {
  validateDashForm,
  normalizeDashRow,
} = await import('../lib/dashAdminService.js');

test('validateDashForm accepts a valid dash record', () => {
  const result = validateDashForm({
    date: '2026-09-09',
    department: 'Desma',
    planed_qty: '1200',
    planed_hour: '9.5',
    eficiancy: '85.5',
    available_man_power: '45',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, {
    date: '2026-09-09',
    department: 'Desma',
    planed_qty: 1200,
    planed_hour: 9.5,
    eficiancy: 85.5,
    available_man_power: 45,
  });
});

test('validateDashForm rejects invalid fields', () => {
  assert.equal(validateDashForm({ date: 'bad', department: '', planed_qty: -1, planed_hour: -2, eficiancy: 200, available_man_power: 2.5 }).ok, false);
  const result = validateDashForm({
    date: 'nope',
    department: '  ',
    planed_qty: 'x',
    planed_hour: 0,
    eficiancy: 150,
    available_man_power: 'a',
  });
  assert.equal(result.ok, false);
  for (const key of ['date', 'department', 'planed_qty', 'planed_hour', 'eficiancy', 'available_man_power']) {
    assert.ok(result.errors[key], key);
  }
});

test('validateDashForm treats empty efficiency as 0', () => {
  const result = validateDashForm({
    date: '2026-09-09',
    department: 'Lasting 01',
    planed_qty: 10,
    planed_hour: 8,
    eficiancy: '',
    available_man_power: 3,
  });
  assert.equal(result.ok, true);
  assert.equal(result.values.eficiancy, 0);
});

test('normalizeDashRow coerces dash row types', () => {
  const row = normalizeDashRow({
    id: 7,
    date: '2026-09-09',
    department: 'Desma',
    planed_qty: '500',
    planed_hour: '9.5',
    eficiancy: '62.5',
    available_man_power: '12',
  });
  assert.equal(row.id, 7);
  assert.equal(row.planed_qty, 500);
  assert.equal(row.planed_hour, 9.5);
  assert.equal(row.eficiancy, 62.5);
  assert.equal(row.available_man_power, 12);
  assert.deepEqual(normalizeDashRow(null).department, '');
  assert.equal(normalizeDashRow(null).planed_hour, null);
});

// ---------------- Rotation department selection ----------------

const {
  ROTATION_DEPTS_STORAGE_KEY,
  filterRotationDepartments,
  loadRotationDepartments,
  saveRotationDepartments,
} = await import('../lib/dashboardService.js');

/** Minimal localStorage stub. */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

test('filterRotationDepartments falls back to all when selection is empty', () => {
  const available = ['Desma', 'Lasting 01', 'Cutting'];
  assert.deepEqual(filterRotationDepartments(available, []), available);
  assert.deepEqual(filterRotationDepartments(available, undefined), available);
  assert.deepEqual(filterRotationDepartments(available, null), available);
  assert.deepEqual(filterRotationDepartments(available, 'not-an-array'), available);
  assert.deepEqual(filterRotationDepartments(available), available);
  assert.deepEqual(filterRotationDepartments([], []), []);
});

test('filterRotationDepartments keeps only selected departments in order', () => {
  const available = ['Desma', 'Lasting 01', 'Cutting'];
  assert.deepEqual(filterRotationDepartments(available, ['Cutting', 'Desma']), [
    'Desma',
    'Cutting',
  ]);
});

test('filterRotationDepartments falls back to all when none of the selection exist', () => {
  const available = ['Desma', 'Lasting 01'];
  assert.deepEqual(filterRotationDepartments(available, ['Ghost Dept']), available);
});

test('saveRotationDepartments persists and loadRotationDepartments restores', () => {
  const storage = makeStorage();
  assert.equal(saveRotationDepartments(['Desma', 'Lasting 01'], storage), true);
  assert.deepEqual(loadRotationDepartments(storage), ['Desma', 'Lasting 01']);

  // Empty list clears the stored preference entirely.
  assert.equal(saveRotationDepartments([], storage), true);
  assert.equal(storage.getItem(ROTATION_DEPTS_STORAGE_KEY), null);
  assert.deepEqual(loadRotationDepartments(storage), []);
});

test('loadRotationDepartments tolerates corrupt or invalid stored data', () => {
  const corrupt = makeStorage();
  corrupt.setItem(ROTATION_DEPTS_STORAGE_KEY, '{not json');
  assert.deepEqual(loadRotationDepartments(corrupt), []);

  const wrongType = makeStorage();
  wrongType.setItem(ROTATION_DEPTS_STORAGE_KEY, JSON.stringify('nope'));
  assert.deepEqual(loadRotationDepartments(wrongType), []);

  const withGarbage = makeStorage();
  withGarbage.setItem(
    ROTATION_DEPTS_STORAGE_KEY,
    JSON.stringify(['Desma', 42, null, ' ', 'Cutting'])
  );
  assert.deepEqual(loadRotationDepartments(withGarbage), ['Desma', 'Cutting']);
});

test('loadRotationDepartments is safe server-side (no window)', () => {
  assert.deepEqual(loadRotationDepartments(null), []);
  assert.equal(saveRotationDepartments(['Desma'], null), true);
});
