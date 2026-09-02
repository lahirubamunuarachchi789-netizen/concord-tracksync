'use client';

// ============================================================
// PoSelect - Purchase Order picker with Supabase-backed
// management: fetch the active list, add new POs inline (modal)
// and delete the selected PO. The selected value stays locked
// in the parent until the user changes it.
// ============================================================

import { useEffect, useRef, useState } from 'react';
import {
  ChevronDownIcon,
  LayersIcon,
  PlusIcon,
  RefreshIcon,
  SpinnerIcon,
  TrashIcon,
  XIcon,
} from '@/components/icons';
import {
  addPurchaseOrder,
  deletePurchaseOrder,
  fetchPurchaseOrders,
} from '@/lib/qrActivationService';

export const ACTIVE_CLS =
  'border-transparent bg-gradient-to-r from-blue-700 via-indigo-700 to-purple-800 text-white shadow-lg shadow-indigo-600/25';

export default function PoSelect({ value, onChange, notify }) {
  const [pos, setPos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const inputRef = useRef(null);

  /* ------------------------- load PO list ------------------------- */

  async function load({ silent = false } = {}) {
    if (!silent) setLoading(true);
    setLoadError('');
    try {
      const list = await fetchPurchaseOrders();
      setPos(list);
    } catch (err) {
      const raw = String(err?.message || err || '');
      setLoadError(
        /does not exist|PGRST205|relation/i.test(raw)
          ? 'The PO table is not reachable yet - run supabase/qr-activation-schema.sql in the Supabase SQL Editor.'
          : raw || 'Could not load the PO list.'
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Two-step delete confirmation auto-resets after 3s.
  useEffect(() => {
    if (!confirmingDelete) return undefined;
    const timer = setTimeout(() => setConfirmingDelete(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmingDelete]);

  // Focus the modal input when it opens.
  useEffect(() => {
    if (!modalOpen) return undefined;
    setDraft('');
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [modalOpen]);

  /* --------------------------- actions --------------------------- */

  async function handleAdd(event) {
    event.preventDefault();
    const po = draft.trim();
    if (!po || saving) return;
    if (pos.some((p) => p.toLowerCase() === po.toLowerCase())) {
      notify('error', 'Duplicate PO', `PO "${po}" is already in the list.`);
      return;
    }
    setSaving(true);
    const result = await addPurchaseOrder(po);
    setSaving(false);
    if (result.ok) {
      setPos((prev) => [...prev, result.po].sort((a, b) => a.localeCompare(b)));
      onChange(result.po);
      setModalOpen(false);
      notify('success', 'PO added', `${result.po} saved to the PO table.`);
    } else {
      notify('error', result.duplicate ? 'Duplicate PO' : 'Could not add PO', result.error);
    }
  }

  async function handleDelete() {
    if (!value || saving) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    const result = await deletePurchaseOrder(value);
    setSaving(false);
    setConfirmingDelete(false);
    if (result.ok) {
      setPos((prev) => prev.filter((p) => p !== value));
      onChange('');
      notify('success', 'PO deleted', `${value} removed from the PO table.`);
    } else {
      notify('error', 'Could not delete PO', result.error);
    }
  }

  /* ---------------------------- render ---------------------------- */

  return (
    <section
      className={`rounded-2xl bg-white p-5 ring-1 transition duration-300 ${
        confirmingDelete ? 'ring-2 ring-red-300' : 'ring-slate-200'
      }`}
    >
      <header className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">
            Purchase Order
          </h3>
          <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-600 ring-1 ring-indigo-100">
            {loading ? '…' : `${pos.length} active`}
          </span>
        </div>
        <button
          type="button"
          onClick={() => load({ silent: true })}
          aria-label="Refresh PO list"
          className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-indigo-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <RefreshIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[10rem] flex-1">
          <LayersIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <select
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={loading || pos.length === 0}
            aria-label="Select purchase order"
            className="w-full appearance-none rounded-xl border border-slate-200 bg-white py-3 pl-10 pr-9 text-sm font-semibold text-slate-900 shadow-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-100 disabled:text-slate-400"
          >
            <option value="">
              {loading ? 'Loading POs…' : pos.length === 0 ? 'No POs yet' : 'Select PO…'}
            </option>
            {pos.map((po) => (
              <option key={po} value={po}>
                {po}
              </option>
            ))}
          </select>
          <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        </div>

        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-3 text-sm font-bold transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${ACTIVE_CLS}`}
        >
          <PlusIcon className="h-4 w-4" />
          Add PO
        </button>

        <button
          type="button"
          onClick={handleDelete}
          disabled={!value || saving}
          aria-label={confirmingDelete ? 'Confirm delete PO' : 'Delete selected PO'}
          className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-3 text-sm font-bold transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-40 ${
            confirmingDelete
              ? 'bg-red-600 text-white shadow-lg shadow-red-600/25'
              : 'border border-slate-200 bg-white text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600'
          }`}
        >
          {saving ? (
            <SpinnerIcon className="h-4 w-4 animate-spin" />
          ) : (
            <TrashIcon className="h-4 w-4" />
          )}
          {confirmingDelete ? 'Confirm?' : 'Delete'}
        </button>
      </div>

      {value ? (
        <p className="mt-3 text-xs leading-relaxed text-emerald-700">
          Locked: <span className="font-bold">{value}</span> applies to every scan until you change
          it.
        </p>
      ) : (
        <p className="mt-3 text-xs leading-relaxed text-slate-400">
          {loadError || 'Pick the PO this bundle belongs to. It stays locked for all scans.'}
        </p>
      )}

      {modalOpen ? (
        <AddPoModal
          draft={draft}
          onDraftChange={setDraft}
          saving={saving}
          onSubmit={handleAdd}
          onClose={() => setModalOpen(false)}
        />
      ) : null}
    </section>
  );
}

/** Inline modal for entering a new PO number. */
function AddPoModal({ draft, onDraftChange, saving, onSubmit, onClose }) {
  const inputRef = useRef(null);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md animate-fade-slide rounded-2xl bg-gradient-to-br from-blue-700 via-indigo-700 to-purple-800 p-[1.5px] shadow-2xl"
      >
        <div className="rounded-2xl bg-white p-6">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-base font-extrabold text-slate-900">Add purchase order</h3>
              <p className="mt-0.5 text-xs text-slate-400">
                Saved straight into the Supabase PO table.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>

          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="e.g. PO-2026-0148"
            spellCheck={false}
            autoComplete="off"
            className="mt-4 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 font-mono text-sm font-semibold text-slate-900 shadow-sm outline-none transition placeholder:font-sans placeholder:font-normal placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl px-4 py-2.5 text-sm font-bold text-slate-500 transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!draft.trim() || saving}
              className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-bold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-40 ${ACTIVE_CLS}`}
            >
              {saving ? (
                <SpinnerIcon className="h-4 w-4 animate-spin" />
              ) : (
                <PlusIcon className="h-4 w-4" />
              )}
              Save PO
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}