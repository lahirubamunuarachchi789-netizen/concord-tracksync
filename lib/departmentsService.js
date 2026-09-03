import { supabase } from './supabaseClient.js';

/**
 * Data access for the `departments` mapping table
 * (id, department, sequence - see supabase/departments-schema.sql).
 *
 * The sign-up flow uses these helpers to populate the Department
 * dropdown with the EXACT department strings stored in Supabase, so the
 * value saved into "Loging Table".Department always matches the
 * departments table (same casing, same format) - which the standard
 * transaction sequence guards rely on.
 */

export const DEPARTMENTS_TABLE = 'departments';

/** Friendly, non-technical message for a failed departments fetch. */
function describeDepartmentsError(error) {
  const raw = error?.message || '';
  if (/row-level security|permission denied/i.test(raw)) {
    return 'Department list is blocked by Row Level Security.';
  }
  if (/relation|does not exist|schema cache/i.test(raw)) {
    return 'Departments table not found (run supabase/departments-schema.sql).';
  }
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return 'Network unavailable while loading departments.';
  }
  if (/invalid api key|jwt/i.test(raw)) {
    return 'Supabase rejected the API key.';
  }
  return 'Could not load the department list.';
}

/**
 * Pure: map raw rows ({ department }) or plain strings into clean
 * dropdown options. Values keep the EXACT casing/format stored in the
 * table - only null/blank entries are dropped and exact duplicates
 * are collapsed.
 * @param {Array<{department?: string}|string>} rows
 * @returns {string[]}
 */
export function normalizeDepartmentOptions(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const options = [];
  for (const row of rows) {
    const raw = typeof row === 'string' ? row : row?.department;
    if (raw == null) continue;
    const value = String(raw);
    if (!value.trim() || seen.has(value)) continue;
    seen.add(value);
    options.push(value);
  }
  return options;
}

/**
 * Build a departments fetcher around any supabase-like client, so the
 * query shape is unit-testable with a mock. Runs exactly:
 *   SELECT department FROM departments
 *   ORDER BY sequence ASC, department ASC
 * Resolves with { ok: true, departments } on success, or
 * { ok: false, message, departments: [] } - it NEVER throws, so the
 * registration form can always fall back to manual typing.
 * @param {object} supabaseClient a @supabase/supabase-js client
 */
export function createDepartmentsFetcher(supabaseClient) {
  return async function fetchDepartments() {
    try {
      const { data, error } = await supabaseClient
        .from(DEPARTMENTS_TABLE)
        .select('department')
        .order('sequence', { ascending: true })
        .order('department', { ascending: true });
      if (error) throw error;
      return { ok: true, departments: normalizeDepartmentOptions(data) };
    } catch (error) {
      return {
        ok: false,
        message: describeDepartmentsError(error),
        departments: [],
      };
    }
  };
}

/** Real fetcher bound to the app's Supabase singleton. */
export const fetchDepartmentOptions = createDepartmentsFetcher(supabase);