// Concord TrackSync - Live Dashboard service.
//
// Server-safe data + aggregation layer for the factory-floor Live Dashboard:
//   - `dash` table   -> planned qty / efficiency / available man power
//   - data_updates   -> valid scan counts bucketed into the 10 SLST shift
//                       hours and across the Mon-Sun week
// SLST = UTC+5:30; day/week windows reuse slstDayUtcBounds() from
// reportsService so every boundary matches the reports' timezone handling.
// The module is deliberately isomorphic and carries NO 'use client'
// directive: client components import the pure aggregators + singleton
// fetchers, and the client boundary is declared by the importing component.

import {
  supabase,
  DATA_UPDATES_TABLE,
  DASH_TABLE,
  DASH_COLUMNS,
  DASH_SCAN_COLUMNS,
  DASH_PLANED_HOUR_COLUMN,
  DAILY_OUTPUT_DEPARTMENT_COLUMN,
} from './db.js';
import {
  formatSlstDate,
  formatSlstTimestamp,
  slstDayUtcBounds,
} from './reportsService.js';

// QC statuses whose scans are NOT valid accepted production output. Return
// rows carry count -1 and are excluded outright (they are corrections, not
// production), matching the Daily Output report's "Standard" semantics but
// extended with the two rework/return statuses tracked on the floor.
export const DASH_INVALID_QC_STATUSES = [
  'B Grade',
  'C Grade',
  'Lab Testing',
  'Return',
  'Reworked',
];

// Week-day labels for the weekly chart, Monday-first.
export const WEEK_DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// The exact 10-hour shift plan (SLST wall-clock). `start`/`end` are inclusive/
// exclusive 'HH:mm' bounds; `range` is the display label from the shift plan.
export const DASH_SHIFTS = [
  { label: 'Hour 1', range: '7.45 - 8.45', start: '07:45', end: '08:45' },
  { label: 'Hour 2', range: '8.45 - 9.45', start: '08:45', end: '09:45' },
  { label: 'Hour 3', range: '9.45 - 10.45', start: '09:45', end: '10:45' },
  { label: 'Hour 4', range: '10.45 - 11.45', start: '10:45', end: '11:45' },
  { label: 'Hour 5', range: '11.45 - 1.15', start: '11:45', end: '13:15' },
  { label: 'Hour 6', range: '1.15 - 2.15', start: '13:15', end: '14:15' },
  { label: 'Hour 7', range: '2.15 - 3.15', start: '14:15', end: '15:15' },
  { label: 'Hour 8', range: '3.15 - 4.30', start: '15:15', end: '16:30' },
  { label: 'Hour 9', range: '4.30 - 5.30', start: '16:30', end: '17:30' },
  { label: 'Hour 10', range: '5.30 - 6.30', start: '17:30', end: '18:30' },
];

/** 'HH:mm' -> minutes since midnight. */
export function shiftMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

/* ====================================================================
 * Time-based GPS target marker ("where should production be NOW?")
 *
 * The 10 SLST shift windows span 07:45 -> 18:30 (645 minutes = 10.75h,
 * breaks included in the wider Hour 5 / Hour 8 blocks). The department's
 * day plan (`dash.planed_qty`, e.g. 950 units) is expected to be produced
 * within `dash.planed_hour` planned hours (e.g. 9.5h), so the target
 * advances at planed_qty / planed_hour units per planned hour while the
 * shift is running. The expected cumulative count at 'HH:mm' is the
 * time-based GPS target - rendered on the race track as an amber pin
 * alongside the actual-output red car.
 * ==================================================================== */

/** First shift window start / last shift window end (minutes-of-day). */
export const DASH_SHIFT_START_MINUTES = shiftMinutes(DASH_SHIFTS[0].start);
export const DASH_SHIFT_END_MINUTES =
  shiftMinutes(DASH_SHIFTS[DASH_SHIFTS.length - 1].end);

/** Total running hours across the 10 shift windows (645 min = 10.75h). */
export const DASH_SHIFT_WINDOW_HOURS =
  (DASH_SHIFT_END_MINUTES - DASH_SHIFT_START_MINUTES) / 60;

/**
 * Elapsed PLANNED working time (hours) inside the 10 SLST shift windows up
 * to `slstTimeHHmm` ('HH:mm'). Accumulating per window (instead of a plain
 * linear difference) keeps the math exact if break gaps are ever added
 * between windows. Pre-shift returns 0, post-shift the full window.
 */
export function elapsedPlannedHours(slstTimeHHmm) {
  const minutes = shiftMinutes(slstTimeHHmm);
  let elapsedMinutes = 0;
  for (const shift of DASH_SHIFTS) {
    const start = shiftMinutes(shift.start);
    const end = shiftMinutes(shift.end);
    if (minutes <= start) break;
    elapsedMinutes += Math.min(minutes, end) - start;
  }
  return elapsedMinutes / 60;
}

/**
 * The time-based GPS target: the cumulative production count the department
 * SHOULD have reached at `slstTimeHHmm` ("right now").
 *
 *   - With a usable `planed_hour`: target = elapsed planned hours *
 *     (planed_qty / planed_hour). The returned qty is STRICTLY capped at
 *     the day's plan (Math.min(target, planed_qty)) so the GPS pin can
 *     never pass the finish line - even during overtime hours.
 *   - Without a usable `planed_hour` (column missing / not migrated):
 *     graceful fallback - the plan is spread linearly over the full shift
 *     window (07:45 -> 18:30), also capped at the plan.
 *
 * Pure: recomputed by the component on every SLST clock tick so the marker
 * advances between dashboard data refreshes.
 *
 * @param {object} params
 * @param {string} params.slstTimeHHmm current SLST wall-clock 'HH:mm'
 * @param {number|string} params.plannedQty  dash.planed_qty for the day
 * @param {number|string|null} params.plannedHours dash.planed_hour (nullable)
 * @returns {{ qty: number, ratio: number, elapsedHours: number, rate: number|null, plannedHours: number|null, active: boolean }}
 */
export function computeGpsTarget({ slstTimeHHmm, plannedQty, plannedHours }) {
  const qty = Number(plannedQty);
  if (!Number.isFinite(qty) || qty <= 0) {
    // No plan row for the day - nothing to chase, marker hidden.
    return { qty: 0, ratio: 0, elapsedHours: 0, rate: null, plannedHours: null, active: false };
  }
  const elapsed = elapsedPlannedHours(slstTimeHHmm);
  const hours = Number(plannedHours);
  if (Number.isFinite(hours) && hours > 0) {
    const rate = qty / hours;
    const target = Math.max(elapsed * rate, 0);
    // Strict cap: the GPS pin must never exceed the Finish line
    // (planned_qty), even when the elapsed planned hours run past the day.
    return {
      qty: Math.min(target, qty),
      ratio: Math.min(target / qty, 1),
      elapsedHours: elapsed,
      rate,
      plannedHours: hours,
      active: true,
    };
  }
  // Fallback: no usable planed_hour - spread the plan linearly over the
  // full shift window (07:45 -> 18:30, breaks included).
  const linearRatio = elapsedShiftRatio(slstTimeHHmm);
  return {
    qty: Math.min(Math.max(linearRatio * qty, 0), qty),
    ratio: linearRatio,
    elapsedHours: linearRatio * DASH_SHIFT_WINDOW_HOURS,
    rate: null,
    plannedHours: null,
    active: true,
  };
}

/** Linear 0..1 progress through the full shift window at 'HH:mm'. */
function elapsedShiftRatio(slstTimeHHmm) {
  const span = DASH_SHIFT_END_MINUTES - DASH_SHIFT_START_MINUTES;
  if (span <= 0) return 0;
  const minutes = shiftMinutes(slstTimeHHmm);
  return Math.min(Math.max((minutes - DASH_SHIFT_START_MINUTES) / span, 0), 1);
}

/** SLST timestamp 'YYYY-MM-DD HH:mm:ss' -> minutes since midnight. */
function minutesOfDay(slstTimestamp) {
  const time = String(slstTimestamp || '').slice(11, 16);
  return shiftMinutes(time);
}

/** Safe count: numeric `count` column, anything else counts as 0. */
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A scan row is valid accepted production output when its qc_status is NOT
 * one of the excluded defect/rework categories (null/unclassified counts as
 * valid, mirroring the report layer's 'Standard' semantics).
 */
export function isValidProductionRow(row) {
  const qc = row?.qc_status == null ? '' : String(row.qc_status).trim();
  if (qc === '') return true;
  return !DASH_INVALID_QC_STATUSES.includes(qc);
}

/**
 * Build the Monday-first week (7 'YYYY-MM-DD' strings) containing `date`.
 * @param {string} date 'YYYY-MM-DD' SLST calendar date
 * @returns {string[]} [monday, ..., sunday]
 */
export function buildWeekDates(date) {
  const ymd = String(date || '').slice(0, 10);
  const [y, m, d] = ymd.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`Invalid date for week calculation: ${date}`);
  }
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const mondayOffset = jsDay === 0 ? -6 : 1 - jsDay;
  const mondayMs = Date.UTC(y, m - 1, d + mondayOffset);
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    days.push(new Date(mondayMs + i * 86400000).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Build a `dash` metrics fetcher around any supabase-like client.
 * Returns the single plan/efficiency/manpower row for one department on one
 * SLST date (null when the department has no plan row for that day).
 *
 * @param {object} supabaseClient supabase-js-like client (injectable for tests)
 */
export function createDashMetricsFetcher(supabaseClient) {
  return async function fetchDashMetrics({ departmentId, date }) {
    let query = supabaseClient
      .from(DASH_TABLE)
      .select(DASH_COLUMNS)
      .eq('date', date)
      .limit(1);
    if (departmentId) query = query.eq('department', departmentId);
    const { data, error } = await query;
    if (error) throw error;
    return (data && data[0]) || null;
  };
}

/**
 * Build a weekly-plan fetcher: SUM(planed_qty) for one department across the
 * [startDate, endDateExclusive) SLST date range.
 */
export function createDashWeekPlanFetcher(supabaseClient) {
  return async function fetchDashWeekPlan({ departmentId, startDate, endDateExclusive }) {
    let query = supabaseClient
      .from(DASH_TABLE)
      .select('planed_qty')
      .gte('date', startDate)
      .lt('date', endDateExclusive);
    if (departmentId) query = query.eq('department', departmentId);
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).reduce(
      (sum, row) => sum + (Number.isFinite(Number(row?.planed_qty)) ? Number(row.planed_qty) : 0),
      0
    );
  };
}

/**
 * Build a TOLERANT fetcher for the department's planned working hours
 * (`dash.planed_hour`, e.g. 9.5). Resolves the numeric hours, or null on
 * ANY failure - most importantly when the live `dash` table has not
 * received the planed_hour migration yet (PostgREST rejects the unknown
 * column) - so the time-based GPS target degrades to the shift-window
 * fallback instead of breaking the whole dashboard.
 *
 * @param {object} supabaseClient supabase-js-like client (injectable for tests)
 */
export function createDashPlannedHoursFetcher(supabaseClient) {
  return async function fetchDashPlannedHours({ departmentId, date }) {
    try {
      let query = supabaseClient
        .from(DASH_TABLE)
        .select(DASH_PLANED_HOUR_COLUMN)
        .eq('date', date)
        .limit(1);
      if (departmentId) query = query.eq('department', departmentId);
      const { data, error } = await query;
      if (error) throw error;
      const hours = Number(data?.[0]?.[DASH_PLANED_HOUR_COLUMN]);
      return Number.isFinite(hours) && hours > 0 ? hours : null;
    } catch {
      // Missing column / RLS / offline - the GPS marker falls back to the
      // shift-window spread; the rest of the dashboard keeps working.
      return null;
    }
  };
}

/**
 * Build a fetcher listing the departments that have a `dash` plan row on a
 * given SLST date - the auto-rotation cycle for the factory TVs.
 */
export function createDashDepartmentsFetcher(supabaseClient) {
  return async function fetchDashDepartments({ date }) {
    const { data, error } = await supabaseClient
      .from(DASH_TABLE)
      .select('department')
      .eq('date', date)
      .order('department', { ascending: true });
    if (error) throw error;
    return (data || []).map((row) => row?.department).filter(Boolean);
  };
}

/**
 * Build a data_updates scan-row fetcher for one department inside a UTC
 * [start, end) window (pre-computed with slstDayUtcBounds by the caller so
 * the daily and weekly windows share identical SLST boundary math).
 * Only the columns needed for output aggregation are selected.
 */
export function createScanRowsFetcher(supabaseClient) {
  return async function fetchScanRows({ departmentId, start, end }) {
    let query = supabaseClient
      .from(DATA_UPDATES_TABLE)
      .select(DASH_SCAN_COLUMNS)
      .gte('created_at', start)
      .lt('created_at', end)
      .order('created_at', { ascending: true });
    if (departmentId) query = query.eq(DAILY_OUTPUT_DEPARTMENT_COLUMN, departmentId);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  };
}

/**
 * Pure: bucket valid production scans into the 10 SLST shift hours.
 *
 * Each row's `created_at` (UTC) is converted to SLST wall-clock time and the
 * row's `count` added to the shift containing it. Rows with an excluded
 * qc_status (B Grade, C Grade, Lab Testing, Return, Reworked) are ignored, so
 * only accepted output lands in the buckets.
 *
 * @param {object[]} scanRows data_updates rows (created_at,count,qc_status)
 * @returns {Array<{ label: string, range: string, qty: number }>} 10 entries
 */
export function aggregateHourlyOutput(scanRows) {
  const buckets = DASH_SHIFTS.map((shift) => ({
    label: shift.label,
    range: shift.range,
    qty: 0,
  }));

  for (const row of scanRows || []) {
    if (!isValidProductionRow(row)) continue;
    const minutes = minutesOfDay(formatSlstTimestamp(row?.created_at));
    for (let i = 0; i < DASH_SHIFTS.length; i += 1) {
      const shift = DASH_SHIFTS[i];
      const startMin = shiftMinutes(shift.start);
      const endMin = shiftMinutes(shift.end);
      if (minutes >= startMin && minutes < endMin) {
        buckets[i].qty += toCount(row?.count);
        break;
      }
    }
  }

  return buckets;
}

/**
 * Pure: bucket valid production scans into the Mon-Sun week.
 *
 * @param {object[]} scanRows  data_updates rows spanning the whole week
 * @param {string[]} weekDates Monday-first 'YYYY-MM-DD' list (buildWeekDates)
 * @returns {Array<{ day: string, date: string, qty: number }>} 7 entries
 */
export function aggregateWeeklyOutput(scanRows, weekDates) {
  const byDate = new Map();
  weekDates.forEach((date, index) => {
    byDate.set(date, {
      day: WEEK_DAY_LABELS[index],
      date,
      qty: 0,
    });
  });

  for (const row of scanRows || []) {
    if (!isValidProductionRow(row)) continue;
    const date = formatSlstTimestamp(row?.created_at).slice(0, 10);
    const bucket = byDate.get(date);
    if (bucket) bucket.qty += toCount(row?.count);
  }

  return weekDates.map((date) => byDate.get(date));
}

/** Auto-rotation cadence for the unfiltered factory-TV view (15 seconds). */
export const ROTATION_INTERVAL_MS = 15000;

/** localStorage key for the user's auto-rotation department selection. */
export const ROTATION_DEPTS_STORAGE_KEY = 'tracksync.dashboard.rotationDepartments';

/** Read the persisted selected-department list (empty array = all). */
export function loadRotationDepartments(storage = typeof window === 'undefined' ? null : window.localStorage) {
  try {
    const raw = storage?.getItem(ROTATION_DEPTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((d) => typeof d === 'string' && d.trim() !== '')
      : [];
  } catch {
    return [];
  }
}

/** Persist the selected-department list (empty array clears the preference). */
export function saveRotationDepartments(list, storage = typeof window === 'undefined' ? null : window.localStorage) {
  try {
    const clean = Array.isArray(list)
      ? list.filter((d) => typeof d === 'string' && d.trim() !== '')
      : [];
    if (clean.length === 0) storage?.removeItem(ROTATION_DEPTS_STORAGE_KEY);
    else storage?.setItem(ROTATION_DEPTS_STORAGE_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

/**
 * Filter the available departments down to the user's selection.
 * Empty / missing selection falls back to all departments.
 */
export function filterRotationDepartments(available, selected) {
  if (!Array.isArray(selected) || selected.length === 0) return available || [];
  const chosen = new Set(selected);
  const filtered = (available || []).filter((d) => chosen.has(d));
  // Graceful fallback: if none of the selected departments are available
  // today (no plan rows), rotate through everything available.
  return filtered.length > 0 ? filtered : available || [];
}

/** Singleton fetchers bound to the app's shared Supabase singleton. */
const fetchDashMetrics = createDashMetricsFetcher(supabase);
const fetchDashWeekPlan = createDashWeekPlanFetcher(supabase);
const fetchDashPlannedHours = createDashPlannedHoursFetcher(supabase);
const fetchDashDepartments = createDashDepartmentsFetcher(supabase);
const fetchScanRows = createScanRowsFetcher(supabase);

/**
 * List the departments that have a `dash` plan row for the SLST date - the
 * auto-rotation cycle for factory TVs.
 */
export function fetchDashboardDepartments({ date } = {}) {
  return fetchDashDepartments({ date: date || formatSlstDate(new Date()) });
}

/**
 * Fetch everything the Live Dashboard needs for one department on one SLST
 * date: dash metrics (plan/efficiency/manpower), the day's valid output
 * bucketed into the 10 shift hours, and the Mon-Sun week output + weekly plan.
 *
 * @param {object} params
 * @param {string} params.departmentId department name
 * @param {string} params.date        'YYYY-MM-DD' SLST date
 * @returns {Promise<object>} dashboard view-model (see components/dashboard)
 */
export async function fetchLiveDashboard({ departmentId, date }) {
  if (!date) throw new Error('A SLST date is required for the Live Dashboard.');
  if (!departmentId) throw new Error('A department is required for the Live Dashboard.');

  const weekDates = buildWeekDates(date);
  const dayBounds = slstDayUtcBounds(date);
  // Week window: Monday 00:00 SLST .. exclusive end of Sunday (SLST).
  const weekBounds = slstDayUtcBounds(weekDates[0]);
  const weekEndDate = slstDayUtcBounds(weekDates[6]).end;

  const [metrics, weekPlanQty, dayRows, weekRows, plannedHours] = await Promise.all([
    fetchDashMetrics({ departmentId, date }),
    fetchDashWeekPlan({
      departmentId,
      startDate: weekDates[0],
      // Exclusive upper bound = the Monday after Sunday.
      endDateExclusive: new Date(
        new Date(`${weekDates[6]}T00:00:00Z`).getTime() + 86400000
      )
        .toISOString()
        .slice(0, 10),
    }),
    fetchScanRows({ departmentId, start: dayBounds.start, end: dayBounds.end }),
    fetchScanRows({ departmentId, start: weekBounds.start, end: weekEndDate }),
    // Tolerant read of dash.planed_hour (null when the column/migration is
    // missing) - drives the time-based GPS target marker on the race track.
    fetchDashPlannedHours({ departmentId, date }),
  ]);

  const hourly = aggregateHourlyOutput(dayRows);
  const weekly = aggregateWeeklyOutput(weekRows, weekDates);
  const plannedQty = Number.isFinite(Number(metrics?.planed_qty))
    ? Number(metrics.planed_qty)
    : 0;
  const actualQty = hourly.reduce((sum, h) => sum + h.qty, 0);

  return {
    departmentId,
    date,
    weekDates,
    metrics: {
      plannedQty,
      efficiency: metrics?.eficiancy ?? null,
      manPower: Number.isFinite(Number(metrics?.available_man_power))
        ? Number(metrics.available_man_power)
        : null,
    },
    actualQty,
    // Day's planned working hours (dash.planed_hour, e.g. 9.5) - null when
    // unavailable; feeds the time-based GPS target marker (see computeGpsTarget).
    plannedHours,
    // Horse position ratio (0..1, capped) towards the finish line.
    progress: plannedQty > 0 ? Math.min(actualQty / plannedQty, 1) : 0,
    hourly,
    weekly,
    weekPlanQty,
    // Weekly achievement = actual week output vs sum of daily plans.
    weekAchievement:
      weekPlanQty > 0
        ? Math.min(
            weekly.reduce((sum, w) => sum + w.qty, 0) / weekPlanQty,
            1
          )
        : 0,
  };
}
