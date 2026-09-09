'use client';

// Concord TrackSync - DailyOutputView - Daily Output Report tab.
//
// Control bar (department, SLST date, record & QC status) feeding a sticky
// size-35-50 matrix: per-PO unit counts, a per-PO Daily Total and Cumulative
// Output, plus a footer summing every column. Exports produce a native .xlsx
// via SheetJS (sheetjs/xlsx, lazily imported).

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, DownloadIcon, FileTextIcon, SpinnerIcon } from '@/components/icons';
import {
  buildDailyOutputRawXlsx,
  fetchDailyOutputRawRows,
  fetchDailyOutputReport,
  fetchDepartments,
  formatSlstDate,
  STANDARD_SIZES,
} from '@/lib/reportsService';
// Filter option sets are canonically defined on the DB wrapper; import them
// directly so the UI consumes a single source of truth. The QC filter is a
// MULTI-select: 'ALL' or any combination of Forward / B Grade / C Grade /
// Lab Testing / Return / Reworked (DAILY_OUTPUT_QC_STATUSES).
import {
  DAILY_OUTPUT_QC_STATUSES,
  DAILY_OUTPUT_RECORD_OPTIONS,
} from '@/lib/db';

const STICKY_HEADER = 'sticky top-0 z-20 bg-gray-900 text-white';
const STICKY_COLUMN = 'sticky left-0 z-30 bg-gray-800 text-white font-semibold';

/** Trigger a browser download for the generated .xlsx workbook. */
function downloadXlsx(fileName, buffer) {
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Trigger a browser download for the generated PDF document. */
function downloadPdf(fileName, buffer) {
  const blob = new Blob([buffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function DailyOutputView() {
  const [departments, setDepartments] = useState([]);
  const [departmentId, setDepartmentId] = useState('');
  const [date, setDate] = useState('');
  const [recordStatus, setRecordStatus] = useState('ALL');
  // Multi-select QC status filter: ['ALL'] (no status filter) or any
  // combination of concrete statuses from DAILY_OUTPUT_QC_STATUSES.
  const [qcStatuses, setQcStatuses] = useState(['ALL']);
  const [matrix, setMatrix] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [exportPdfError, setExportPdfError] = useState(null);

  // Default date = today in YYYY-MM-DD SLST format.
  useEffect(() => {
    if (!date) setDate(formatSlstDate(new Date()));
  }, [date]);

  // Department options come from the departments table (name + sequence).
  useEffect(() => {
    fetchDepartments()
      .then((d) => setDepartments(Array.isArray(d) ? d : []))
      .catch(() => setDepartments([]));
  }, []);

  const runSearch = useCallback(async () => {
    if (!date) return;
    setLoading(true);
    setError(null);
    setMatrix(null);
    try {
      const result = await fetchDailyOutputReport({
        departmentId,
        date,
        recordStatus,
        qcStatuses,
      });
      setMatrix(result);
    } catch (err) {
      setError(err?.message || 'Failed to load Daily Output report.');
    } finally {
      setLoading(false);
    }
  }, [departmentId, date, recordStatus, qcStatuses]);

  const handleExport = useCallback(async () => {
    if (!date) return;
    setExporting(true);
    setExportError(null);
    try {
      // Export pulls the exact raw scan records behind the matrix (not the
      // aggregation), with created_at converted to SLST in the sheet.
      const rawRows = await fetchDailyOutputRawRows({
        departmentId,
        date,
        recordStatus,
        qcStatuses,
      });
      const { buffer, fileName } = await buildDailyOutputRawXlsx(rawRows, {
        departmentId,
        date,
        recordStatus,
        qcStatus: qcStatuses.includes('ALL') ? 'ALL' : qcStatuses.join(', '),
      });
      downloadXlsx(fileName, buffer);
    } catch (err) {
      setExportError(err?.message || 'Failed to export Excel.');
    } finally {
      setExporting(false);
    }
  }, [departmentId, date, recordStatus, qcStatuses]);

  const handlePdfExport = useCallback(async () => {
    if (!matrix || !date) return;
    setExportingPdf(true);
    setExportPdfError(null);
    try {
      // Multi-select travels as a comma-separated qcStatuses parameter;
      // 'ALL' is passed explicitly so the banner renders 'ALL'.
      const qcParam = qcStatuses.includes('ALL')
        ? 'ALL'
        : qcStatuses.join(',');
      const params = new URLSearchParams({
        departmentId,
        date,
        recordStatus,
        qcStatuses: qcParam,
      });
      const res = await fetch(`/api/reports/daily-output-pdf?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Failed to export PDF.');
      }
      const blob = await res.blob();
      const fileName = `Daily_Output_Report_${date}.pdf`;
      downloadPdf(fileName, await blob.arrayBuffer());
    } catch (err) {
      setExportPdfError(err?.message || 'Failed to export PDF.');
    } finally {
      setExportingPdf(false);
    }
  }, [matrix, departmentId, date, recordStatus, qcStatuses]);
  return (
    <section aria-labelledby="daily-output-heading">
      <h3
        id="daily-output-heading"
        className="text-lg font-semibold text-slate-900"
      >
        Daily Output Report
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        Daily production output by PO and shoe size (35&ndash;50) for the
        selected department and date.
      </p>

      <div className="mt-4 flex max-w-4xl flex-wrap items-center gap-2">
        {/* Department Selector */}
        <div className="relative min-w-[180px] flex-1">
          <select
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            aria-label="Department"
            className="w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          >
            <option value="">All Departments</option>
            {departments.map((dept) => (
              <option key={dept.department} value={dept.department}>
                {dept.department}
              </option>
            ))}
          </select>
          <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
        </div>

        {/* Date Picker (YYYY-MM-DD SLST) */}
        <div className="relative min-w-[160px] flex-1">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-label="Date (Sri Lanka)"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
        </div>

        {/* Record Status */}
        <div className="relative min-w-[150px] flex-1">
          <select
            value={recordStatus}
            onChange={(e) => setRecordStatus(e.target.value)}
            aria-label="Record Status"
            className="w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          >
            {DAILY_OUTPUT_RECORD_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
        </div>

        {/* QC Status - MULTI-select (ALL or any combination of statuses) */}
        <QcMultiSelect selected={qcStatuses} onChange={setQcStatuses} />

        {/* Search */}
        <button
          type="button"
          onClick={runSearch}
          disabled={loading || !date}
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

        {/* Download PDF */}
        <button
          type="button"
          onClick={handlePdfExport}
          disabled={exportingPdf || !matrix}
          className="inline-flex items-center gap-2 rounded-lg border border-red-600 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 shadow-sm transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {exportingPdf ? (
            <>
              <SpinnerIcon className="h-4 w-4 animate-spin" />
              Exporting
            </>
          ) : (
            <>
              <FileTextIcon className="h-4 w-4" />
              Download PDF
            </>
          )}
        </button>

        {/* Export to Excel (.xlsx) */}
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting || !date}
          className="inline-flex items-center gap-2 rounded-lg border border-emerald-600 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 shadow-sm transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {exporting ? (
            <>
              <SpinnerIcon className="h-4 w-4 animate-spin" />
              Exporting
            </>
          ) : (
            <>
              <DownloadIcon className="h-4 w-4" />
              Export to Excel (.xlsx)
            </>
          )}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {exportError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {exportError}
        </div>
      )}

      {exportPdfError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {exportPdfError}
        </div>
      )}

      {loading && (
        <div className="mt-6 flex items-center gap-2 text-sm text-slate-500">
          <SpinnerIcon className="h-4 w-4 animate-spin" />
          Building Daily Output matrix...
        </div>
      )}

      {!loading && !matrix && !error && (
        <div className="mt-6 flex h-32 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-400">
          Pick a date/department and press Search to view the matrix.
        </div>
      )}

      {!loading && matrix && <MatrixTable matrix={matrix} />}
    </section>
  );
}

/**
 * Multi-select QC status dropdown: 'ALL' or any combination of the concrete
 * statuses (DAILY_OUTPUT_QC_STATUSES). Checking ALL clears the individual
 * selections; checking any status clears ALL; clearing everything falls
 * back to ALL. The panel closes on an outside click or Escape.
 */
function QcMultiSelect({ selected, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  // Close on an outside click / Escape so the dropdown never traps the page.
  useEffect(() => {
    if (!open) return undefined;
    function handlePointer(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    }
    function handleKey(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const allSelected = selected.includes('ALL');
  const label = allSelected || selected.length === 0 ? 'ALL' : selected.join(', ');

  function toggleOption(option) {
    if (option === 'ALL') {
      onChange(['ALL']);
      return;
    }
    const current = allSelected ? [] : [...selected];
    const next = current.includes(option)
      ? current.filter((status) => status !== option)
      : [...current, option].sort(
          (a, b) =>
            DAILY_OUTPUT_QC_STATUSES.indexOf(a) -
            DAILY_OUTPUT_QC_STATUSES.indexOf(b)
        );
    onChange(next.length > 0 ? next : ['ALL']);
  }

  return (
    <div ref={rootRef} className="relative min-w-[190px] flex-1">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="QC Status"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-900 shadow-sm transition-colors hover:border-blue-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
      >
        <span className="truncate" title={label}>
          {label}
        </span>
        <ChevronDownIcon
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="absolute left-0 right-0 z-40 mt-1 max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
        >
          {['ALL', ...DAILY_OUTPUT_QC_STATUSES].map((option) => {
            const checked =
              option === 'ALL'
                ? allSelected
                : !allSelected && selected.includes(option);
            return (
              <label
                key={option}
                className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-slate-800 transition-colors hover:bg-blue-50"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleOption(option)}
                  className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                {option}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Sticky header + frozen PO column + size 35-50 matrix + summary footer. */
function MatrixTable({ matrix }) {
  const { sizes, rows, summary } = matrix;
  const sizeColumns = sizes || STANDARD_SIZES;
  const footerSums = summary || { sizes: {}, dailyTotal: 0, cumulativeOutput: 0 };

  return (
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white shadow-md">
      <div className="relative max-h-[calc(100vh-220px)] overflow-y-auto overflow-x-auto border border-slate-700 rounded-lg">
        <table className="min-w-full border-collapse text-xs">
          <thead>
            <tr className={STICKY_HEADER}>
              <th
                scope="col"
                className={`${STICKY_COLUMN} border-b-0 px-3 py-2.5 text-left`}
                style={{ minWidth: '140px' }}
              >
                PO Number
              </th>
              {sizeColumns.map((size) => (
                <th
                  key={size}
                  scope="col"
                  className="border-b border-gray-700 px-2 py-2 text-center text-xs font-semibold uppercase"
                >
                  {size}
                </th>
              ))}
              <th
                scope="col"
                className="border-l border-b border-gray-700 px-2 py-2 text-center text-xs font-extrabold uppercase"
              >
                Daily Total
              </th>
              <th
                scope="col"
                className="border-l border-b border-gray-700 px-2 py-2 text-center text-xs font-extrabold uppercase"
              >
                Cumulative Output
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.po} className="border-b border-gray-100">
                <td
                  className={`${STICKY_COLUMN} border-r border-gray-200 px-3 py-1.5 text-left`}
                >
                  {row.po}
                </td>
                {sizeColumns.map((size) => (
                  <td
                    key={size}
                    className="border-r border-gray-100 px-2 py-1.5 text-center"
                  >
                    {row.sizes[size] ?? 0}
                  </td>
                ))}
                <td className="border-l border-gray-200 px-2 py-1.5 text-center font-medium">
                  {row.dailyTotal}
                </td>
                <td className="border-l border-gray-200 px-2 py-1.5 text-center font-medium">
                  {row.cumulativeOutput}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-gray-100">
              <td
                className={`${STICKY_COLUMN} border-r border-gray-200 px-3 py-1.5 text-left`}
              >
                TOTAL
              </td>
              {sizeColumns.map((size) => (
                <td
                  key={size}
                  className="border-r border-gray-200 px-2 py-1.5 text-center font-bold"
                >
                  {footerSums.sizes[size] ?? 0}
                </td>
              ))}
              <td className="border-l border-gray-200 px-2 py-1.5 text-center font-bold text-amber-800">
                {footerSums.dailyTotal}
              </td>
              <td className="border-l border-gray-200 px-2 py-1.5 text-center font-bold text-amber-800">
                {footerSums.cumulativeOutput}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

