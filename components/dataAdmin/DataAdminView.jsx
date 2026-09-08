'use client';

// Concord TrackSync - Data Admin view.
// Manage the Live Dashboard `dash` table: insert/update per-department
// daily plan, efficiency and manpower, with a live management table below.
// Validation failures and blocked/failed database writes are surfaced as
// a CENTERED MODAL (not a corner toast) via ErrorModal.

import { useCallback, useEffect, useState } from 'react';
import { AlertCircleIcon, CheckCircleIcon, SpinnerIcon } from '@/components/icons';
import ErrorModal from '@/components/ErrorModal';
import { fetchDepartmentOptions } from '@/lib/departmentsService';
import {
  defaultFormDate,
  deleteDashRow,
  fetchDashRows,
  upsertDashRow,
  validateDashForm,
} from '@/lib/dashAdminService';

const EMPTY_FORM = {
  date: '',
  department: '',
  planed_qty: '',
  planed_hour: '',
  eficiancy: '',
  available_man_power: '',
};

export default function DataAdminView() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null); // { type: 'success'|'error', message }
  // Blocking centered modal for validation failures and blocked/failed
  // database writes: { title, message } | null. Stays open until the
  // user dismisses it with "OK".
  const [errorModal, setErrorModal] = useState(null);
  const [rows, setRows] = useState([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [departmentOptions, setDepartmentOptions] = useState([]);
  const [filterDate, setFilterDate] = useState('');

  // Defaults
  useEffect(() => {
    setForm((f) => (f.date ? f : { ...f, date: defaultFormDate() }));
  }, []);

  // Department dropdown options
  useEffect(() => {
    fetchDepartmentOptions()
      .then((res) => setDepartmentOptions(res.departments || []))
      .catch(() => setDepartmentOptions([]));
  }, []);

  const showToast = useCallback((type, message) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  // Validation failures and database insert/update/delete failures open
  // the centered modal (no corner toast) - the user must dismiss it.
  const showErrorModal = useCallback((title, message) => {
    setErrorModal({ title, message });
  }, []);

  const loadRows = useCallback(async (date) => {
    setRowsLoading(true);
    try {
      setRows(await fetchDashRows({ date: date || undefined }));
    } catch (err) {
      showErrorModal('Load failed', err?.message || 'The dash records could not be loaded from the database.');
    } finally {
      setRowsLoading(false);
    }
  }, [showErrorModal]);

  useEffect(() => {
    loadRows(filterDate);
  }, [filterDate, loadRows]);

  const setField = (field) => (e) => {
    setForm((f) => ({ ...f, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const result = validateDashForm(form);
    setErrors(result.errors);
    if (!result.ok) {
      showErrorModal('Validation failed', 'Please fix the highlighted fields before saving the record.');
      return;
    }
    setSaving(true);
    try {
      await upsertDashRow(result.values);
      showToast(
        'success',
        `Saved: ${result.values.department} on ${result.values.date} (plan ${result.values.planed_qty}).`
      );
      setForm((f) => ({ ...EMPTY_FORM, date: f.date }));
      await loadRows(filterDate);
    } catch (err) {
      showErrorModal('Save failed', err?.message || 'The record could not be saved to the database.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row) => {
    if (!row.id) return;
    try {
      await deleteDashRow(row.id);
      showToast('success', `Deleted ${row.department} on ${row.date}.`);
      await loadRows(filterDate);
    } catch (err) {
      showErrorModal('Delete failed', err?.message || 'The record could not be deleted from the database.');
    }
  };

  const startEdit = (row) => {
    setForm({
      date: row.date,
      department: row.department,
      planed_qty: String(row.planed_qty),
      planed_hour: row.planed_hour == null ? '' : String(row.planed_hour),
      eficiancy: row.eficiancy == null ? '' : String(row.eficiancy),
      available_man_power: String(row.available_man_power),
    });
    setErrors({});
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const inputCls = (field) =>
    `w-full rounded-xl border px-3 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:ring-2 focus:ring-indigo-500/40 ${
      errors[field] ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-white'
    }`;

  return (
    <div className="mx-auto max-w-7xl animate-fade-slide">
      <div>
        <h1 className="text-xl font-extrabold text-slate-900">Data Admin</h1>
        <p className="text-xs text-slate-400">
          Manage daily plan, efficiency and manpower records for the Live Dashboard (dash table)
        </p>
      </div>

      {/* Toast */}
      {toast ? (
        <div
          role="status"
          className={`mt-4 flex items-center gap-2 rounded-xl p-4 text-sm font-medium ring-1 ${
            toast.type === 'success'
              ? 'bg-emerald-50 text-emerald-700 ring-emerald-100'
              : 'bg-red-50 text-red-600 ring-red-100'
          }`}
        >
          {toast.type === 'success' ? <CheckCircleIcon /> : <AlertCircleIcon />}
          {toast.message}
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        {/* Form */}
        <form
          onSubmit={handleSubmit}
          className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 lg:col-span-2"
        >
          <h2 className="text-sm font-bold text-slate-900">
            {rows.some((r) => r.date === form.date && r.department === form.department)
              ? 'Update record'
              : 'New record'}
          </h2>

          <div className="mt-4 space-y-4">
            <div>
              <label htmlFor="dash-date" className="mb-1 block text-xs font-semibold text-slate-500">
                Date
              </label>
              <input
                id="dash-date"
                type="date"
                value={form.date}
                onChange={setField('date')}
                className={inputCls('date')}
              />
              {errors.date ? <p className="mt-1 text-xs text-red-500">{errors.date}</p> : null}
            </div>

            <div>
              <label htmlFor="dash-dept" className="mb-1 block text-xs font-semibold text-slate-500">
                Department
              </label>
              <input
                id="dash-dept"
                list="dash-dept-options"
                value={form.department}
                onChange={setField('department')}
                placeholder="e.g. Desma, Lasting 01"
                className={inputCls('department')}
              />
              <datalist id="dash-dept-options">
                {departmentOptions.map((d) => (
                  <option key={d} value={d} />
                ))}
              </datalist>
              {errors.department ? (
                <p className="mt-1 text-xs text-red-500">{errors.department}</p>
              ) : null}
            </div>

            <div>
              <label htmlFor="dash-plan" className="mb-1 block text-xs font-semibold text-slate-500">
                Planned Qty
              </label>
              <input
                id="dash-plan"
                type="number"
                min="0"
                value={form.planed_qty}
                onChange={setField('planed_qty')}
                placeholder="e.g. 1200"
                className={inputCls('planed_qty')}
              />
              {errors.planed_qty ? (
                <p className="mt-1 text-xs text-red-500">{errors.planed_qty}</p>
              ) : null}
            </div>

            <div>
              <label htmlFor="dash-hours" className="mb-1 block text-xs font-semibold text-slate-500">
                Planned Hours
              </label>
              <input
                id="dash-hours"
                type="number"
                min="0.5"
                step="0.5"
                value={form.planed_hour}
                onChange={setField('planed_hour')}
                placeholder="e.g. 9.5"
                className={inputCls('planed_hour')}
              />
              {errors.planed_hour ? (
                <p className="mt-1 text-xs text-red-500">{errors.planed_hour}</p>
              ) : null}
            </div>

            <div>
              <label htmlFor="dash-eff" className="mb-1 block text-xs font-semibold text-slate-500">
                Efficiency (%)
              </label>
              <input
                id="dash-eff"
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={form.eficiancy}
                onChange={setField('eficiancy')}
                placeholder="e.g. 85.5"
                className={inputCls('eficiancy')}
              />
              {errors.eficiancy ? (
                <p className="mt-1 text-xs text-red-500">{errors.eficiancy}</p>
              ) : null}
            </div>

            <div>
              <label htmlFor="dash-mp" className="mb-1 block text-xs font-semibold text-slate-500">
                Available Man Power
              </label>
              <input
                id="dash-mp"
                type="number"
                min="0"
                step="1"
                value={form.available_man_power}
                onChange={setField('available_man_power')}
                placeholder="e.g. 45"
                className={inputCls('available_man_power')}
              />
              {errors.available_man_power ? (
                <p className="mt-1 text-xs text-red-500">{errors.available_man_power}</p>
              ) : null}
            </div>
          </div>

          <button
            type="submit"
            disabled={saving}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-60"
          >
            {saving ? <SpinnerIcon /> : null}
            {saving ? 'Saving...' : 'Save / Update Record'}
          </button>
          <p className="mt-2 text-center text-[11px] text-slate-400">
            Saving an existing department + date updates it (upsert).
          </p>
        </form>

        {/* Management table */}
        <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 lg:col-span-3">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <h2 className="text-sm font-bold text-slate-900">Existing records</h2>
              <p className="text-xs text-slate-400">
                Current targets, efficiency and manpower per department
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <input
                type="date"
                aria-label="Filter by date"
                value={filterDate}
                onChange={(e) => setFilterDate(e.target.value)}
                className="rounded-xl border-slate-200 bg-white px-3 py-2 text-sm shadow-sm"
              />
              {filterDate ? (
                <button
                  type="button"
                  onClick={() => setFilterDate('')}
                  className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-200"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-y border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-3 font-semibold">Date</th>
                  <th className="px-4 py-3 font-semibold">Department</th>
                  <th className="px-4 py-3 text-right font-semibold">Planned</th>
                  <th className="px-4 py-3 text-right font-semibold">Hours</th>
                  <th className="px-4 py-3 text-right font-semibold">Efficiency</th>
                  <th className="px-4 py-3 text-right font-semibold">Man Power</th>
                  <th className="px-4 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rowsLoading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                      <span className="inline-flex items-center gap-2">
                        <SpinnerIcon /> Loading records...
                      </span>
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                      No dash records found{filterDate ? ` for ${filterDate}` : ''}.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={`${row.id}-${row.date}-${row.department}`}
                      className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60"
                    >
                      <td className="px-4 py-2.5 font-medium text-slate-500">{row.date}</td>
                      <td className="px-4 py-2.5 font-semibold text-slate-700">{row.department}</td>
                      <td className="px-4 py-2.5 text-right font-bold text-slate-900">
                        {row.planed_qty.toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 text-right text-slate-600">
                        {row.planed_hour == null ? '-' : row.planed_hour}
                      </td>
                      <td className="px-4 py-2.5 text-right text-slate-600">
                        {row.eficiancy == null ? '-' : `${row.eficiancy}%`}
                      </td>
                      <td className="px-4 py-2.5 text-right text-slate-600">
                        {row.available_man_power}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => startEdit(row)}
                          className="rounded-lg bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-600 hover:bg-indigo-100"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(row)}
                          className="ml-2 rounded-lg bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-100"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* Blocking centered alert: validation failures + database write errors. */}
      <ErrorModal error={errorModal} onClose={() => setErrorModal(null)} />
    </div>
  );
}
