'use client';

// ============================================================
// SizeSelect - quick-select grid for shoe sizes 35 to 50.
// The selected size stays locked in the parent until changed.
// ============================================================

import { SIZES } from '@/lib/qrActivationService';

const ACTIVE_CLS =
  'border-transparent bg-gradient-to-r from-blue-700 via-indigo-700 to-purple-800 text-white shadow-lg shadow-indigo-600/25';
const IDLE_CLS =
  'border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:bg-indigo-50/40';

export default function SizeSelect({ value, onChange, attention = false }) {
  return (
    <section
      className={`rounded-2xl bg-white p-5 ring-1 transition duration-300 ${
        attention ? 'animate-pulse ring-2 ring-amber-400' : 'ring-slate-200'
      }`}
    >
      <header className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">Size</h3>
        <span className="rounded-full bg-purple-50 px-2.5 py-0.5 text-[11px] font-semibold text-purple-600 ring-1 ring-purple-100">
          35 – 50
        </span>
      </header>

      <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
        {SIZES.map((size) => {
          const active = value === size;
          return (
            <button
              key={size}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(size)}
              className={`rounded-xl border px-1 py-2.5 text-sm font-bold transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                active ? ACTIVE_CLS : IDLE_CLS
              } hover:-translate-y-0.5`}
            >
              {size}
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-slate-400">
        {value
          ? `Locked: size ${value} applies to every scan until you change it.`
          : 'Pick the size for the bundles you are about to scan.'}
      </p>
    </section>
  );
}