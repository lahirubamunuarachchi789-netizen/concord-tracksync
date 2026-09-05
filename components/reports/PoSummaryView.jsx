'use client';

// Concord TrackSync - PoSummaryView - PO Summary Report tab.
// Search a PO -> size matrix (35-50) with departments stacked in sequence.

import { useState, useCallback } from 'react';
import { SpinnerIcon } from '@/components/icons';
import {
  buildPoSummary,
  CUT_ROW_LABEL,
  TOTAL_KEY,
  STANDARD_SIZES,
} from '@/lib/reportsService';

const DEPARTMENT_METRIC_ROWS = [
  { key: 'in', label: 'IN' },
  { key: 'out', label: 'OUT' },
  { key: 'bGrade', label: 'B Grade' },
  { key: 'cGrade', label: 'C Grade' },
  { key: 'labTesting', label: 'Lab Testing' },
  { key: 'outTotal', label: 'Out Total' },
  { key: 'balanceToCut', label: 'Balance to Cut' },
];

export default function PoSummaryView() {
  const [poInput, setPoInput] = useState('');
  const [searchedPo, setSearchedPo] = useState('');
  const [matrix, setMatrix] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const runSearch = useCallback(async () => {
    const po = poInput.trim();
    if (!po) return;
    setLoading(true);
    setError(null);
    setSearchedPo(po);
    try {
      const result = await buildPoSummary(po);
      setMatrix(result);
    } catch (err) {
      setError(err?.message || 'Failed to load PO summary.');
      setMatrix(null);
    } finally {
      setLoading(false);
    }
  }, [poInput]);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runSearch();
      }
    },
    [runSearch]
  );

  return (
    <section aria-labelledby="po-summary-heading">
      <h3 id="po-summary-heading" className="text-lg font-semibold text-slate-900">
        PO Summary Report
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        Search a PO to generate a size-by-department production matrix (sizes 35–50).
      </p>

      <div className="mt-4 flex max-w-md gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={poInput}
            onChange={(e) => setPoInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter PO number (e.g. 144065)"
            aria-label="PO number"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
        </div>
        <button
          type="button"
          onClick={runSearch}
          disabled={loading || !poInput.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? (
            <>
              <SpinnerIcon className="h-4 w-4 animate-spin" />
              Loading
            </>
          ) : (
            'Search'
          )}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading && (
        <div className="mt-6 flex items-center gap-2 text-sm text-slate-500">
          <SpinnerIcon className="h-4 w-4 animate-spin" />
          Building matrix for PO {searchedPo}...
        </div>
      )}

      {!loading && !matrix && !error && !searchedPo && (
        <div className="mt-6 flex h-32 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-400">
          Enter a PO number and press Search to view the summary.
        </div>
      )}

      {!loading && matrix && <MatrixTable matrix={matrix} />}
    </section>
  );
}


/* ----------------------- matrix rendering --------------------------- */

function MatrixTable({ matrix }) {
  const { po, sizes, rows } = matrix;
  const columns = [...sizes, TOTAL_KEY];

  return (
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white shadow-md">
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-xs">
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 top-0 z-30 border-b border-slate-600 bg-slate-800 px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wider text-slate-200"
                style={{ minWidth: '160px' }}
              >
                Department / Metric
              </th>
              {sizes.map((size) => (
                <th
                  key={size}
                  scope="col"
                  className="sticky top-0 z-20 border-l border-b border-slate-600/40 bg-slate-800 px-2 py-3 text-center text-[11px] font-bold uppercase tracking-wider text-slate-200"
                >
                  {size}
                </th>
              ))}
              <th
                scope="col"
                className="sticky top-0 z-20 border-l border-b border-slate-600 bg-slate-900 px-3 py-3 text-center text-[11px] font-extrabold uppercase tracking-wider text-white"
              >
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) =>
              row.type === 'cut' ? (
                <CutRow key="cut" row={row} columns={columns} />
              ) : (
                <DepartmentSection
                  key={row.name}
                  row={row}
                  columns={columns}
                  isFirst={rowIdx === 1}
                />
              )
            )}
          </tbody>
        </table>
      </div>
      <div className="border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-500 rounded-b-2xl">
        PO:&nbsp;<span className="font-bold text-slate-800">{po}</span>
        <span className="ml-4 text-slate-400">
          Sizes {STANDARD_SIZES[0]}–{STANDARD_SIZES[STANDARD_SIZES.length - 1]}
        </span>
      </div>
    </div>
  );
}


/** Cut OUT row (amber/gold band) sourced from pod.cut_qty. */
function CutRow({ row, columns }) {
  return (
    <tr className="bg-gradient-to-r from-amber-50 to-yellow-50">
      <th
        scope="row"
        className="sticky left-0 z-10 border-b border-r border-amber-200 bg-amber-100/80 px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wide text-amber-900"
      >
        {row.label}
      </th>
      {columns.map((col) => (
        <td
          key={col}
          className={`border-b border-amber-100 px-2 py-2.5 text-center font-bold ${
            col === TOTAL_KEY ? 'bg-amber-200/60 text-amber-900' : 'text-amber-800'
          }`}
        >
          {row.values[col] ?? 0}
        </td>
      ))}
    </tr>
  );
}

/** One department section: header band + metric rows. */
function DepartmentSection({ row, columns, isFirst }) {
  return (
    <>
      <tr className={isFirst ? '' : 'border-t-2 border-slate-400'}>
        <th
          scope="row"
          colSpan={columns.length + 1}
          className="sticky left-0 z-10 border-b border-r border-slate-200 bg-gradient-to-r from-slate-100 to-slate-200 px-4 py-2.5 text-left"
        >
          <span className="text-xs font-extrabold uppercase tracking-wider text-slate-800">
            {row.name}
          </span>
          <span className="ml-2 rounded-full bg-slate-300/60 px-2 py-0.5 text-[10px] font-semibold normal-case text-slate-600">
            seq {row.sequence}
          </span>
        </th>
      </tr>
      {DEPARTMENT_METRIC_ROWS.map((metric) => (
        <tr key={metric.key} className={metricRowClass(metric.key)}>
          <th
            scope="row"
            className={metricLabelClass(metric.key)}
          >
            {metric.label}
          </th>
          {columns.map((col) => {
            const value = row.metrics[col]?.[metric.key] ?? 0;
            const isTotal = col === TOTAL_KEY;
            return (
              <td
                key={col}
                className={metricCellClass(metric.key, value, isTotal)}
              >
                {value}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}


/** Background tint for a metric row based on its type. */
function metricRowClass(key) {
  switch (key) {
    case 'outTotal':
      return 'bg-emerald-50/50';
    case 'balanceToCut':
      return 'bg-amber-50';
    case 'bGrade':
      return 'bg-orange-50/30';
    case 'cGrade':
      return 'bg-rose-50/30';
    case 'labTesting':
      return 'bg-violet-50/30';
    default:
      return '';
  }
}

/** Sticky metric-label cell class; Balance to Cut gets the amber accent. */
function metricLabelClass(key) {
  const base =
    'sticky left-0 z-10 border-b border-r border-slate-100 px-4 py-1.5 text-left text-[11px] font-medium';
  if (key === 'balanceToCut') {
    return `${base} bg-amber-100/80 font-bold text-amber-900`;
  }
  return `${base} bg-white text-slate-600`;
}

/** Data cell class with color accents for QC categories and balance. */
function metricCellClass(key, value, isTotal) {
  const base = 'border-b border-slate-100 px-2 py-1.5 text-center';

  // Balance to Cut: prominent cream/amber highlight across data cells.
  if (key === 'balanceToCut') {
    const tint = isTotal ? 'bg-amber-200/70 font-bold' : 'bg-amber-50 font-semibold';
    if (value > 0) return `${base} ${tint} text-emerald-700`;
    if (value < 0) return `${base} ${tint} text-red-600`;
    return `${base} ${tint} text-amber-900`;
  }

  const weight = isTotal ? 'bg-slate-50 font-bold text-slate-800' : 'font-medium text-slate-700';
  if (key === 'bGrade') return `${base} ${weight} text-orange-700`;
  if (key === 'cGrade') return `${base} ${weight} text-rose-700`;
  if (key === 'labTesting') return `${base} ${weight} text-violet-700`;
  if (key === 'outTotal') return `${base} ${weight} text-emerald-800`;
  return `${base} ${weight}`;
}
