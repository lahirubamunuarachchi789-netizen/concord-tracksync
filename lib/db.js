// Concord TrackSync - DB access wrapper (data-access layer).
//
// This module is the SINGLE place that owns the project's database client.
// Report / service modules import `supabase` from here (and any shared
// data-access constants) instead of instantiating a postgres client themselves
// or hardcoding a connection string.
//
// The underlying client is the existing Supabase singleton from
// `supabaseClient.js`, which is itself configured entirely from environment
// variables (`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`) with
// publishable fallbacks only - never a secret connection string.
import { supabase } from './supabaseClient.js';

export { supabase };

// Canonical Supabase table names (shared by the reports layer).
export const DATA_UPDATES_TABLE = 'data_updates';
export const DEPARTMENTS_TABLE = 'departments';
export const POD_TABLE = 'pod';

// Columns pulled for the Daily Output matrix.
// PO and shoe size are NOT stored as columns on data_updates - they are
// encoded inside the org_qr `qr_code` (";mqc;po;size;scanned;") and parsed
// in reportsService. `count` is the net units column (1 per scan, -1 for
// Returns), so SUM(count) is the net output per (PO, size) cell.
export const DAILY_OUTPUT_COLUMNS =
  'qr_code,count,record_status,qc_status,created_at,department';

// Columns pulled for the RAW Daily Output Excel export: the exact stored
// records behind the matrix, including the audit fields (id, created_by)
// and the encoded inner QR.
export const DAILY_OUTPUT_RAW_COLUMNS =
  'id,qr_code,record_status,qc_status,created_at,department,count,created_by,inner_qr';

// Department filter is applied to `data_updates.department`, which stores the
// department NAME (matching the `departments.department` column), not its id.
export const DAILY_OUTPUT_DEPARTMENT_COLUMN = 'department';

// UI filter option sets for the Daily Output control bar.
export const DAILY_OUTPUT_RECORD_OPTIONS = ['ALL', 'IN', 'OUT'];
// QC status filter options: 'ALL' + every concrete qc_status written by the
// transaction flows ('Standard' was renamed to 'Forward' - Forward is a real
// stored status, not a negation - and 'Return' / 'Reworked' were added).
export const DAILY_OUTPUT_QC_OPTIONS = [
  'ALL',
  'Forward',
  'B Grade',
  'C Grade',
  'Lab Testing',
  'Return',
  'Reworked',
];

// The concrete QC statuses behind the options list (everything except the
// 'ALL' pseudo-option). The Daily Output aggregation renders one status row
// per selected status in the PDF grid, and this is the list used when ALL
// is selected.
export const DAILY_OUTPUT_QC_STATUSES = DAILY_OUTPUT_QC_OPTIONS.filter(
  (option) => option !== 'ALL'
);

// QC statuses that are not one of the six concrete statuses above (null /
// blank / legacy values). The Daily Output PDF renders an extra "(No QC)"
// status row for them so every scan stays accounted for in the Sub Totals.
export const DAILY_OUTPUT_NO_QC_LABEL = '(No QC)';

// QC statuses that are not one of the six concrete statuses above (null /
// blank / legacy values) - tracked for consumers of the defect-category
// concept (e.g. the Live Dashboard validity rules and OUT-count exclusions).
export const QC_DEFECT_CATEGORIES = ['B Grade', 'C Grade', 'Lab Testing'];

// Live Dashboard: per-department daily plan / efficiency / manpower table.
export const DASH_TABLE = 'dash';
export const DASH_COLUMNS =
  'department,date,planed_qty,eficiancy,available_man_power';

// Live Dashboard: the day's planned working hours per department (e.g. 9.5).
// Read through a dedicated TOLERANT fetcher (not part of DASH_COLUMNS) so a
// live `dash` table that has not received the planed_hour migration yet can
// never break the whole dashboard fetch - the time-based GPS target marker
// degrades to the shift-window fallback instead.
export const DASH_PLANED_HOUR_COLUMN = 'planed_hour';

// Live Dashboard: data_updates columns needed for the hourly/weekly output
// aggregation (valid scans only - qc_status decides validity, created_at is
// bucketed into the 10 SLST shift hours / week days).
export const DASH_SCAN_COLUMNS = 'created_at,count,qc_status';
