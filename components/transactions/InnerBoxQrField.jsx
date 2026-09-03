'use client';

import { QrCodeIcon, XIcon } from '@/components/icons';

/**
 * Inner Box QR field of the Dual-Scan process (Finishing departments).
 * Display-only: the value is captured by the active scanner source
 * (gun burst / camera frame / typed entry) and populated here - the
 * field is intentionally read-only and out of the tab order so it can
 * never steal keystrokes from the scanner gun capture input.
 */
export default function InnerBoxQrField({ value, awaiting = false, onClear }) {
  const captured = Boolean(value);
  return (
    <div
      className={`rounded-2xl border-2 border-dashed p-4 transition ${
        captured
          ? 'border-emerald-200 bg-emerald-50/40'
          : awaiting
            ? 'border-indigo-300 bg-indigo-50/50'
            : 'border-slate-200 bg-slate-50'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <span
            className={`h-2 w-2 rounded-full ${
              captured ? 'bg-emerald-500' : awaiting ? 'animate-pulse bg-indigo-500' : 'bg-slate-300'
            }`}
          />
          Inner Box QR {captured ? '- captured (scan 1 of 2)' : awaiting ? '- scan 1 of 2' : ''}
        </span>
        {captured && onClear ? (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear Inner Box QR and restart the pair"
            className="rounded-lg px-2.5 py-1 text-xs font-semibold text-indigo-600 transition hover:bg-indigo-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <input
        type="text"
        value={value || ''}
        readOnly
        tabIndex={-1}
        aria-live="polite"
        aria-label="Inner Box QR, auto-captured by the first scan"
        placeholder={awaiting ? 'Waiting for the Inner Box QR scan...' : 'Awaiting Inner Box QR...'}
        spellCheck={false}
        autoComplete="off"
        className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 font-mono text-sm text-slate-900 shadow-sm outline-none transition placeholder:font-sans placeholder:text-slate-400"
      />

      <p className="mt-2 text-xs text-slate-400">
        {captured
          ? 'Inner Box captured - the next scan is the Shoe QR (scan 2 of 2) and records the transaction.'
          : 'Dual-Scan active: scan the Inner Box QR first, the Shoe QR scan follows automatically.'}
      </p>
    </div>
  );
}