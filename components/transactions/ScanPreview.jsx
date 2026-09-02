'use client';

import { QrCodeIcon, XIcon } from '@/components/icons';

const SOURCE_BADGES = {
  camera: { label: 'Camera', cls: 'bg-sky-50 text-sky-700 ring-sky-200' },
  gun: { label: 'Scanner gun', cls: 'bg-purple-50 text-purple-700 ring-purple-200' },
  manual: { label: 'Typed entry', cls: 'bg-slate-100 text-slate-600 ring-slate-200' },
};

/**
 * Live preview of the currently scanned code, with source badge and time.
 * Re-mounts on every new scan (keyed by parent) for the fade-slide pop.
 */
export default function ScanPreview({ scan, onClear }) {
  if (!scan?.value) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-8 text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-slate-300 ring-1 ring-slate-200">
          <QrCodeIcon className="h-6 w-6" />
        </span>
        <p className="mt-3 text-sm font-semibold text-slate-500">No code scanned yet</p>
        <p className="mt-1 text-xs text-slate-400">
          Scan a box, bundle or batch QR to begin recording a transaction.
        </p>
      </div>
    );
  }

  const badge = SOURCE_BADGES[scan.source] || SOURCE_BADGES.manual;
  const time = new Date(scan.at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className="animate-fade-slide overflow-hidden rounded-2xl border border-indigo-100 bg-gradient-to-br from-blue-700 via-indigo-700 to-purple-800 p-[1.5px] shadow-lg shadow-indigo-600/20">
      <div className="flex items-start gap-3 rounded-2xl bg-white px-4 py-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 via-indigo-600 to-purple-700 text-white shadow-md shadow-indigo-600/25">
          <QrCodeIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${badge.cls}`}
            >
              {badge.label}
            </span>
            <span className="text-[11px] font-medium text-slate-400">at {time}</span>
            {scan.result === 'synced' ? (
              <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
                Recorded
              </span>
            ) : scan.result === 'queued' || scan.result === 'failed' ? (
              <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">
                {scan.result === 'failed' ? 'Retry pending' : 'Queued offline'}
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 break-all font-mono text-base font-bold leading-snug text-slate-900">
            {scan.value}
          </p>
        </div>
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear scanned code"
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <XIcon className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}