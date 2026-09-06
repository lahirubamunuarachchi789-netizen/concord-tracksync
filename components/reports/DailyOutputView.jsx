'use client';

// Concord TrackSync - DailyOutputView - Daily Output Report tab.
//
// Control bar (department, SLST date, record & QC status) feeding a sticky
// size-35-50 matrix: per-PO unit counts, a per-PO Daily Total and Cumulative
// Output, plus a footer summing every column. Exports produce a native .xlsx
// via SheetJS (sheetjs/xlsx, lazily imported).

import { useCallback, useEffect, useState } from 'react';
import { ChevronDownIcon, DownloadIcon, FileTextIcon, SpinnerIcon } from '@/components/icons';
import {
  buildDailyOutputXlsx,
  fetchDailyOutputReport,
  fetchDepartments,
  formatSlstDate,
  STANDARD_SIZES,
} from '@/lib/reportsService';
// Filter option sets are canonically defined on the DB wrapper; import them
// directly so the UI consumes a single source of truth.
import {
  DAILY_OUTPUT_QC_OPTIONS,
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
  const [qcStatus, setQcStatus] = useState('ALL');
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
        qcStatus,
      });
      setMatrix(result);
    } catch (err) {
      setError(err?.message || 'Failed to load Daily Output report.');
    } finally {
      setLoading(false);
    }
  }, [departmentId, date, recordStatus, qcStatus]);

  const handleExport = useCallback(async () => {
    if (!matrix) return;
    setExporting(true);
    setExportError(null);
    try {
      const { buffer, fileName } = await buildDailyOutputXlsx(matrix, {
        departmentId,
        date,
        recordStatus,
        qcStatus,
      });
      downloadXlsx(fileName, buffer);
    } catch (err) {
      setExportError(err?.message || 'Failed to export Excel.');
    } finally {
      setExporting(false);
    }
  }, [matrix, departmentId, date, recordStatus, qcStatus]);

  const handlePdfExport = useCallback(async () => {
    if (!matrix || !date) return;
    setExportingPdf(true);
    setExportPdfError(null);
    try {
      const params = new URLSearchParams({
        departmentId,
        date,
        recordStatus,
        qcStatus,
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
  }, [matrix, departmentId, date, recordStatus, qcStatus]);
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

        {/* QC Status */}
        <div className="relative min-w-[170px] flex-1">
          <select
            value={qcStatus}
            onChange={(e) => setQcStatus(e.target.value)}
            aria-label="QC Status"
            className="w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          >
            {DAILY_OUTPUT_QC_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
        </div>

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
          disabled={exporting || !matrix}
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

