// Concord TrackSync - Reports service - PO Summary aggregation
//
// NOTE: this module intentionally has NO 'use client' directive. It is
// isomorphic:
//   - UI components (DailyOutputView, PoSummaryView) declare their own
//     'use client' boundary, which pulls this module into the client bundle.
//   - Server Route Handlers (app/api/reports/daily-output-pdf/route.js)
//     import it directly, because database access and report aggregation
//     must execute on the server.
// A 'use client' here would turn every export into a client-reference stub
// and break the server-side PDF/API route.

import {
  supabase,
  DAILY_OUTPUT_COLUMNS,
  DAILY_OUTPUT_RAW_COLUMNS,
  DAILY_OUTPUT_DEPARTMENT_COLUMN,
  DAILY_OUTPUT_RECORD_OPTIONS,
  DAILY_OUTPUT_QC_STATUSES,
  DAILY_OUTPUT_NO_QC_LABEL,
} from './db.js';

import { parseOrgQr, normalizeSizeValue } from './transactionDualScan.js';

// Re-export the Daily Output column/department constants and the QC defect
// category set so report consumers (and tests) import everything from the
// service layer instead of reaching into the DB wrapper directly.
export {
  DAILY_OUTPUT_COLUMNS,
  DAILY_OUTPUT_RAW_COLUMNS,
  DAILY_OUTPUT_DEPARTMENT_COLUMN,
  DAILY_OUTPUT_QC_STATUSES,
  DAILY_OUTPUT_NO_QC_LABEL,
  QC_DEFECT_CATEGORIES,
} from './db.js';

export const POD_TABLE = 'pod';
export const DATA_UPDATES_TABLE = 'data_updates';
export const DEPARTMENTS_TABLE = 'departments';
export const QC_CATEGORIES = ['B Grade', 'C Grade', 'Lab Testing'];
export const RECORD_STATUSES = ['IN', 'OUT'];
export const CUT_ROW_LABEL = 'Cut OUT';
export const TOTAL_KEY = 'total';

// Fixed size range for the PO Summary matrix: 35 through 50 inclusive.
export const STANDARD_SIZES = Array.from({ length: 16 }, (_, i) => String(35 + i));

// QC statuses that are excluded from the OUT count (they are tracked
// separately as QC categories instead).
const QC_EXCLUDED_FROM_OUT = new Set(QC_CATEGORIES.map((s) => s.toUpperCase()));

/** Fresh zeroed metrics bucket for one department + size cell. */
export function emptyMetrics() {
  return {
    in: 0,
    out: 0,
    forward: 0,
    return: 0,
    reworked: 0,
    bGrade: 0,
    cGrade: 0,
    labTesting: 0,
    outTotal: 0,
  };
}

/** True when a qc_status should be excluded from the OUT count. */
function isQcExcludedFromOut(qcStatus) {
  return QC_EXCLUDED_FROM_OUT.has(String(qcStatus || '').trim().toUpperCase());
}

/** Fetch cut_qty per size from pod for a PO. Returns {} on failure. */
export async function fetchCutQtyBySize(po) {
  const poValue = String(po ?? '').trim();
  if (!poValue) return {};
  try {
    const { data, error } = await supabase
      .from(POD_TABLE).select('size, cut_qty').eq('po', poValue);
    if (error) throw error;
    const result = {};
    for (const row of data || []) {
      if (row?.size == null || row?.cut_qty == null) continue;
      result[normalizeSizeValue(row.size)] = Number(row.cut_qty);
    }
    return result;
  } catch {
    return {};
  }
}

/** Fetch departments in sequence order. Returns [] on failure. */
export async function fetchDepartments() {
  try {
    const { data, error } = await supabase
      .from(DEPARTMENTS_TABLE)
      .select('id, department, sequence')
      .order('sequence', { ascending: true })
      .order('department', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch {
    return [];
  }
}

/** Fetch recent data_updates rows (bounded). Returns [] on failure. */
export async function fetchAllDataUpdates() {
  try {
    const { data, error } = await supabase
      .from(DATA_UPDATES_TABLE)
      .select('qr_code, inner_qr, record_status, qc_status, department, count, created_by, created_at')
      .order('created_at', { ascending: false })
      .limit(10000);
    if (error) throw error;
    return data || [];
  } catch {
    return [];
  }
}

/**
 * Pure: aggregate data_updates into per-department, per-size metrics
 * for ONE target PO. Only rows whose qr_code encodes the target PO
 * AND a size present in `sizes` are counted.
 *
 * Metrics:
 *   in         - rows with record_status 'IN'
 *   out        - rows with record_status 'OUT' only, EXCLUDING any
 *                row whose qc_status is B Grade, C Grade, or Lab
 *                Testing (those are tracked separately below).
 *   forward    - rows with qc_status 'Forward'
 *   return     - rows with qc_status 'Return'
 *   reworked   - rows with qc_status 'Reworked'
 *   bGrade     - rows with qc_status 'B Grade'
 *   cGrade     - rows with qc_status 'C Grade'
 *   labTesting - rows with qc_status 'Lab Testing'
 *   outTotal   - SUM of all QC status quantities (Forward + Return +
 *                Reworked + B Grade + C Grade + Lab Testing), i.e.
 *                the combined output across all QC categories.
 */
export function aggregateMetricsByDepartmentSize(dataUpdates, po, sizes) {
  const poValue = String(po ?? '').trim();
  const sizeSet = new Set(sizes.map((s) => normalizeSizeValue(s)));
  const metrics = {};

  for (const row of dataUpdates || []) {
    const parsed = parseOrgQr(row?.qr_code);
    if (!parsed.po || String(parsed.po).trim() !== poValue) continue;
    if (parsed.size == null) continue;
    const sizeKey = normalizeSizeValue(parsed.size);
    if (!sizeSet.has(sizeKey)) continue;
    const dept = String(row?.department ?? '').trim();
    if (!dept) continue;

    if (!metrics[dept]) metrics[dept] = {};
    if (!metrics[dept][sizeKey]) metrics[dept][sizeKey] = emptyMetrics();

    const m = metrics[dept][sizeKey];
    const recordStatus = String(row?.record_status ?? '').trim();
    const qcStatus = String(row?.qc_status ?? '').trim();
    const count = Number.isFinite(Number(row?.count)) ? Number(row.count) : 0;

    if (recordStatus === 'IN') m.in += 1;
    // OUT count: only standard PASS/Good records (exclude QC categories).
    if (recordStatus === 'OUT' && !isQcExcludedFromOut(qcStatus)) m.out += 1;
    if (qcStatus === 'Forward') m.forward += count;
    if (qcStatus === 'Return') m.return += count;
    if (qcStatus === 'Reworked') m.reworked += count;
    if (qcStatus === 'B Grade') m.bGrade += count;
    if (qcStatus === 'C Grade') m.cGrade += count;
    if (qcStatus === 'Lab Testing') m.labTesting += count;
  }

  // Compute Out Total as the sum of all QC status quantities
  for (const dept of Object.keys(metrics)) {
    for (const size of Object.keys(metrics[dept])) {
      const m = metrics[dept][size];
      m.outTotal =
        m.forward + m.return + m.reworked + m.bGrade + m.cGrade + m.labTesting;
    }
  }

  return metrics;
}

/** Pure: sum metrics across sizes for the Total column. */
export function sumMetricsAcrossSizes(sizeMetrics, sizes) {
  const total = emptyMetrics();
  for (const size of sizes) {
    const m = sizeMetrics[size];
    if (!m) continue;
    total.in += m.in;
    total.out += m.out;
    total.forward += m.forward;
    total.return += m.return;
    total.reworked += m.reworked;
    total.bGrade += m.bGrade;
    total.cGrade += m.cGrade;
    total.labTesting += m.labTesting;
    total.outTotal += m.outTotal;
  }
  return total;
}

/**
 * Build the complete PO Summary matrix for one PO.
 * Returns { po, sizes, cutQty, rows } where rows[0] is the Cut OUT
 * row and subsequent rows are department sections.
 *
 * The size axis is fixed to 35-50 (STANDARD_SIZES). Sizes with no
 * cut_qty in pod are filled with 0.
 *
 * WIP (Work In Progress) is calculated between sequential stages:
 *   WIP = Out Total of preceding sequence - Out Total of current sequence
 * This reflects work-in-progress stock sitting between departments.
 */
export async function buildPoSummary(po) {
  const poValue = String(po ?? '').trim();
  if (!poValue) {
    return { po: poValue, sizes: STANDARD_SIZES, cutQty: {}, rows: [] };
  }

  const [cutQtyMap, dataUpdates, departments] = await Promise.all([
    fetchCutQtyBySize(poValue),
    fetchAllDataUpdates(),
    fetchDepartments(),
  ]);

  const sizes = STANDARD_SIZES;
  const deptMetrics = aggregateMetricsByDepartmentSize(dataUpdates, poValue, sizes);

  const rows = [];

  // Cut OUT row from pod.cut_qty (0 for sizes not in pod)
  const cutRow = { type: 'cut', label: CUT_ROW_LABEL, values: {} };
  for (const size of sizes) {
    cutRow.values[size] = cutQtyMap[size] ?? 0;
  }
  cutRow.values[TOTAL_KEY] = sizes.reduce((sum, s) => sum + (cutRow.values[s] || 0), 0);
  rows.push(cutRow);

  // Department sections in sequence order
  // Track previous sequence Out Total for WIP calculation
  let prevSequenceOutTotal = null;
  let prevSequenceLabel = null;

  for (const dept of departments) {
    const deptName = dept.department;
    const sizeMetrics = deptMetrics[deptName] || {};
    const metrics = {};

    for (const size of sizes) {
      const m = sizeMetrics[size] || emptyMetrics();
      const cutQty = cutQtyMap[size] ?? 0;
      metrics[size] = {
        in: m.in,
        out: m.out,
        forward: m.forward,
        return: m.return,
        reworked: m.reworked,
        bGrade: m.bGrade,
        cGrade: m.cGrade,
        labTesting: m.labTesting,
        outTotal: m.outTotal,
        balanceToCut: cutQty - m.outTotal,
      };
    }

    const totalMetrics = sumMetricsAcrossSizes(sizeMetrics, sizes);
    const totalCutQty = sizes.reduce((sum, s) => sum + (cutQtyMap[s] ?? 0), 0);
    metrics[TOTAL_KEY] = {
      in: totalMetrics.in,
      out: totalMetrics.out,
      forward: totalMetrics.forward,
      return: totalMetrics.return,
      reworked: totalMetrics.reworked,
      bGrade: totalMetrics.bGrade,
      cGrade: totalMetrics.cGrade,
      labTesting: totalMetrics.labTesting,
      outTotal: totalMetrics.outTotal,
      balanceToCut: totalCutQty - totalMetrics.outTotal,
    };

    // Calculate WIP: preceding sequence Out Total - current sequence Out Total
    const currentOutTotal = totalMetrics.outTotal;
    let wipBySize = {};
    let wipTotal = 0;

    if (prevSequenceOutTotal !== null) {
      for (const size of sizes) {
        const prevOut = prevSequenceOutTotal[size] || 0;
        const currOut = sizeMetrics[size]?.outTotal || 0;
        wipBySize[size] = prevOut - currOut;
      }
      wipTotal = Object.values(wipBySize).reduce((sum, v) => sum + v, 0);
    }

    rows.push({
      type: 'department',
      name: deptName,
      sequence: dept.sequence,
      metrics,
      wip: wipBySize,
      wipTotal,
      wipFromSequence: prevSequenceLabel,
    });

    // Store current Out Total for next sequence WIP calculation
    prevSequenceOutTotal = {};
    for (const size of sizes) {
      prevSequenceOutTotal[size] = sizeMetrics[size]?.outTotal || 0;
    }
    prevSequenceLabel = deptName;
  }

  return { po: poValue, sizes, cutQty: cutQtyMap, rows };
}
/* ==================================================================
 * QR DATA EXPORT (Excel/CSV · XLSX)
 * Timestamps are converted from UTC to Sri Lanka Local Time
 * (Asia/Colombo, UTC+5:30) and formatted YYYY-MM-DD HH:mm:ss.
 * The primary export is native .xlsx via SheetJS; CSV builders are
 * kept as a lightweight alternative.
 * ================================================================== */

/** Sri Lanka Local Time zone (UTC+5:30, no DST). */
export const SLST_TIME_ZONE = 'Asia/Colombo';

/** Exact CSV header row for the QR data export. */
export const QR_DATA_CSV_HEADERS = [
  'Date & Time (SLST)',
  'PO',
  'Size',
  'Shoe QR',
  'Inner QR',
  'Department',
  'Record Status',
  'QC Status',
  'Count',
  'Created At',
];

/** Read a date part from an Intl formatToParts() array (default '00'). */
function partValue(parts, type) {
  return parts.find((p) => p.type === type)?.value ?? '00';
}

/**
 * Convert a UTC ISO timestamp into Sri Lanka Local Time and format
 * it as `YYYY-MM-DD HH:mm:ss`. Returns '' for null/invalid input.
 * @param {string|Date|null} value e.g. '2026-09-04 03:58:17.631+00'
 * @returns {string} e.g. '2026-09-04 09:28:17'
 */
export function formatSlstTimestamp(value) {
  if (value == null || value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SLST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  // Some runtimes emit '24' for midnight with hour12:false - normalize.
  const hour = partValue(parts, 'hour') === '24' ? '00' : partValue(parts, 'hour');
  return `${partValue(parts, 'year')}-${partValue(parts, 'month')}-${partValue(
    parts,
    'day'
  )} ${hour}:${partValue(parts, 'minute')}:${partValue(parts, 'second')}`;
}

/**
 * Convert a UTC ISO timestamp into Sri Lanka Local Time and return
 * just the date `YYYY-MM-DD` (used by the export file name).
 * Returns '' for null/invalid input.
 */
export function formatSlstDate(value) {
  if (value == null || value === '') return '';
  return formatSlstTimestamp(value).slice(0, 10);
}

/**
 * Escape one value for CSV: values containing a comma, quote, or
 * line break are wrapped in double quotes with inner quotes doubled.
 * Null/undefined become empty cells.
 * @param {*} value
 * @returns {string}
 */
export function escapeCsvCell(value) {
  if (value == null) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Transform one raw data_updates row into the export field array:
 * [Date & Time (SLST), PO, Size, Shoe QR, Inner QR, Department,
 *  Record Status, QC Status, Count, Created At].
 * PO and Size are parsed from the encoded org_qr string.
 * @param {object} row raw data_updates row
 * @param {string} po target PO value
 * @returns {string[]}
 */
export function transformQrRowForExport(row, po) {
  const parsed = parseOrgQr(row?.qr_code);
  return [
    formatSlstTimestamp(row?.created_at),
    String(po),
    parsed?.size != null ? String(parsed.size) : '',
    row?.qr_code ?? '',
    row?.inner_qr ?? '',
    row?.department ?? '',
    row?.record_status ?? '',
    row?.qc_status ?? '',
    row?.count ?? '',
    row?.created_at ?? '',
  ];
}

/**
 * Pure: build the complete CSV document (headers + data rows) for a
 * PO's raw QR data. Uses CRLF line endings for Excel compatibility.
 * @param {Array} rows raw data_updates rows for the PO
 * @param {string} po target PO value
 * @returns {string} CSV text
 */
export function buildQrDataCsv(rows, po) {
  const header = QR_DATA_CSV_HEADERS.map(escapeCsvCell).join(',');
  const body = (rows || [])
    .map((row) => transformQrRowForExport(row, po).map(escapeCsvCell).join(','))
    .join('\r\n');
  return body ? `${header}\r\n${body}` : header;
}

/**
 * Export file name: `PO_{po}_QR_Data_{YYYY-MM-DD}.xlsx` where the
 * date is today's date in Sri Lanka Local Time and the extension
 * defaults to `xlsx` (pass `'csv'` for the legacy CSV export).
 * @param {string} po target PO value
 * @param {string} [extension='xlsx'] file extension (without dot)
 * @returns {string}
 */
export function buildQrDataFileName(po, extension = 'xlsx') {
  const date = formatSlstDate(new Date());
  const ext = String(extension || 'xlsx').replace(/^\./, '');
  return `PO_${String(po ?? '').trim()}_QR_Data_${date}.${ext}`;
}

/** Column widths for the .xlsx QR data worksheet (Excel readability). */
export const QR_DATA_XLSX_COL_WIDTHS = [
  { wch: 20 }, // Date & Time (SLST)
  { wch: 12 }, // PO
  { wch: 8 }, // Size
  { wch: 30 }, // Shoe QR
  { wch: 30 }, // Inner QR
  { wch: 18 }, // Department
  { wch: 14 }, // Record Status
  { wch: 14 }, // QC Status
  { wch: 8 }, // Count
  { wch: 26 }, // Created At
];

/** Worksheet name inside the .xlsx workbook. */
export const QR_DATA_XLSX_SHEET_NAME = 'QR Data';

/**
 * Build a native .xlsx workbook buffer for one PO's raw QR data.
 *
 * The worksheet is built from an array-of-arrays:
 *   - Row 1 uses the exact QR_DATA_CSV_HEADERS columns.
 *   - Date & Time (SLST) cells are pre-formatted string timestamps
 *     in Sri Lanka Local Time (`YYYY-MM-DD HH:mm:ss`).
 *   - Count cells are exported as NUMERIC integers (not strings).
 *   - String columns keep Excel-native left alignment, with a bold
 *     centered header row and sized columns for readability.
 *
 * SheetJS (`xlsx`) is loaded lazily with a dynamic import so the
 * library (~large) is only fetched when an export is actually run.
 *
 * @param {Array} rows raw data_updates rows for the PO
 * @param {string} po target PO value
 * @returns {Promise<{buffer: Buffer|Uint8Array, fileName: string}>}
 *          the workable xlsx payload plus its download file name
 */
export async function buildQrDataXLSX(rows, po) {
  const XLSX = await import('xlsx');

  const aoa = [QR_DATA_CSV_HEADERS];
  for (const row of rows || []) {
    const exported = transformQrRowForExport(row, po);
    // Count stays a real number cell (never a plain string).
    if (exported[8] !== '') exported[8] = Number(exported[8]);
    aoa.push(exported);
  }

  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet['!cols'] = QR_DATA_XLSX_COL_WIDTHS;

  // Bold + centered header row.
  for (let c = 0; c < QR_DATA_CSV_HEADERS.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (!sheet[addr]) continue;
    sheet[addr].s = {
      font: { bold: true },
      alignment: { horizontal: 'center', vertical: 'center' },
    };
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, QR_DATA_XLSX_SHEET_NAME);

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return { buffer, fileName: buildQrDataFileName(po) };
}

/** Escape LIKE wildcards so a PO value can be used in ilike safely. */
function escapeLike(value) {
  return String(value ?? '').replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

/**
 * Build a fetcher (around any supabase-like client) that returns the
 * raw data_updates rows for ONE PO, ordered oldest-first. The ilike
 * filter narrows by the encoded PO segment, then every row is
 * re-verified by parsing qr_code so the returned list is exact.
 * Never throws - returns [] when the table is unreachable.
 */
export function createPoQrDataFetcher(supabaseClient) {
  return async function fetchPoRawQrData(po) {
    const poValue = String(po ?? '').trim();
    if (!poValue) return [];
    try {
      const { data, error } = await supabaseClient
        .from(DATA_UPDATES_TABLE)
        .select(
          'qr_code, inner_qr, record_status, qc_status, department, count, created_by, created_at'
        )
        .ilike('qr_code', `%;${escapeLike(poValue)};%`)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data || []).filter((row) => {
        const parsed = parseOrgQr(row?.qr_code);
        return parsed.po != null && String(parsed.po).trim() === poValue;
      });
    } catch {
      /* data_updates missing / RLS / offline - empty list */
      return [];
    }
  };
}

/** Real PO raw-QR fetcher bound to the app's Supabase singleton. */
export const fetchPoRawQrData = createPoQrDataFetcher(supabase);

/* ==================================================================
 * DAILY OUTPUT REPORT (department + date + size-35-50 matrix)
 * ================================================================== */

/** Sri Lanka Standard Time offset: UTC+5:30 (fixed - Sri Lanka observes no DST). */
const SLST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * Compute the UTC time window for one Sri Lanka calendar day.
 *
 * Supabase's JS client cannot push a raw
 *   `(created_at AT TIME ZONE 'Asia/Colombo')::date = $1::date`
 * expression, so the equivalent - and exact - server-side filter is applied
 * here: a `created_at` row belongs to SLST date `target` iff its UTC instant
 * falls in [start, end), where `start` is SLST-midnight of `target` in UTC.
 *
 *   daily window (== target): created_at >= start AND created_at < end
 *   cumulative (<=  target): created_at < end   (all history up to day-end)
 *
 * @param {string} date 'YYYY-MM-DD' SLST calendar date (e.g. '2026-09-04')
 * @returns {{ start: string, end: string }} ISO (UTC) window bounds
 */
export function slstDayUtcBounds(date) {
  const ymd = String(date || '').slice(0, 10);
  const [y, m, d] = ymd.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d) || m < 1 || m > 12 || d < 1 || d > 31) {
    throw new Error(`Invalid SLST date for daily output report: ${date}`);
  }
  const slstMidnightUtcMs = Date.UTC(y, m - 1, d) - SLST_OFFSET_MS;
  const endMs = slstMidnightUtcMs + 24 * 60 * 60 * 1000;
  return {
    start: new Date(slstMidnightUtcMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

/**
 * Normalize a QC status filter selection into a list of CONCRETE statuses.
 *
 * Accepts either the multi-select array (`qcStatuses`, e.g.
 * ['Forward', 'Return']) and/or the legacy single string (`qcStatus`, e.g.
 * 'B Grade' | 'ALL'). The array wins when both are given. 'ALL', blanks and
 * unknown values are dropped; an empty result means "no filter" (ALL).
 *
 * The old 'Standard' option was RENAMED to 'Forward': Forward is a real
 * stored qc_status, so it filters by equality like every other status
 * ('Standard' itself is no longer a valid selection and is dropped).
 *
 * @param {object} [params]
 * @param {string[]|null} [params.qcStatuses] selected concrete statuses
 * @param {string|null} [params.qcStatus] legacy single selection
 * @returns {string[]} concrete qc_status list; [] = ALL (no qc filter)
 */
export function normalizeQcStatuses({ qcStatus, qcStatuses } = {}) {
  let raw;
  if (Array.isArray(qcStatuses)) raw = qcStatuses;
  else if (qcStatus != null) raw = [qcStatus];
  else raw = ['ALL'];
  const cleaned = [
    ...new Set(raw.map((s) => String(s ?? '').trim()).filter(Boolean)),
  ];
  if (cleaned.length === 0 || cleaned.includes('ALL')) return [];
  return cleaned.filter((status) => DAILY_OUTPUT_QC_STATUSES.includes(status));
}

/**
 * Build a Daily Output fetcher around any supabase-like client.
 *
 * Returns the raw data_updates rows for one department on/by the SLST date
 * window, with record_status / qc_status filters applied server-side.
 *
 * `cumulative`: when false (daily, the default) rows are restricted to the
 * single SLST calendar day; when true rows span all history up to (and
 * including) the end of that day = the cumulative net output.
 *
 * QC filter: `qcStatuses` is the multi-select list (one status -> eq, many
 * statuses -> in, empty/['ALL'] -> no qc filter); the legacy single
 * `qcStatus` string is still accepted.
 *
 * @param {object} supabaseClient supabase-js-like client (injectable for tests)
 * @returns {(params: { date: string, departmentId?: string, recordStatus?: string,
 *            qcStatus?: string, qcStatuses?: string[], cumulative?: boolean }) => Promise<object[]>}
 */
export function createDailyOutputFetcher(supabaseClient) {
  return async function fetchDailyOutputRows({
    date,
    departmentId,
    recordStatus = 'ALL',
    qcStatus = 'ALL',
    qcStatuses = null,
    cumulative = false,
    columns = DAILY_OUTPUT_COLUMNS,
  }) {
    const { start, end } = slstDayUtcBounds(date);

    let query = supabaseClient
      .from(DATA_UPDATES_TABLE)
      .select(columns)
      .order('created_at', { ascending: true });

    if (departmentId) {
      query = query.eq(DAILY_OUTPUT_DEPARTMENT_COLUMN, departmentId);
    }
    // Date window (the SLST filter). Daily = [start, end); cumulative = < end.
    if (!cumulative) query = query.gte('created_at', start);
    query = query.lt('created_at', end);

    // record_status: 'IN' | 'OUT' | 'ALL'.
    if (recordStatus === 'IN' || recordStatus === 'OUT') {
      query = query.eq('record_status', recordStatus);
    }
    // qc_status multi-select: one status -> eq, several -> in, [] = ALL.
    const qcList = normalizeQcStatuses({ qcStatus, qcStatuses });
    if (qcList.length === 1) {
      query = query.eq('qc_status', qcList[0]);
    } else if (qcList.length > 1) {
      query = query.in('qc_status', qcList);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  };
}

/** Fresh zeroed size bucket for one PO: keys '35'..'50' all starting at 0. */
function emptySizeBucket() {
  const bucket = {};
  for (const size of STANDARD_SIZES) bucket[size] = 0;
  return bucket;
}

/**
 * Pure: aggregate raw data_updates rows into the Daily Output matrix.
 *
 * Each row's PO and shoe size are parsed from `qr_code`; cells outside 35-50
 * are ignored. Each cell holds SUM(count) (net units: 1 per scan, -1 Returns).
 * `daily` rows feed the per-size Daily Total; `cumulative` rows feed the
 * Cumulative Output column.
 *
 * STATUS ROWS (PDF grid): `options.statuses` is the selected concrete QC
 * status list ([] = ALL). Every PO block carries one status row per selected
 * status (ALL = DAILY_OUTPUT_QC_STATUSES) plus an extra "(No QC)" row only
 * when that PO has daily rows with a blank/unknown qc_status, so the block's
 * Sub Total always equals the PO's full daily output.
 *
 * @returns {{ sizes: string[], rows: Array<{po: string, sizes: object,
 *            dailyTotal: number, cumulativeOutput: number}>,
 *            statusBlocks: Array<{po: string,
 *              statuses: Array<{status: string, sizes: object, total: number}>,
 *              subTotal: { sizes: object, total: number },
 *              cumulativeOutput: number}>,
 *            summary: { sizes: object, dailyTotal: number, cumulativeOutput: number } }}
 * @param {object[]} dailyRows      rows for the selected SLST day
 * @param {object[]} cumulativeRows rows up to & including the selected day
 * @param {string[]} [sizes]        fixed size axis (defaults to STANDARD_SIZES)
 * @param {object} [options]
 * @param {string[]} [options.statuses] selected QC statuses ([] = ALL)
 */
export function aggregateDailyOutput(dailyRows, cumulativeRows, sizes = STANDARD_SIZES, options = {}) {
  const sizeList = sizes || STANDARD_SIZES;
  const sizeSet = new Set(sizeList);
  const selectedStatuses = Array.isArray(options?.statuses) ? options.statuses : [];
  const baseStatuses = selectedStatuses.length
    ? selectedStatuses
    : DAILY_OUTPUT_QC_STATUSES;
  const dailyByPo = {};
  const cumulativeByPo = {};
  // Per-PO-per-status daily buckets + the extra (non-selected) statuses that
  // actually occur, so Sub Totals can never miss a row.
  const dailyByPoStatus = {};
  const poStatusLabels = {};

  const ingest = (rows, target) => {
    for (const row of rows || []) {
      const parsed = parseOrgQr(row?.qr_code);
      const po = parsed?.po != null ? String(parsed.po).trim() : '';
      if (!po) continue;
      const size = normalizeSizeValue(parsed?.size);
      if (!sizeSet.has(size)) continue;
      const units = Number.isFinite(Number(row?.count)) ? Number(row.count) : 0;
      if (!target[po]) target[po] = emptySizeBucket();
      target[po][size] += units;
    }
  };

  // Status-aware ingest: buckets every daily row by its (normalized) QC
  // status label - blank/unknown values collapse to "(No QC)".
  const ingestByStatus = (rows) => {
    for (const row of rows || []) {
      const parsed = parseOrgQr(row?.qr_code);
      const po = parsed?.po != null ? String(parsed.po).trim() : '';
      if (!po) continue;
      const size = normalizeSizeValue(parsed?.size);
      if (!sizeSet.has(size)) continue;
      const units = Number.isFinite(Number(row?.count)) ? Number(row.count) : 0;
      const statusLabel =
        String(row?.qc_status ?? '').trim() || DAILY_OUTPUT_NO_QC_LABEL;
      if (!dailyByPoStatus[po]) dailyByPoStatus[po] = {};
      if (!dailyByPoStatus[po][statusLabel]) {
        dailyByPoStatus[po][statusLabel] = emptySizeBucket();
      }
      dailyByPoStatus[po][statusLabel][size] += units;
      if (!poStatusLabels[po]) poStatusLabels[po] = new Set();
      poStatusLabels[po].add(statusLabel);
    }
  };

  ingest(dailyRows, dailyByPo);
  ingest(cumulativeRows, cumulativeByPo);
  ingestByStatus(dailyRows);

  const rows = Object.keys(dailyByPo)
    .sort()
    .map((po) => {
      const daily = dailyByPo[po] || emptySizeBucket();
      const cumulative = cumulativeByPo[po] || emptySizeBucket();
      const dailyTotal = sizeList.reduce((sum, s) => sum + (daily[s] || 0), 0);
      const cumulativeOutput = sizeList.reduce(
        (sum, s) => sum + (cumulative[s] || 0),
        0
      );
      const sizesMap = {};
      for (const s of sizeList) sizesMap[s] = daily[s] || 0;
      return { po, sizes: sizesMap, dailyTotal, cumulativeOutput };
    });

  // Status blocks: one row per selected status per PO + a highlighted
  // Sub Total row summing the block (see the PDF layout).
  const statusBlocks = rows.map((row) => {
    const present = poStatusLabels[row.po] || new Set();
    const extras = [...present]
      .filter((label) => !baseStatuses.includes(label))
      .sort();
    const blockStatuses = [...baseStatuses, ...extras].map((status) => {
      const bucket = dailyByPoStatus[row.po]?.[status] || emptySizeBucket();
      const statusSizes = {};
      let total = 0;
      for (const s of sizeList) {
        statusSizes[s] = bucket[s] || 0;
        total += statusSizes[s];
      }
      return { status, sizes: statusSizes, total };
    });
    // Strictly filter out status rows that contain zero quantities or no data:
    // keep only rows where at least one size column is actively populated (non-zero).
    const populatedStatuses = blockStatuses.filter((s) =>
      Object.values(s.sizes).some((qty) => qty !== 0)
    );
    const subSizes = {};
    let subTotal = 0;
    for (const s of sizeList) {
      subSizes[s] = populatedStatuses.reduce((sum, st) => sum + (st.sizes[s] || 0), 0);
      subTotal += subSizes[s];
    }
    return {
      po: row.po,
      statuses: populatedStatuses,
      subTotal: { sizes: subSizes, total: subTotal },
      cumulativeOutput: row.cumulativeOutput,
    };
  });

  const summary = { sizes: {}, dailyTotal: 0, cumulativeOutput: 0 };
  for (const s of sizeList) {
    const colSum = rows.reduce((sum, r) => sum + (r.sizes[s] || 0), 0);
    summary.sizes[s] = colSum;
    summary.dailyTotal += colSum;
  }
  summary.cumulativeOutput = rows.reduce(
    (sum, r) => sum + (r.cumulativeOutput || 0),
    0
  );

  return { sizes: sizeList, rows, statusBlocks, summary };
}

/** Daily Output fetcher bound to the app's Supabase singleton. */
const fetchDailyOutputRows = createDailyOutputFetcher(supabase);

/**
 * Fetch the complete Daily Output Report for one department on a date.
 *
 * Issues two parameterised queries against `data_updates`:
 *   1. DAILY   - rows in the single SLST calendar day window [start, end)
 *   2. CUMULATIVE - all rows up to (and including) that day (< end)
 * Both share the department / record_status / qc_status filters. The two
 * row sets are then aggregated into the size-35-50 matrix, including the
 * per-PO QC status blocks (one status row per selected status) for the PDF.
 *
 * @param {object} params
 * @param {string} [params.departmentId] department name (data_updates.department)
 * @param {string} params.date           'YYYY-MM-DD' SLST calendar date
 * @param {string} [params.recordStatus] 'ALL' | 'IN' | 'OUT'
 * @param {string} [params.qcStatus]     legacy single selection: 'ALL' | 'Forward' | 'B Grade' | 'C Grade' | 'Lab Testing' | 'Return' | 'Reworked'
 * @param {string[]} [params.qcStatuses] multi-select QC statuses (overrides qcStatus; [] / ['ALL'] = ALL)
 * @returns {Promise<{ sizes: string[], rows: object[], statusBlocks: object[], summary: object }>}
 */
export async function fetchDailyOutputReport({
  departmentId,
  date,
  recordStatus = 'ALL',
  qcStatus = 'ALL',
  qcStatuses = null,
}) {
  if (!date) {
    throw new Error('A date (YYYY-MM-DD, SLST) is required for the Daily Output Report.');
  }
  const qcList = normalizeQcStatuses({ qcStatus, qcStatuses });
  const [dailyRows, cumulativeRows] = await Promise.all([
    fetchDailyOutputRows({ date, departmentId, recordStatus, qcStatuses: qcList, cumulative: false }),
    fetchDailyOutputRows({ date, departmentId, recordStatus, qcStatuses: qcList, cumulative: true }),
  ]);
  return aggregateDailyOutput(dailyRows, cumulativeRows, STANDARD_SIZES, {
    statuses: qcList,
  });
}

/**
 * Build a native .xlsx binary buffer for the Daily Output matrix.
 *
 * Layout (SheetJS): a report title + active-filters banner, then a table with
 * columns [PO Number, 35, 36, ..., 50, Daily Total, Cumulative Output] - one
 * row per PO (sorted) - plus a footer row summing every column. SheetJS is
 * loaded lazily so the (large) library is only fetched on export.
 *
 * @param {object} matrixData  output of fetchDailyOutputReport / aggregateDailyOutput
 * @param {object} [filters]   { departmentId, date, recordStatus, qcStatus }
 * @returns {Promise<{ buffer: Buffer|Uint8Array, fileName: string }>}
 */
export async function buildDailyOutputXlsx(matrixData, filters = {}) {
  const XLSX = await import('xlsx');
  const {
    date,
    departmentId = 'All Departments',
    recordStatus = 'ALL',
    qcStatus = 'ALL',
  } = filters;

  const sizeList = (matrixData && matrixData.sizes) || STANDARD_SIZES;
  const rows = (matrixData && matrixData.rows) || [];
  const summary =
    (matrixData && matrixData.summary) ||
    { sizes: {}, dailyTotal: 0, cumulativeOutput: 0 };

  const headers = ['PO Number', ...sizeList, 'Daily Total', 'Cumulative Output'];
  const aoa = [];

  // Banner with the active filters.
  aoa.push(['DAILY OUTPUT REPORT']);
  aoa.push([
    'Department', departmentId,
    'Date (SLST)', date || '',
    'Record Status', recordStatus,
    'QC Status', qcStatus,
  ]);
  aoa.push([]);
  aoa.push(headers);

  // Data rows.
  for (const row of rows) {
    aoa.push([
      row.po,
      ...sizeList.map((s) => row.sizes[s] || 0),
      row.dailyTotal,
      row.cumulativeOutput,
    ]);
  }

  // Summary footer row (column sums + grand totals).
  aoa.push([
    'TOTAL',
    ...sizeList.map((s) => summary.sizes[s] || 0),
    summary.dailyTotal,
    summary.cumulativeOutput,
  ]);

  const sheet = XLSX.utils.aoa_to_sheet(aoa);

  // Column widths: wide for PO Number, narrow for the 16 size columns.
  sheet['!cols'] = [
    { wch: 18 }, // PO Number
    ...sizeList.map(() => ({ wch: 8 })), // sizes 35..50
    { wch: 14 }, // Daily Total
    { wch: 18 }, // Cumulative Output
  ];

  // Bold + centered header row (row index 3: title/banner/blank/header).
  for (let c = 0; c < headers.length; c += 1) {
    const address = XLSX.utils.encode_cell({ r: 3, c });
    if (!sheet[address]) continue;
    sheet[address].s = {
      font: { bold: true },
      alignment: { horizontal: 'center', vertical: 'center' },
    };
  }

  // Bold the footer label cell ('TOTAL').
  const footerLabel = XLSX.utils.encode_cell({ r: 4 + rows.length, c: 0 });
  if (sheet[footerLabel]) {
    sheet[footerLabel].s = { font: { bold: true } };
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Daily Output');

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const fileName = `Daily_Output_Report_${date || formatSlstDate(new Date())}.xlsx`;
  return { buffer, fileName };
}

/**
 * Fetch the exact raw `data_updates` records behind the Daily Output matrix.
 *
 * Uses the same SLST-day window and filters as the aggregation, but selects
 * the full raw column set (id, qr_code, record_status, qc_status, created_at,
 * department, count, created_by, inner_qr) for the raw Excel export.
 *
 * @param {object} params { departmentId?, date, recordStatus?, qcStatus?, qcStatuses? }
 * @returns {Promise<object[]>} raw rows, ordered by created_at ascending
 */
export function fetchDailyOutputRawRows({
  departmentId,
  date,
  recordStatus = 'ALL',
  qcStatus = 'ALL',
  qcStatuses = null,
}) {
  return fetchDailyOutputRows({
    date,
    departmentId,
    recordStatus,
    qcStatus,
    qcStatuses,
    cumulative: false,
    columns: DAILY_OUTPUT_RAW_COLUMNS,
  });
}

/**
 * Build a native .xlsx workbook of the raw scan records behind the Daily
 * Output matrix. `created_at` values are converted from UTC to Sri Lanka
 * Standard Time (SLST, UTC+5:30) before being written, rendered as
 * 'YYYY-MM-DD HH:mm:ss' text so Excel shows the exact local timestamp.
 *
 * @param {object[]} rawRows rows from fetchDailyOutputRawRows
 * @param {object} [filters] { departmentId, date, recordStatus, qcStatus }
 * @returns {Promise<{ buffer: Buffer|Uint8Array, fileName: string }>}
 */
export async function buildDailyOutputRawXlsx(rawRows, filters = {}) {
  const XLSX = await import('xlsx');
  const {
    date,
    departmentId = 'All Departments',
    recordStatus = 'ALL',
    qcStatus = 'ALL',
  } = filters;

  const headers = [
    'ID',
    'QR Code',
    'Record Status',
    'QC Status',
    'Created At (SLST)',
    'Department',
    'Count',
    'Created By',
    'Inner QR',
  ];
  const aoa = [];

  // Banner with the active filters.
  aoa.push(['DAILY OUTPUT - RAW DATA']);
  aoa.push([
    'Department', departmentId,
    'Date (SLST)', date || '',
    'Record Status', recordStatus,
    'QC Status', qcStatus,
  ]);
  aoa.push([]);
  aoa.push(headers);

  // One row per raw scan record, timestamps converted UTC -> SLST.
  for (const row of rawRows || []) {
    aoa.push([
      row?.id ?? '',
      row?.qr_code ?? '',
      row?.record_status ?? '',
      row?.qc_status ?? '',
      formatSlstTimestamp(row?.created_at),
      row?.department ?? '',
      row?.count ?? '',
      row?.created_by ?? '',
      row?.inner_qr ?? '',
    ]);
  }

  const sheet = XLSX.utils.aoa_to_sheet(aoa);

  // Column widths tuned per raw field.
  sheet['!cols'] = [
    { wch: 8 },   // ID
    { wch: 26 },  // QR Code
    { wch: 14 },  // Record Status
    { wch: 14 },  // QC Status
    { wch: 20 },  // Created At (SLST)
    { wch: 16 },  // Department
    { wch: 8 },   // Count
    { wch: 14 },  // Created By
    { wch: 26 },  // Inner QR
  ];

  // Bold + centered header row (row index 3: title/banner/blank/header).
  for (let c = 0; c < headers.length; c += 1) {
    const address = XLSX.utils.encode_cell({ r: 3, c });
    if (!sheet[address]) continue;
    sheet[address].s = {
      font: { bold: true },
      alignment: { horizontal: 'center', vertical: 'center' },
    };
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Raw Data');

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const fileName = `Daily_Output_Raw_Data_${date || formatSlstDate(new Date())}.xlsx`;
  return { buffer, fileName };
}

