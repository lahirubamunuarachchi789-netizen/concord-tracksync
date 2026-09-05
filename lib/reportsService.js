'use client';

// Concord TrackSync - Reports service - PO Summary aggregation

import { supabase } from './supabaseClient.js';
import { parseOrgQr, normalizeSizeValue } from './transactionDualScan.js';

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
 * QR DATA EXPORT (Excel/CSV)
 * Timestamps are converted from UTC to Sri Lanka Local Time
 * (Asia/Colombo, UTC+5:30) and formatted YYYY-MM-DD HH:mm:ss.
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
 * Export file name: `PO_{po}_QR_Data_{YYYY-MM-DD}.csv` where the
 * date is today's date in Sri Lanka Local Time.
 * @param {string} po target PO value
 * @returns {string}
 */
export function buildQrDataFileName(po) {
  const date = formatSlstDate(new Date());
  return `PO_${String(po ?? '').trim()}_QR_Data_${date}.csv`;
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
