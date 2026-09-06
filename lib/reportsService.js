'use client';

// Concord TrackSync - Reports service - PO Summary aggregation

import {
  supabase,
  DAILY_OUTPUT_COLUMNS,
  DAILY_OUTPUT_DEPARTMENT_COLUMN,
  DAILY_OUTPUT_RECORD_OPTIONS,
  DAILY_OUTPUT_QC_OPTIONS,
  QC_DEFECT_CATEGORIES,
} from './db.js';

import { parseOrgQr, normalizeSizeValue } from './transactionDualScan.js';

// Re-export the Daily Output column/department constants and the QC defect
// category set so report consumers (and tests) import everything from the
// service layer instead of reaching into the DB wrapper directly.
export { DAILY_OUTPUT_COLUMNS, DAILY_OUTPUT_DEPARTMENT_COLUMN, QC_DEFECT_CATEGORIES } from './db.js';

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
  return { in: 0, out: 0, bGrade: 0, cGrade: 0, labTesting: 0, outTotal: 0 };
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
 *   bGrade     - rows with qc_status 'B Grade'
 *   cGrade     - rows with qc_status 'C Grade'
 *   labTesting - rows with qc_status 'Lab Testing'
 *   outTotal   - SUM of count for ALL rows (every record_status and
 *                qc_status), i.e. the net total output for the cell.
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

    // Out Total: net sum of count across ALL rows for this cell.
    m.outTotal += count;

    if (recordStatus === 'IN') m.in += 1;
    // OUT count: only standard PASS/Good records (exclude QC categories).
    if (recordStatus === 'OUT' && !isQcExcludedFromOut(qcStatus)) m.out += 1;
    if (qcStatus === 'B Grade') m.bGrade += 1;
    if (qcStatus === 'C Grade') m.cGrade += 1;
    if (qcStatus === 'Lab Testing') m.labTesting += 1;
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
      bGrade: totalMetrics.bGrade,
      cGrade: totalMetrics.cGrade,
      labTesting: totalMetrics.labTesting,
      outTotal: totalMetrics.outTotal,
      balanceToCut: totalCutQty - totalMetrics.outTotal,
    };

    rows.push({
      type: 'department',
      name: deptName,
      sequence: dept.sequence,
      metrics,
    });
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
 * Build a Daily Output fetcher around any supabase-like client.
 *
 * Returns the raw data_updates rows for one department on/by the SLST date
 * window, with record_status / qc_status filters applied server-side.
 *
 * `cumulative`: when false (daily, the default) rows are restricted to the
 * single SLST calendar day; when true rows span all history up to (and
 * including) the end of that day = the cumulative net output.
 *
 * @param {object} supabaseClient supabase-js-like client (injectable for tests)
 * @returns {(params: { date: string, departmentId?: string, recordStatus?: string,
 *            qcStatus?: string, cumulative?: boolean }) => Promise<object[]>}
 */
export function createDailyOutputFetcher(supabaseClient) {
  return async function fetchDailyOutputRows({
    date,
    departmentId,
    recordStatus = 'ALL',
    qcStatus = 'ALL',
    cumulative = false,
  }) {
    const { start, end } = slstDayUtcBounds(date);

    let query = supabaseClient
      .from(DATA_UPDATES_TABLE)
      .select(DAILY_OUTPUT_COLUMNS)
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
    // qc_status: defect category | 'Standard' (= NOT a defect) | 'ALL'.
    if (qcStatus === 'Standard') {
      query = query.not('qc_status', 'in', QC_DEFECT_CATEGORIES);
    } else if (qcStatus !== 'ALL' && DAILY_OUTPUT_QC_OPTIONS.includes(qcStatus)) {
      query = query.eq('qc_status', qcStatus);
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
 * @returns {{ sizes: string[], rows: Array<{po: string, sizes: object,
 *            dailyTotal: number, cumulativeOutput: number}>,
 *            summary: { sizes: object, dailyTotal: number, cumulativeOutput: number } }}
 * @param {object[]} dailyRows      rows for the selected SLST day
 * @param {object[]} cumulativeRows rows up to & including the selected day
 * @param {string[]} [sizes]        fixed size axis (defaults to STANDARD_SIZES)
 */
export function aggregateDailyOutput(dailyRows, cumulativeRows, sizes = STANDARD_SIZES) {
  const sizeList = sizes || STANDARD_SIZES;
  const sizeSet = new Set(sizeList);
  const dailyByPo = {};
  const cumulativeByPo = {};

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

  ingest(dailyRows, dailyByPo);
  ingest(cumulativeRows, cumulativeByPo);

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

  return { sizes: sizeList, rows, summary };
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
 * row sets are then aggregated into the size-35-50 matrix.
 *
 * @param {object} params
 * @param {string} [params.departmentId] department name (data_updates.department)
 * @param {string} params.date           'YYYY-MM-DD' SLST calendar date
 * @param {string} [params.recordStatus] 'ALL' | 'IN' | 'OUT'
 * @param {string} [params.qcStatus]     'ALL' | 'Standard' | 'B Grade' | 'C Grade' | 'Lab Testing'
 * @returns {Promise<{ sizes: string[], rows: object[], summary: object }>}
 */
export async function fetchDailyOutputReport({
  departmentId,
  date,
  recordStatus = 'ALL',
  qcStatus = 'ALL',
}) {
  if (!date) {
    throw new Error('A date (YYYY-MM-DD, SLST) is required for the Daily Output Report.');
  }
  const [dailyRows, cumulativeRows] = await Promise.all([
    fetchDailyOutputRows({ date, departmentId, recordStatus, qcStatus, cumulative: false }),
    fetchDailyOutputRows({ date, departmentId, recordStatus, qcStatus, cumulative: true }),
  ]);
  return aggregateDailyOutput(dailyRows, cumulativeRows);
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
