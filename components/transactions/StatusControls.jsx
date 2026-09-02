'use client';

import LockIcon from './LockIcon';

const ACTIVE_CLS =
  'border-transparent bg-gradient-to-r from-blue-700 via-indigo-700 to-purple-800 text-white shadow-lg shadow-indigo-600/25';
const IDLE_CLS =
  'border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:bg-indigo-50/40';

const QC_ACCENT = {
  Forward: 'Forward',
  'B Grade': 'B Grade',
  'C Grade': 'C Grade',
  'Lab Testing': 'Lab Testing',
  Return: 'Return',
  Reworked: 'Reworked',
};

/**
 * Dual action sections: Record Status (IN / OUT) and QC Status
 * (Forward, B Grade, C Grade, Lab Testing, Return, Reworked).
 * Buttons stay locked until a code is scanned.
 */
export default function StatusControls({
  enabled,
  recordStatus,
  qcStatus,
  onRecord,
  onQc,
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Record Status */}
      <section
        className={`rounded-2xl bg-white p-5 ring-1 transition ${
          enabled ? 'ring-slate-200' : 'ring-slate-100'
        }`}
      >
        <header className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">
            Record Status
          </h3>
          <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-600 ring-1 ring-indigo-100">
            Movement
          </span>
        </header>
        <div className="grid grid-cols-2 gap-3">
          {['IN', 'OUT'].map((status) => {
            const active = recordStatus === status;
            return (
              <button
                key={status}
                type="button"
                disabled={!enabled}
                aria-pressed={active}
                onClick={() => onRecord(status)}
                className={`rounded-xl border px-4 py-4 text-base font-extrabold tracking-wide transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                  active ? ACTIVE_CLS : IDLE_CLS
                } ${!enabled ? 'cursor-not-allowed opacity-40' : 'hover:-translate-y-0.5'}`}
              >
                {status}
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-400">
          {recordStatus
            ? `Selected record status: ${recordStatus}.`
            : 'Pick how this scan moves: raw material IN or finished goods OUT.'}
        </p>
      </section>

      {/* QC Status */}
      <section
        className={`rounded-2xl bg-white p-5 ring-1 transition ${
          enabled ? 'ring-slate-200' : 'ring-slate-100'
        }`}
      >
        <header className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">QC Status</h3>
          <span className="rounded-full bg-purple-50 px-2.5 py-0.5 text-[11px] font-semibold text-purple-600 ring-1 ring-purple-100">
            Quality
          </span>
        </header>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {Object.keys(QC_ACCENT).map((status) => {
            const active = qcStatus === status;
            return (
              <button
                key={status}
                type="button"
                disabled={!enabled}
                aria-pressed={active}
                onClick={() => onQc(status)}
                className={`rounded-xl border px-2 py-3 text-sm font-bold transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                  active ? ACTIVE_CLS : IDLE_CLS
                } ${!enabled ? 'cursor-not-allowed opacity-40' : 'hover:-translate-y-0.5'}`}
              >
                {status}
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-400">
          {qcStatus
            ? `Selected QC status: ${qcStatus}.`
            : 'Choose the quality outcome recorded for this scan.'}
        </p>
      </section>

      {/* Locked overlay hint */}
      {!enabled ? (
        <p className="flex items-center justify-center gap-2 rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-medium text-slate-500 lg:col-span-2">
          <LockIcon className="h-3.5 w-3.5" />
          Scan or type a QR code to unlock the status buttons.
        </p>
      ) : null}
    </div>
  );
}