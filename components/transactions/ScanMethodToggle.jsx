'use client';

import { CameraIcon, ScanLineIcon } from '@/components/icons';

const METHODS = [
  {
    id: 'camera',
    label: 'Camera Scan',
    hint: 'Phone / tablet live scanning',
    Icon: CameraIcon,
  },
  {
    id: 'gun',
    label: 'QR Scanner Machine',
    hint: 'USB / Bluetooth scanner gun',
    Icon: ScanLineIcon,
  },
];

/**
 * Segmented control for choosing the preferred scanning method.
 * Selected card uses the login theme gradient (blue -> indigo -> purple).
 */
export default function ScanMethodToggle({ method, onChange }) {
  return (
    <div
      role="tablist"
      aria-label="Scanning method"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      {METHODS.map(({ id, label, hint, Icon }) => {
        const active = method === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={`group flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
              active
                ? 'border-transparent bg-gradient-to-r from-blue-700 via-indigo-700 to-purple-800 text-white shadow-lg shadow-indigo-600/25'
                : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:bg-indigo-50/40'
            }`}
          >
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition ${
                active
                  ? 'bg-white/15 ring-1 ring-white/25'
                  : 'bg-slate-100 text-slate-500 group-hover:bg-white group-hover:text-indigo-600'
              }`}
            >
              <Icon className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold">{label}</span>
              <span
                className={`block truncate text-xs ${active ? 'text-indigo-100' : 'text-slate-400'}`}
              >
                {hint}
              </span>
            </span>
            <span
              className={`ml-auto h-4 w-4 shrink-0 rounded-full border-2 transition ${
                active ? 'border-white bg-white' : 'border-slate-300 bg-white'
              }`}
            >
              {active ? (
                <span className="mx-auto mt-0.5 block h-2 w-2 rounded-full bg-gradient-to-br from-blue-600 to-purple-700" />
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}