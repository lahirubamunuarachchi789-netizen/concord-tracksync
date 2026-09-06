'use client';

// Concord TrackSync - LiveDashboard - factory-floor live production view.
//
//   - Department + Date filters; when neither is explicitly chosen the view
//     auto-rotates through the departments planned in `dash` for today (SLST)
//     every ROTATION_INTERVAL_MS (15s).
//   - Horse-race header: the horse advances towards the finish-line flag in
//     proportion to actual valid output vs the day's planned_qty, with the
//     achieved QTY riding on top of the horse.
//   - Three dash-table metric cards (Planned QTY / Efficiency / Man Power),
//     the 10-hour SLST shift breakdown, a Mon-Sun weekly output chart and a
//     full-screen TV mode with continuous live refresh.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircleIcon,
  BoltIcon,
  CompressIcon,
  ExpandIcon,
  LayersIcon,
  SpinnerIcon,
  TrendingUpIcon,
} from '@/components/icons';
import {
  fetchDashboardDepartments,
  fetchLiveDashboard,
  ROTATION_INTERVAL_MS,
} from '@/lib/dashboardService';
import { formatSlstDate } from '@/lib/reportsService';

/** Live-data refresh cadence while the dashboard is visible (30 seconds). */
const LIVE_REFRESH_MS = 30000;

/** Number -> compact display; keeps nulls as an em-dash placeholder. */
function fmt(value, suffix = '') {
  if (value === null || value === undefined || value === '') return '-';
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `${n.toLocaleString()}${suffix}`;
}

export default function LiveDashboard() {
  const [departments, setDepartments] = useState([]);
  const [departmentId, setDepartmentId] = useState('');
  const [date, setDate] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [isTv, setIsTv] = useState(false);
  const [rotationIndex, setRotationIndex] = useState(0);
  const dateTouched = useRef(false);

  // Default date = today (SLST); auto-rotation only runs in this unfiltered state.
  useEffect(() => {
    if (!dateTouched.current && !date) setDate(formatSlstDate(new Date()));
  }, [date]);

  const isAutoRotation = !departmentId && !dateTouched.current;

  // Rotation cycle: departments planned in `dash` for the viewed SLST date.
  useEffect(() => {
    fetchDashboardDepartments({ date })
      .then((list) => setDepartments(Array.isArray(list) ? list : []))
      .catch(() => setDepartments([]));
  }, [date]);

  const loadDashboard = useCallback(
    async (dept) => {
      if (!dept || !date) return;
      setLoading(true);
      setError(null);
      try {
        const result = await fetchLiveDashboard({ departmentId: dept, date });
        setData(result);
        setLastUpdated(new Date());
      } catch (err) {
        setError(err?.message || 'Failed to load the live dashboard.');
      } finally {
        setLoading(false);
      }
    },
    [date]
  );

  // Resolve which department is on display: explicit filter or the rotation slot.
  const activeDepartment =
    departmentId ||
    (departments.length > 0
      ? departments[rotationIndex % departments.length]
      : '');

  // (Re)load whenever the active department or date changes.
  useEffect(() => {
    if (activeDepartment) loadDashboard(activeDepartment);
  }, [activeDepartment, loadDashboard]);

  // Auto-rotation: advance the slot every 15s only in the unfiltered state.
  useEffect(() => {
    if (!isAutoRotation || departments.length < 2) return undefined;
    const timer = setInterval(
      () => setRotationIndex((i) => i + 1),
      ROTATION_INTERVAL_MS
    );
    return () => clearInterval(timer);
  }, [isAutoRotation, departments.length]);

  // Live refresh while visible (factory TVs stay on all day).
  useEffect(() => {
    if (!activeDepartment) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadDashboard(activeDepartment);
      }
    }, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [activeDepartment, loadDashboard]);

  // Full-screen TV mode: request browser fullscreen + toggle body.tv-mode
  // (the CSS layer hides the sidebar/header chrome for factory TVs).
  const toggleFullScreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        document.body.classList.add('tv-mode');
        setIsTv(true);
      } else {
        await document.exitFullscreen();
        document.body.classList.remove('tv-mode');
        setIsTv(false);
      }
    } catch {
      // Fullscreen can be blocked (permissions/iframe); still apply TV chrome.
      const next = !isTv;
      document.body.classList.toggle('tv-mode', next);
      setIsTv(next);
    }
  }, [isTv]);

  // Keep body.tv-mode in sync if the user leaves fullscreen via Escape.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) {
        document.body.classList.remove('tv-mode');
        setIsTv(false);
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const handleDepartmentChange = (e) => {
    setDepartmentId(e.target.value);
    setRotationIndex(0);
  };

  const handleDateChange = (e) => {
    dateTouched.current = true;
    setDate(e.target.value || formatSlstDate(new Date()));
    setRotationIndex(0);
  };

  return (
    <div className="mx-auto max-w-7xl animate-fade-slide">
      {/* Toolbar: filters + fullscreen toggle */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-slate-900">Live Dashboard</h1>
          <p className="text-xs text-slate-400">
            {isAutoRotation
              ? 'Auto-rotating every 15s - select a department & date to pin'
              : `Live production - ${departmentId || 'all departments'}`}
          </p>
        </div>
        <div className="ml-auto flex-wrap items-center gap-2">
          <select
            aria-label="Department filter"
            value={departmentId}
            onChange={handleDepartmentChange}
            className="rounded-xl border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm"
          >
            <option value="">All departments (auto-rotate)</option>
            {departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <input
            type="date"
            aria-label="Date filter"
            value={date}
            onChange={handleDateChange}
            className="rounded-xl border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm"
          />
          <button
            type="button"
            onClick={toggleFullScreen}
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500"
          >
            {isTv ? <CompressIcon /> : <ExpandIcon />}
            {isTv ? 'Exit Full Screen' : 'Full Screen'}
          </button>
        </div>
      </div>

      {error ? (
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-red-50 p-4 text-sm font-medium text-red-600 ring-1 ring-red-100">
          <AlertCircleIcon /> {error}
        </div>
      ) : null}

      {!data ? (
        <div className="mt-10 flex items-center justify-center gap-2 text-sm text-slate-400">
          <SpinnerIcon /> {loading ? 'Loading live data...' : 'No plan rows for this date.'}
        </div>
      ) : (
        <>
          {/* Horse race header */}
          <section className="mt-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-bold text-slate-900">{data.departmentId}</span>
              <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-600 ring-1 ring-indigo-100">
                Target: {fmt(data.metrics.plannedQty)} units
              </span>
            </div>
            <div className="relative h-28 overflow-hidden rounded-xl bg-gradient-to-b from-emerald-50 to-white ring-1 ring-slate-100">
              {/* Finish line flag + target */}
              <div className="absolute right-3 top-2 flex-col items-center">
                <span className="text-[11px] font-bold text-slate-500">Finish</span>
                <div className="dashboard-flag text-2xl">🏁</div>
              </div>
              {/* Track */}
              <div className="dashboard-track absolute bottom-6 left-0 h-1.5 w-full" />
              {/* Horse: position = progress ratio */}
              <div
                className="absolute bottom-3 flex-col items-center transition-all duration-1000 ease-out"
                style={{ left: `calc(${(data.progress * 100).toFixed(1)}% - 24px)` }}
              >
                <span className="mb-0.5 rounded-full bg-slate-900 px-2 py-0.5 text-[11px] font-bold text-white">
                  {fmt(data.actualQty)}
                </span>
                <span className="dashboard-horse text-3xl">🐎</span>
              </div>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-indigo-600 transition-all duration-1000"
                style={{ width: `${Math.round(data.progress * 100)}%` }}
              />
            </div>
          </section>

          {/* Metric cards */}
          <section className="mt-4 grid gap-4 sm:grid-cols-3">
            {[
              { label: 'Planned QTY', value: fmt(data.metrics.plannedQty), Icon: LayersIcon },
              {
                label: 'Efficiency',
                value: fmt(data.metrics.efficiency),
                Icon: BoltIcon,
              },
              {
                label: 'Available Man Power',
                value: fmt(data.metrics.manPower),
                Icon: TrendingUpIcon,
              },
            ].map(({ label, value, Icon }) => (
              <div
                key={label}
                className="flex items-center gap-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200"
              >
                <span className="rounded-xl bg-indigo-50 p-3 text-indigo-600">
                  <Icon />
                </span>
                <div>
                  <p className="text-xs font-medium text-slate-400">{label}</p>
                  <p className="text-2xl font-extrabold text-slate-900">{value}</p>
                </div>
              </div>
            ))}
          </section>

          {/* Hourly output */}
          <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="text-sm font-bold text-slate-900">Hourly output breakdown</h2>
            <p className="text-xs text-slate-400">
              Valid accepted units per SLST shift hour (B/C-Grade, Return, Reworked, Lab Testing excluded)
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="border-y border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-3 font-semibold">Hour</th>
                    <th className="px-4 py-3 font-semibold">Time range</th>
                    <th className="px-4 py-3 text-right font-semibold">Actual QTY</th>
                  </tr>
                </thead>
                <tbody>
                  {data.hourly.map((h) => (
                    <tr key={h.label} className="border-b border-slate-50 last:border-0">
                      <td className="px-4 py-2.5 font-semibold text-slate-700">{h.label}</td>
                      <td className="px-4 py-2.5 text-slate-500">{h.range}</td>
                      <td className="px-4 py-2.5 text-right font-bold text-slate-900">{h.qty}</td>
                    </tr>
                  ))}
                  <tr className="bg-slate-50 text-sm font-bold">
                    <td className="px-4 py-2.5" colSpan={2}>
                      Total actual QTY
                    </td>
                    <td className="px-4 py-2.5 text-right text-indigo-600">{data.actualQty}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* Weekly chart */}
          <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-slate-900">Weekly production output</h2>
                <p className="text-xs text-slate-400">Valid units per day (Mon-Sun)</p>
              </div>
              <div className="flex items-center gap-2 text-xs font-semibold">
                <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">
                  Week plan: {fmt(data.weekPlanQty)}
                </span>
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-600 ring-1 ring-emerald-100">
                  Achievement: {Math.round(data.weekAchievement * 100)}%
                </span>
              </div>
            </div>
            <div className="flex h-44 items-end gap-2 sm:gap-4">
              {data.weekly.map((w) => {
                const max = Math.max(...data.weekly.map((x) => x.qty), 1);
                return (
                  <div
                    key={w.date}
                    className="flex h-full flex-1 flex-col items-center justify-end gap-2"
                  >
                    <span className="text-[10px] font-semibold text-slate-400">{w.qty}</span>
                    <div
                      title={`${w.day}: ${w.qty} units`}
                      style={{ height: `${Math.round((w.qty / max) * 100)}%` }}
                      className="w-full rounded-t-lg bg-gradient-to-t from-indigo-600 via-indigo-500 to-sky-400 transition hover:brightness-110"
                    />
                    <span className="text-[11px] font-medium text-slate-500">{w.day}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <p className="mt-4 pb-4 text-center text-xs text-slate-400">
            Live refresh every 30s
            {lastUpdated ? ` - last updated ${lastUpdated.toLocaleTimeString()}` : ''}
          </p>
        </>
      )}
    </div>
  );
}
