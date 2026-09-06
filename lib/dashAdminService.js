// Concord TrackSync - Data Admin service layer.
//
// CRUD helpers for the Live Dashboard `dash` table (per-department daily
// plan / efficiency / manpower). Isomorphic + injectable client for tests.

import { supabase, DASH_TABLE } from './db.js';
import { formatSlstDate } from './reportsService.js';

/** Fields managed by the Data Admin form. */
export const DASH_FORM_FIELDS = [
  'date',
  'department',
  'planed_qty',
  'eficiancy',
  'available_man_power',
];

/** Normalize a raw `dash` row for display in the management table. */
export function normalizeDashRow(row) {
  return {
    id: row?.id ?? null,
    date: String(row?.date ?? '').slice(0, 10),
    department: String(row?.department ?? ''),
    planed_qty: Number(row?.planed_qty) || 0,
    eficiancy: row?.eficiancy == null ? null : Number(row.eficiancy),
    available_man_power: Number(row?.available_man_power) || 0,
  };
}

/** Validate form input; returns { ok, errors, values }. */
export function validateDashForm(input) {
  const errors = {};
  const department = String(input?.department ?? '').trim();
  const date = String(input?.date ?? '').slice(0, 10);
  const planedQty = Number(input?.planed_qty);
  const efficiency = input?.eficiancy === '' || input?.eficiancy == null ? 0 : Number(input.eficiancy);
  const manPower = Number(input?.available_man_power);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.date = 'A valid date is required.';
  if (!department) errors.department = 'Department is required.';
  if (!Number.isFinite(planedQty) || planedQty < 0)
    errors.planed_qty = 'Planned qty must be a number >= 0.';
  if (!Number.isFinite(efficiency) || efficiency < 0 || efficiency > 100)
    errors.eficiancy = 'Efficiency must be between 0 and 100.';
  if (!Number.isFinite(manPower) || manPower < 0 || !Number.isInteger(manPower))
    errors.available_man_power = 'Man power must be a whole number >= 0.';

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    values: {
      date,
      department,
      planed_qty: Math.floor(planedQty),
      eficiancy: efficiency,
      available_man_power: manPower,
    },
  };
}

/** Build an upsert (insert-or-update on department+date conflict) helper. */
export function createDashUpsert(supabaseClient) {
  return async function upsertDashRow(values) {
    const { data, error } = await supabaseClient
      .from(DASH_TABLE)
      .upsert(
        {
          date: values.date,
          department: values.department,
          planed_qty: values.planed_qty,
          eficiancy: values.eficiancy,
          available_man_power: values.available_man_power,
        },
        { onConflict: 'department,date' }
      )
      .select()
      .single();
    if (error) throw error;
    return normalizeDashRow(data);
  };
}

/** Build a fetcher for existing `dash` rows, newest date first. */
export function createDashRowsFetcher(supabaseClient) {
  return async function fetchDashRows({ date } = {}) {
    let query = supabaseClient
      .from(DASH_TABLE)
      .select('id,department,date,planed_qty,eficiancy,available_man_power')
      .order('date', { ascending: false })
      .order('department', { ascending: true })
      .limit(200);
    if (date) query = query.eq('date', date);
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(normalizeDashRow);
  };
}

/** Build a delete helper for one row id. */
export function createDashRowDeleter(supabaseClient) {
  return async function deleteDashRow(id) {
    const { error } = await supabaseClient.from(DASH_TABLE).delete().eq('id', id);
    if (error) throw error;
    return true;
  };
}

/** Singleton helpers bound to the shared Supabase client. */
export const upsertDashRow = createDashUpsert(supabase);
export const fetchDashRows = createDashRowsFetcher(supabase);
export const deleteDashRow = createDashRowDeleter(supabase);

/** Default form date = today in SLST. */
export function defaultFormDate() {
  return formatSlstDate(new Date());
}
