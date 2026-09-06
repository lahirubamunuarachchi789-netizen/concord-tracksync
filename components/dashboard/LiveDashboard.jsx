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
  filterRotationDepartments,
  loadRotationDepartments,
  saveRotationDepartments,
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
  const [selectedDepartments, setSelectedDepartments] = useState([]);
  const [showDeptSettings, setShowDeptSettings] = useState(false);
  const dateTouched = useRef(false);

  // Restore the persisted department selection (TV displays remember it).
  useEffect(() => {
    setSelectedDepartments(loadRotationDepartments());
  }, []);

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

  // Resolve which department is on display: explicit filter or the rotation slot
  // over the user's selected subset (falls back to all when nothing selected).
  const rotationDepartments = useMemo(
    () => filterRotationDepartments(departments, selectedDepartments),
    [departments, selectedDepartments]
  );

  const activeDepartment =
    departmentId ||
    (rotationDepartments.length > 0
      ? rotationDepartments[rotationIndex % rotationDepartments.length]
      : '');

  // (Re)load whenever the active department or date changes.
  useEffect(() => {
    if (activeDepartment) loadDashboard(activeDepartment);
  }, [activeDepartment, loadDashboard]);

  // Auto-rotation: advance the slot every 15s only in the unfiltered state,
  // cycling through the user's selected departments.
  useEffect(() => {
    if (!isAutoRotation || rotationDepartments.length < 2) return undefined;
    const timer = setInterval(
      () => setRotationIndex((i) => i + 1),
      ROTATION_INTERVAL_MS
    );
    return () => clearInterval(timer);
  }, [isAutoRotation, rotationDepartments.length]);

  // Keep the rotation slot valid when the selection shrinks.
  useEffect(() => {
    setRotationIndex(0);
  }, [selectedDepartments]);

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

  const toggleSelectedDepartment = (dept) => {
    setSelectedDepartments((prev) => {
      const next = prev.includes(dept)
        ? prev.filter((d) => d !== dept)
        : [...prev, dept];
      saveRotationDepartments(next);
      return next;
    });
  };

  const handleSelectAllDepartments = () => {
    setSelectedDepartments([]);
    saveRotationDepartments([]);
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
            onClick={() => setShowDeptSettings((v) => !v)}
            className="inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-semibold text-slate-600 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50"
            aria-expanded={showDeptSettings}
          >
            ⚙ Select Departments
            {selectedDepartments.length > 0 ? (
              <span className="rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                {selectedDepartments.length}
              </span>
            ) : null}
          </button>
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

      {/* Department selection dropdown */}
      {showDeptSettings ? (
        <div className="mt-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold text-slate-500">
              Choose which departments join the auto-rotation loop. Leave all unchecked to rotate
              through every department planned for the day.
            </p>
            <button
              type="button"
              onClick={handleSelectAllDepartments}
              className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200"
            >
              Reset to all
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {departments.length === 0 ? (
              <p className="text-xs text-slate-400">No departments planned for this date.</p>
            ) : (
              departments.map((dept) => {
                const checked = selectedDepartments.includes(dept);
                return (
                  <label
                    key={dept}
                    className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition ${
                      checked
                        ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSelectedDepartment(dept)}
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    {dept}
                  </label>
                );
              })
            )}
          </div>
        </div>
      ) : null}

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
          {/* Red sports car race track (kept) */}
          <section className="mt-4 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-bold text-slate-900">{data.departmentId}</span>
              <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-600 ring-1 ring-indigo-100">
                Target: {fmt(data.metrics.plannedQty)} units
              </span>
            </div>
            <div className="dashboard-race relative h-36 overflow-hidden rounded-xl ring-1 ring-slate-200">
              {/* Racing lane surface */}
              <div className="dashboard-lane absolute inset-x-0 bottom-0 h-16" />
              {/* Lane markers (moving dashes) */}
              <div className="dashboard-track absolute bottom-4 left-0 h-1 w-full" />

              {/* Finish line + waving flag on the right */}
              <div className="absolute right-0 top-0 flex h-full w-16 flex-col items-center justify-end pb-6">
                <span className="mb-1 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600 shadow-sm ring-1 ring-slate-200">
                  Finish {fmt(data.metrics.plannedQty)}
                </span>
                <div className="relative h-16 w-8">
                  <div className="absolute bottom-0 left-1/2 h-16 w-1 -translate-x-1/2 rounded bg-slate-300" />
                  <svg
                    className="dashboard-flag absolute left-2 top-0 h-7 w-9 drop-shadow"
                    viewBox="0 0 36 28"
                    aria-hidden="true"
                  >
                    <defs>
                      <linearGradient id="flagGrad" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor="#6366f1" />
                        <stop offset="100%" stopColor="#0ea5e9" />
                      </linearGradient>
                    </defs>
                    <path
                      d="M2 2 L32 5 L26 13 L32 21 L2 24 Z"
                      fill="url(#flagGrad)"
                    />
                  </svg>
                </div>
                {/* Checkered finish strip */}
                <div className="dashboard-finish-line absolute bottom-0 right-0 h-14 w-3" />
              </div>

              {/* Tire-skid dust trailing the car */}
              <div
                className="pointer-events-none absolute bottom-6 transition-all duration-1000 ease-out"
                style={{ left: `${(data.progress * 100).toFixed(1)}%` }}
              >
                {[0, 1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className="dashboard-dust absolute rounded-full"
                    style={{
                      width: `${6 + i * 3}px`,
                      height: `${6 + i * 3}px`,
                      animationDelay: `${i * 0.22}s`,
                    }}
                  />
                ))}
              </div>

              {/* Red sports car: position maps exactly to completion % */}
              <div
                className="absolute bottom-2 flex-col items-center transition-[left] duration-1000 ease-out"
                style={{
                  left: `calc((100% - 96px) * ${data.progress.toFixed(4)})`,
                }}
              >
                {/* Glowing live progress badge above the car */}
                <span className="dashboard-progress-badge mb-1 whitespace-nowrap rounded-full px-3 py-1 text-[11px] font-extrabold text-white shadow-lg">
                  {fmt(data.actualQty)} / {fmt(data.metrics.plannedQty)}
                  <span className="ml-1 font-bold opacity-80">
                    {Math.round(data.progress * 100)}%
                  </span>
                </span>
                {/* Detailed SVG red sports car, wheels spinning continuously */}
                <svg
                  className="dashboard-car h-16 w-28 drop-shadow-lg"
                  viewBox="0 0 140 70"
                  aria-label={`Red sports car at ${Math.round(data.progress * 100)}% of plan`}
                >
                  <defs>
                    <linearGradient id="carBody" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f87171" />
                      <stop offset="55%" stopColor="#dc2626" />
                      <stop offset="100%" stopColor="#991b1b" />
                    </linearGradient>
                    <linearGradient id="carGlass" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#e0f2fe" />
                      <stop offset="100%" stopColor="#7dd3fc" />
                    </linearGradient>
                    <radialGradient id="exhaustGlow">
                      <stop offset="0%" stopColor="rgba(251,146,60,0.95)" />
                      <stop offset="100%" stopColor="rgba(251,146,60,0)" />
                    </radialGradient>
                  </defs>

                  {/* Glowing exhaust flame */}
                  <circle className="dashboard-exhaust" cx="6" cy="46" r="10" fill="url(#exhaustGlow)" />

                  {/* Lower body */}
                  <path
                    d="M12 52 Q10 42 24 40 L38 38 Q52 24 70 24 Q92 24 104 38 L120 40 Q132 42 130 52 Q130 56 124 56 L18 56 Q12 56 12 52 Z"
                    fill="url(#carBody)"
                  />
                  {/* Cabin / windshield */}
                  <path
                    d="M44 38 Q54 27 70 27 Q88 27 98 38 Z"
                    fill="url(#carGlass)"
                  />
                  {/* Roof highlight */}
                  <path d="M46 37 Q56 28 70 28 Q86 28 96 37" fill="none" stroke="#fecaca" strokeWidth="1.5" opacity="0.8" />
                  {/* Side skirt + spoiler */}
                  <rect x="12" y="50" width="120" height="3" rx="1.5" fill="#7f1d1d" />
                  <path d="M118 36 L132 32 L132 38 L120 41 Z" fill="#b91c1c" />
                  {/* Headlight */}
                  <path d="M122 43 L130 45 L130 49 L122 48 Z" fill="#fef08a" />
                  <path className="dashboard-headlight" d="M130 44 L138 42 L138 52 L130 50 Z" fill="rgba(254,240,138,0.5)" />
                  {/* Racing stripe */}
                  <rect x="58" y="25" width="6" height="12" rx="3" fill="#fef2f2" opacity="0.9" />

                  {/* Rear wheel (spinning) */}
                  <g className="dashboard-wheel" style={{ transformOrigin: '36px 54px' }}>
                    <circle cx="36" cy="54" r="11" fill="#111827" />
                    <circle cx="36" cy="54" r="5" fill="#9ca3af" />
                    <rect x="34.8" y="45.5" width="2.4" height="8" rx="1" fill="#e5e7eb" />
                    <rect x="34.8" y="54.5" width="2.4" height="8" rx="1" fill="#e5e7eb" />
                  </g>
                  {/* Front wheel (spinning) */}
                  <g className="dashboard-wheel" style={{ transformOrigin: '106px 54px' }}>
                    <circle cx="106" cy="54" r="11" fill="#111827" />
                    <circle cx="106" cy="54" r="5" fill="#9ca3af" />
                    <rect x="104.8" y="45.5" width="2.4" height="8" rx="1" fill="#e5e7eb" />
                    <rect x="104.8" y="54.5" width="2.4" height="8" rx="1" fill="#e5e7eb" />
                  </g>
                </svg>
              </div>
            </div>
          </section>

          {/* Retro cricket scoreboard (replaces the hourly output table) */}
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
