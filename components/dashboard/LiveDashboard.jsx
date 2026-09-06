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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  DASH_SHIFTS,
  shiftMinutes,
} from '@/lib/dashboardService';
import { formatSlstDate, formatSlstTimestamp } from '@/lib/reportsService';

/** Live-data refresh cadence while the dashboard is visible (30 seconds). */
const LIVE_REFRESH_MS = 30000;

/** Number -> compact display; keeps nulls as an em-dash placeholder. */
function fmt(value, suffix = '') {
  if (value === null || value === undefined || value === '') return '-';
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `${n.toLocaleString()}${suffix}`;
}

/**
 * FlipScoreboardDigit - one mechanical split-flap digit slot.
 * When `value` changes the digit flips like a classic scoreboard flap.
 */
function FlipDigit({ value }) {
  const [display, setDisplay] = useState(value);
  const [flipping, setFlipping] = useState(false);

  useEffect(() => {
    if (value === display) return undefined;
    setFlipping(true);
    const t = setTimeout(() => {
      setDisplay(value);
      setFlipping(false);
    }, 260);
    return () => clearTimeout(t);
  }, [value, display]);

  return (
    <span
      className={`sb-flip-digit ${flipping ? 'sb-flip-digit--flip' : ''}`}
      aria-label={String(display)}
    >
      <span className="sb-flip-digit__half sb-flip-digit__half--top">{display}</span>
      <span className="sb-flip-digit__half sb-flip-digit__half--bottom">{display}</span>
      <span className="sb-flip-digit__next">{value}</span>
      <span className="sb-flip-digit__hinge" />
    </span>
  );
}

/** Render a number as a row of flip digits (fixed width, zero padded). */
function FlipNumber({ value, digits = 4 }) {
  const n = Number(value);
  const safe = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  const chars = String(Math.min(safe, 10 ** digits - 1)).padStart(digits, '0');
  return (
    <span className="sb-flip-row">
      {chars.split('').map((c, i) => (
        <FlipDigit key={`${i}-${c}`} value={c} />
      ))}
    </span>
  );
}

/** Which of the 10 SLST shift hours is active right now (null pre/post shift). */
function currentShiftIndex(slstTimeHHmm) {
  const minutes = shiftMinutes(slstTimeHHmm);
  for (let i = 0; i < DASH_SHIFTS.length; i += 1) {
    if (
      minutes >= shiftMinutes(DASH_SHIFTS[i].start) &&
      minutes < shiftMinutes(DASH_SHIFTS[i].end)
    ) {
      return i;
    }
  }
  return null;
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
  const [showAllShifts, setShowAllShifts] = useState(false);
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

  // Current SLST clock time (updates every 30s alongside live refresh).
  const [slstNow, setSlstNow] = useState(() => formatSlstTimestamp(new Date()).slice(11, 16));
  useEffect(() => {
    const t = setInterval(
      () => setSlstNow(formatSlstTimestamp(new Date()).slice(11, 16)),
      30000
    );
    return () => clearInterval(t);
  }, []);

  // Active shift + its live output for the main scoreboard counter.
  const activeShiftIdx = useMemo(() => currentShiftIndex(slstNow), [slstNow]);
  const activeShift =
    activeShiftIdx !== null && data ? data.hourly[activeShiftIdx] : null;

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
          {/* Retro cricket scoreboard header */}
          <section className="mt-4 overflow-hidden rounded-2xl shadow-lg ring-1 ring-slate-800">
            <div className="dashboard-scoreboard relative p-5">
              {/* Marquee strip */}
              <div className="sb-marquee mb-4 flex items-center justify-between">
                <span className="text-[11px] font-black uppercase tracking-[0.3em] text-amber-400">
                  🏏 Concord TrackSync · Live Score
                </span>
                <span className="text-[11px] font-bold uppercase tracking-widest text-emerald-300">
                  {data.departmentId} · {date}
                </span>
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                {/* MAIN SCORE: current shift with flip digits */}
                <div className="sb-panel lg:col-span-2">
                  <p className="sb-label">Current Shift Output</p>
                  {activeShift ? (
                    <>
                      <div className="flex items-end gap-4">
                        <span className="sb-shift-name">
                          {activeShift.label}
                          <span className="sb-shift-range">{activeShift.range}</span>
                        </span>
                        <FlipNumber value={activeShift.qty} digits={3} />
                      </div>
                      <p className="mt-2 text-[11px] font-bold uppercase tracking-widest text-emerald-300">
                        ● Live · units this hour (valid scans only)
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="flex items-end gap-4">
                        <span className="sb-shift-name">
                          Stumps
                          <span className="sb-shift-range">Shift over / not started</span>
                        </span>
                        <FlipNumber value={data.actualQty} digits={3} />
                      </div>
                      <p className="mt-2 text-[11px] font-bold uppercase tracking-widest text-slate-400">
                        Day total · next shift 7.45 AM
                      </p>
                    </>
                  )}
                </div>

                {/* TARGET + achievement */}
                <div className="sb-panel">
                  <p className="sb-label">Target (planed_qty)</p>
                  <div className="flex items-end gap-3">
                    <FlipNumber value={data.metrics.plannedQty} digits={4} />
                  </div>
                  <div className="mt-3">
                    <div className="sb-progress-track">
                      <div
                        className="sb-progress-fill"
                        style={{ width: `${Math.round(data.progress * 100)}%` }}
                      />
                    </div>
                    <p className="mt-2 flex items-center justify-between text-[11px] font-bold uppercase tracking-widest">
                      <span className="text-amber-300">{fmt(data.actualQty)} scored</span>
                      <span
                        className={
                          data.progress >= 1 ? 'text-emerald-300' : 'text-sky-300'
                        }
                      >
                        {data.progress >= 1
                          ? '🎯 Target achieved!'
                          : `${Math.round(data.progress * 100)}% chasing`}
                      </span>
                    </p>
                  </div>
                </div>
              </div>

              {/* Bottom strip: total + toggle */}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <span className="sb-total-pill">
                  Day total: <FlipNumber value={data.actualQty} digits={4} />
                </span>
                <span className="sb-total-pill">
                  Efficiency: {fmt(data.metrics.efficiency)} · Man power:{' '}
                  {fmt(data.metrics.manPower)}
                </span>
                <button
                  type="button"
                  onClick={() => setShowAllShifts((v) => !v)}
                  className="sb-toggle ml-auto"
                  aria-expanded={showAllShifts}
                >
                  {showAllShifts ? '▲ Hide All Shifts' : '▼ View All Shifts'}
                </button>
              </div>

              {/* Expandable full 10-shift breakdown */}
              {showAllShifts ? (
                <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                  {data.hourly.map((h, i) => (
                    <div
                      key={h.label}
                      className={`sb-shift-cell ${i === activeShiftIdx ? 'sb-shift-cell--live' : ''}`}
                    >
                      <p className="text-[10px] font-bold uppercase tracking-widest text-amber-400">
                        {h.label}
                      </p>
                      <p className="text-[10px] text-slate-400">{h.range}</p>
                      <p className="sb-shift-qty">
                        {i === activeShiftIdx ? '● ' : ''}
                        {h.qty}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}
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
