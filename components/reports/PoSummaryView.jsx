'use client';

// ============================================================
// PoSummaryView - PO Summary Report (the "PO Summary" tab).
//
// Lets the user search a PO number. On search the view builds a
// Size Matrix: sizes (35..48, dynamically from pod.cut_qty)
// across the top, every production department stacked vertically
// in sequence order. Each department section shows:
//   IN | OUT | B Grade | C Grade | Lab Testing | Out Total |
//   Balance to Cut
// plus a trailing Total column summing every metric across sizes.
// The top "Cut OUT" row is sourced from pod.cut_qty.
// ============================================================

import { useState, useCallback } from 'react';
import { SpinnerIcon } from '@/components/icons';
import {
  buildPoSummary,
  CUT_ROW_LABEL,
  TOTAL_KEY,
} from '@/lib/reportsService';

/** Metric rows rendered inside every department section, in order. */
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
        Search a PO to generate a size-by-department production matrix.
      </p>

      {/* ---- PO search input ---- */}
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

      {/* ---- Error state ---- */}
      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ---- Loading state ---- */}
      {loading && (
        <div className="mt-6 flex items-center gap-2 text-sm text-slate-500">
          <SpinnerIcon className="h-4 w-4 animate-spin" />
          Building matrix for PO {searchedPo}...
        </div>
      )}

      {/* ---- Empty: no search yet ---- */}
      {!loading && !matrix && !error && !searchedPo && (
        <div className="mt-6 flex h-32 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-400">
          Enter a PO number and press Search to view the summary.
        </div>
      )}

      {/* ---- Empty: search returned no cut data ---- */}
      {!loading && matrix && matrix.sizes.length === 0 && (
        <div className="mt-6 flex h-32 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-400">
          No cut quantity data found for PO {searchedPo}.
        </div>
      )}

      {/* ---- Matrix table ---- */}
      {!loading && matrix && matrix.sizes.length > 0 && (
        <MatrixTable matrix={matrix} />
      )}
    </section>
  );
}

/**
 * Render the full matrix table for a built PO summary.
 * Columns: size columns (numerically sorted) + Total.
 * Rows: Cut OUT, then each department section.
 */
function MatrixTable({ matrix }) {
  const { po, sizes, rows } = matrix;
  const columns = [...sizes, TOTAL_KEY];

  return (
    <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full border-collapse text-xs">
        <thead>
          <tr className="bg-slate-50">
            <th
              scope="col"
              className="sticky left-0 z-10 border-b border-r border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              Department / Metric
            </th>
            {sizes.map((size) => (
              <th
                key={size}
                scope="col"
                className="border-b border-slate-200 px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                {size}
              </th>
            ))}
            <th
              scope="col"
              className="border-b border-slate-200 bg-slate-100 px-3 py-2 text-center text-xs font-bold uppercase tracking-wide text-slate-700"
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
      <div className="border-t border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
        PO: <span className="font-semibold text-slate-700">{po}</span>
      </div>
    </div>
  );
}

/** The top "Cut OUT" row — sourced from pod.cut_qty. */
function CutRow({ row, columns }) {
  return (
    <tr className="bg-amber-50/60">
      <th
        scope="row"
        className="sticky left-0 z-10 border-b border-r border-slate-200 bg-amber-50/80 px-3 py-2 text-left text-xs font-semibold text-amber-800"
      >
        {row.label}
      </th>
      {columns.map((col) => (
        <td
          key={col}
          className={`border-b border-slate-200 px-3 py-2 text-center font-semibold ${
            col === TOTAL_KEY ? 'bg-amber-100/60 text-amber-900' : 'text-amber-800'
          }`}
        >
          {row.values[col] ?? 0}
        </td>
      ))}
    </tr>
  );
}

/**
 * One department section: a header row followed by the metric rows
 * (IN, OUT, B Grade, C Grade, Lab Testing, Out Total, Balance to Cut).
 */
function DepartmentSection({ row, columns, isFirst }) {
  return (
    <>
      <tr className={isFirst ? '' : 'border-t-2 border-slate-300'}>
        <th
          scope="row"
          colSpan={columns.length + 1}
          className="sticky left-0 z-10 border-b border-r border-slate-200 bg-slate-100 px-3 py-2 text-left text-xs font-bold uppercase tracking-wide text-slate-700"
        >
          {row.name}
          <span className="ml-2 font-normal normal-case text-slate-400">
            seq {row.sequence}
          </span>
        </th>
      </tr>
      {DEPARTMENT_METRIC_ROWS.map((metric) => (
        <tr
          key={metric.key}
          className={
            metric.key === 'outTotal'
              ? 'bg-blue-50/40'
              : metric.key === 'balanceToCut'
                ? 'bg-emerald-50/40'
                : ''
          }
        >
          <th
            scope="row"
            className="sticky left-0 z-10 border-b border-r border-slate-200 bg-white px-3 py-1.5 text-left text-xs font-medium text-slate-600"
          >
            {metric.label}
          </th>
          {columns.map((col) => {
            const value = row.metrics[col]?.[metric.key] ?? 0;
            const isTotal = col === TOTAL_KEY;
            return (
              <td
                key={col}
                className={`border-b border-slate-100 px-3 py-1.5 text-center ${
                  isTotal
                    ? 'bg-slate-50 font-semibold text-slate-700'
                    : 'text-slate-700'
                } ${
                  metric.key === 'balanceToCut' && value > 0
                    ? 'text-emerald-700'
                    : ''
                } ${metric.key === 'balanceToCut' && value < 0 ? 'text-red-600' : ''}`}
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


