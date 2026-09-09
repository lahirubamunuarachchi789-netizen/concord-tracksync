'use client';

// Concord TrackSync - DepartmentOutputView - Department Output Report tab.
//
// Filter bar (department + SLST date) feeding an 11-hour breakdown of
// forward-only output. Each hour card is clickable to drill down into
// PO Wise / Size Wise QTY for that exact hour slot.

import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDownIcon,
  ClockIcon,
  SpinnerIcon,
  TrendingUpIcon,
} from '@/components/icons';
import {
  DATA_UPDATES_TABLE,
  DAILY_OUTPUT_DEPARTMENT_COLUMN,
} from '@/lib/db';
import { supabase } from '@/lib/db';
import {
  fetchDepartments,
  formatSlstDate,
  slstDayUtcBounds,
} from '@/lib/reportsService';

// Exact 11-hour time ranges for the Department Output report.
const DEPARTMENT_OUTPUT_HOURS = [
  { label: 'Hour 1', start: '07:45', end: '08:45' },
  { label: 'Hour 2', start: '08:45', end: '09:45' },
  { label: 'Hour 3', start: '09:45', end: '10:45' },
  { label: 'Hour 4', start: '10:45', end: '11:45' },
  { label: 'Hour 5', start: '11:45', end: '13:15' },
  { label: 'Hour 6', start: '13:15', end: '14:15' },
  { label: 'Hour 7', start: '14:15', end: '15:15' },
  { label: 'Hour 8', start: '15:15', end: '16:30' },
  { label: 'Hour 9', start: '16:30', end: '17:30' },
  { label: 'Hour 10', start: '17:30', end: '18:45' },
  { label: 'Hour 11', start: '18:45', end: '19:30' },
];

/** Convert 'HH:mm' to minutes since midnight. */
function timeToMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

/**
 * Convert a UTC timestamp to SLST minutes since midnight.
 * SLST = UTC + 5:30 (330 minutes). The result is normalized to 0-1439
 * (minutes within a single SLST day) using modulo 1440.
 *
 * @param {string} utcIso ISO UTC timestamp from data_updates.created_at
 * @returns {number} minutes since SLST midnight (0-1439)
 */
function utcToSlstMinutes(utcIso) {
  const scanTime = new Date(utcIso);
  const utcMinutes = scanTime.getUTCHours() * 60 + scanTime.getUTCMinutes();
  // Add 330 minutes (5h 30m) to convert UTC -> SLST, then wrap to 0-1439
  return (utcMinutes + 330) % 1440;
}

/** Build the UTC ISO bounds for one SLST hour slot on a given SLST date. */
function hourSlotUtcBounds(date, startHHmm, endHHmm) {
  const { start } = slstDayUtcBounds(date);
  const baseMidnight = new Date(start);
  const startMin = timeToMinutes(startHHmm);
  const endMin = timeToMinutes(endHHmm);
  const slotStart = new Date(baseMidnight.getTime() + startMin * 60000);
  const slotEnd = new Date(baseMidnight.getTime() + endMin * 60000);
  return { start: slotStart.toISOString(), end: slotEnd.toISOString() };
}

/** Parse PO and size from a qr_code. */
function parsePoAndSize(qrCode) {
  if (!qrCode) return { po: null, size: null };
  const parts = String(qrCode).split(':');
  if (parts.length >= 2) {
    return { po: parts[0].trim(), size: parts[1].trim() };
  }
  return { po: null, size: null };
}

export default function DepartmentOutputView() {
  const [departments, setDepartments] = useState([]);
  const [departmentId, setDepartmentId] = useState('');
  const [date, setDate] = useState('');
  const [hourlyData, setHourlyData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [drillDown, setDrillDown] = useState(null);
  const [drillDownLoading, setDrillDownLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  useEffect(() => {
    if (!date) setDate(formatSlstDate(new Date()));
  }, [date]);

  useEffect(() => {
    fetchDepartments()
      .then((d) => setDepartments(Array.isArray(d) ? d : []))
      .catch(() => setDepartments([]));
  }, []);

  // Reset hasSearched when department or date changes
  useEffect(() => {
    setHasSearched(false);
  }, [departmentId, date]);

  const runSearch = useCallback(async () => {
    if (!date || !departmentId) return;
    setLoading(true);
    setError(null);
    setHourlyData(null);
    setDrillDown(null);
    setHasSearched(true);

    try {
      // Compute the full SLST day's UTC bounds [start, end)
      const { start, end } = slstDayUtcBounds(date);

      // DEBUG: Log exact query parameters
      console.log('[DepartmentOutput] Query params:', {
        department: departmentId,
        date,
        startUtc: start,
        endUtc: end,
        qcStatus: 'forward',
      });

      // Query data_updates for the selected department + date, forward-only.
      // The department column stores the department NAME (matching departments.department).
      const { data, error: queryError } = await supabase
        .from(DATA_UPDATES_TABLE)
        .select('qr_code, count, created_at')
        .eq(DAILY_OUTPUT_DEPARTMENT_COLUMN, departmentId)
        .eq('qc_status', 'forward')
        .gte('created_at', start)
        .lt('created_at', end)
        .order('created_at', { ascending: true });

      if (queryError) throw queryError;

      // DEBUG: Log raw rows returned
      console.log('[DepartmentOutput] Rows returned:', data?.length || 0);
      console.log('[DepartmentOutput] Raw data:', data);

      // Handle empty results - no data found for this department/date
      if (!data || data.length === 0) {
        console.log('[DepartmentOutput] No rows found for query');
        setHourlyData(DEPARTMENT_OUTPUT_HOURS.map((slot) => ({
          ...slot,
          totalOutput: 0,
          scanCount: 0,
        })));
        return;
      }

      const slots = DEPARTMENT_OUTPUT_HOURS.map((slot) => ({
        ...slot,
        totalOutput: 0,
        scanCount: 0,
      }));

      for (const row of data) {
        const createdAt = row?.created_at;
        if (!createdAt) continue;

        // Convert UTC timestamp to SLST minutes since midnight for bucketing
        const slstMinutes = utcToSlstMinutes(createdAt);

        // DEBUG: Log each row's bucketing details
        const scanTime = new Date(createdAt);
        console.log('[DepartmentOutput] Row:', {
          createdAt,
          utcHours: scanTime.getUTCHours(),
          utcMinutes: scanTime.getUTCMinutes(),
          slstMinutes,
          count: row?.count,
          qrCode: row?.qr_code,
        });

        let assigned = false;
        for (let i = 0; i < slots.length; i += 1) {
          const slotStart = timeToMinutes(slots[i].start);
          const slotEnd = timeToMinutes(slots[i].end);
          if (slstMinutes >= slotStart && slstMinutes < slotEnd) {
            slots[i].totalOutput += Number(row?.count) || 0;
            slots[i].scanCount += 1;
            console.log(`[DepartmentOutput] -> Assigned to ${slots[i].label} (${slots[i].start}-${slots[i].end}), slotStart=${slotStart}, slotEnd=${slotEnd}`);
            assigned = true;
            break;
          }
        }
        if (!assigned) {
          console.log('[DepartmentOutput] -> NOT assigned to any slot (outside all hour ranges)');
        }
      }

      // DEBUG: Log final aggregated totals
      console.log('[DepartmentOutput] Final aggregated totals:');
      slots.forEach((slot) => {
        console.log(`  ${slot.label} (${slot.start}-${slot.end}): totalOutput=${slot.totalOutput}, scanCount=${slot.scanCount}`);
      });

      setHourlyData(slots);
    } catch (err) {
      setError(err?.message || 'Failed to fetch department output data.');
    } finally {
      setLoading(false);
    }
  }, [date, departmentId]);

  const handleHourClick = useCallback(
    async (hourIndex) => {
      if (!hourlyData || !date) return;
      const slot = hourlyData[hourIndex];
      if (!slot || slot.totalOutput === 0) return;

      setDrillDownLoading(true);
      setDrillDown({ hourIndex, hourLabel: slot.label, poSizeData: null });

      try {
        const { start, end } = hourSlotUtcBounds(date, slot.start, slot.end);

        const { data, error: queryError } = await supabase
          .from(DATA_UPDATES_TABLE)
          .select('qr_code, count')
          .eq(DAILY_OUTPUT_DEPARTMENT_COLUMN, departmentId)
          .eq('qc_status', 'forward')
          .gte('created_at', start)
          .lt('created_at', end);

        if (queryError) throw queryError;

        const poSizeMap = new Map();

        for (const row of data || []) {
          const { po, size } = parsePoAndSize(row?.qr_code);
          if (!po || !size) continue;

          const key = `${po}|${size}`;
          const existing = poSizeMap.get(key);
          if (existing) {
            existing.qty += Number(row?.count) || 0;
          } else {
            poSizeMap.set(key, { po, size, qty: Number(row?.count) || 0 });
          }
        }

        const poSizeData = Array.from(poSizeMap.values()).sort((a, b) => {
          if (a.po !== b.po) return a.po.localeCompare(b.po);
          return a.size.localeCompare(b.size);
        });

        setDrillDown({ hourIndex, hourLabel: slot.label, poSizeData });
      } catch (err) {
        setError(err?.message || 'Failed to fetch drill-down data.');
        setDrillDown(null);
      } finally {
        setDrillDownLoading(false);
      }
    },
    [hourlyData, date, departmentId]
  );

  const closeDrillDown = useCallback(() => {
    setDrillDown(null);
  }, []);

  const totalOutput = hourlyData
    ? hourlyData.reduce((sum, slot) => sum + slot.totalOutput, 0)
    : 0;

  return (
    <div className="space-y-6">
      {/* Filter Bar */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[180px] flex-1">
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Department
            </label>
            <div className="relative">
              <select
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
                className="w-full appearance-none rounded-lg border border-slate-300 bg-white py-2.5 pl-3 pr-10 text-sm text-slate-900 shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              >
                <option value="">Select department</option>
                {departments.map((dept) => (
                  <option key={dept.id} value={dept.department}>
                    {dept.department}
                  </option>
                ))}
              </select>
              <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            </div>
          </div>

          <div className="min-w-[160px]">
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Date (SLST)
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </div>

          <button
            type="button"
            onClick={runSearch}
            disabled={loading || !departmentId || !date}
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <>
                <SpinnerIcon className="h-4 w-4 animate-spin" />
                Loading...
              </>
            ) : (
              'Search'
            )}
          </button>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Hourly Breakdown */}
      {hourlyData && (
        <>
          <div className="rounded-xl border border-slate-200 bg-gradient-to-r from-indigo-50 to-purple-50 p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Total Output</h3>
                <p className="text-sm text-slate-500">
                  {departmentId} · {date}
                </p>
              </div>
              <div className="flex items-center gap-2 rounded-full bg-white px-4 py-2 shadow-sm">
                <TrendingUpIcon className="h-5 w-5 text-indigo-600" />
                <span className="text-2xl font-extrabold text-slate-900">
                  {totalOutput.toLocaleString()}
                </span>
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {hourlyData.map((slot, index) => (
              <button
                key={slot.label}
                type="button"
                onClick={() => handleHourClick(index)}
                disabled={slot.totalOutput === 0}
                className="group relative flex flex-col rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-all hover:border-indigo-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-700">
                    {slot.label}
                  </span>
                  <ClockIcon className="h-4 w-4 text-slate-400 group-hover:text-indigo-500" />
                </div>
                <p className="text-xs text-slate-400">
                  {slot.start} - {slot.end}
                </p>
                <div className="mt-3 flex items-baseline gap-1">
                  <span className="text-2xl font-extrabold text-slate-900">
                    {slot.totalOutput.toLocaleString()}
                  </span>
                  <span className="text-xs text-slate-400">units</span>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  {slot.scanCount} scan{slot.scanCount !== 1 ? 's' : ''}
                </p>
                {slot.totalOutput > 0 && (
                  <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-bold text-indigo-600 opacity-0 transition-opacity group-hover:opacity-100">
                    →
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Empty State / No Data Found */}
      {!hourlyData && !loading && !error && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 py-16 text-center">
          <ClockIcon className="mb-4 h-12 w-12 text-slate-300" />
          <h3 className="text-lg font-semibold text-slate-700">
            {hasSearched ? 'No Data Found' : 'Department Output Report'}
          </h3>
          <p className="mt-1 max-w-sm text-sm text-slate-500">
            {hasSearched
              ? `No forward scans found for ${departmentId} on ${date}. Try a different department or date.`
              : 'Select a department and date, then click Search to view the hourly output breakdown.'}
          </p>
        </div>
      )}

      {/* Drill-down Modal */}
      {drillDown && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div>
                <h3 className="text-lg font-bold text-slate-900">
                  {drillDown.hourLabel} Breakdown
                </h3>
                <p className="text-sm text-slate-500">
                  PO Wise · Size Wise QTY · {departmentId} · {date}
                </p>
              </div>
              <button
                type="button"
                onClick={closeDrillDown}
                className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                aria-label="Close"
              >
                <span className="text-xl leading-none">&times;</span>
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto p-6">
              {drillDownLoading ? (
                <div className="flex items-center justify-center py-12">
                  <SpinnerIcon className="h-8 w-8 animate-spin text-indigo-500" />
                  <span className="ml-3 text-sm text-slate-500">
                    Loading breakdown...
                  </span>
                </div>
              ) : drillDown.poSizeData && drillDown.poSizeData.length > 0 ? (
                <div className="overflow-hidden rounded-lg border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-600">
                          PO Number
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-600">
                          Size
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-semibold uppercase text-slate-600">
                          QTY
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {drillDown.poSizeData.map((item) => (
                        <tr
                          key={`${item.po}-${item.size}`}
                          className="hover:bg-slate-50"
                        >
                          <td className="px-4 py-2.5 text-sm font-medium text-slate-900">
                            {item.po}
                          </td>
                          <td className="px-4 py-2.5 text-sm text-slate-600">
                            {item.size}
                          </td>
                          <td className="px-4 py-2.5 text-right text-sm font-bold text-indigo-600">
                            {item.qty.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-slate-50">
                      <tr>
                        <td
                          colSpan={2}
                          className="px-4 py-2.5 text-sm font-semibold text-slate-700"
                        >
                          Total
                        </td>
                        <td className="px-4 py-2.5 text-right text-sm font-bold text-indigo-600">
                          {drillDown.poSizeData
                            .reduce((sum, item) => sum + item.qty, 0)
                            .toLocaleString()}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <p className="py-8 text-center text-sm text-slate-500">
                  No data available for this hour slot.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}