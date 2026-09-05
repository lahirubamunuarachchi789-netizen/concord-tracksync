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
