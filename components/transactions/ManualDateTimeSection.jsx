'use client';

// ============================================================
// ManualDateTimeSection - optional "Manual Date & Time" override
// for the Standard Transactions and QR Activation windows.
//
// The toggle is OFF by default: the date/time inputs stay HIDDEN and
// the transaction/activation payload falls back to the CURRENT system
// time (new Date()). Flipping it ON reveals a native `datetime-local`
// picker whose value is written to every data_updates `created_at`
// while the toggle stays on.
//
// Fully controlled: the parent owns `enabled` (boolean) and `value`
// (a "YYYY-MM-DDTHH:mm" datetime-local string) and persists them.
// ============================================================

function ClockIcon(props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export default function ManualDateTimeSection({
  enabled = false,
  value = '',
  onToggle,
  onValueChange,
  inputId = 'manual-datetime-input',
}) {
  return (
    <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition ${
              enabled ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-100 text-slate-500'
            }`}
          >
            <ClockIcon className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">
              Manual Date &amp; Time
            </h3>
            <p className="text-xs text-slate-400">
              {enabled ? 'Overrides the timestamp of every scan' : 'Off - uses the current system time'}
            </p>
          </div>
        </div>

        {/* Toggle switch */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => onToggle(!enabled)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
            enabled ? 'bg-indigo-600' : 'bg-slate-300'
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all duration-200 ${
              enabled ? 'left-[22px]' : 'left-0.5'
            }`}
          />
        </button>
      </div>

      {enabled ? (
        <div className="mt-4">
          <label
            htmlFor={inputId}
            className="mb-1.5 block text-xs font-semibold text-slate-500"
          >
            Date &amp; Time
          </label>
          <input
            id={inputId}
            type="datetime-local"
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition focus:border-indigo-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          />
          <p className="mt-2 text-xs leading-relaxed text-slate-400">
            This date &amp; time is written to the <code>created_at</code> of every record while
            the toggle stays on. Turn it off to fall back to the current system time.
          </p>
        </div>
      ) : (
        <p className="mt-3 text-xs leading-relaxed text-slate-400">
          Leave the toggle off to record every scan with the current system time (
          <code>new Date()</code>).
        </p>
      )}
    </section>
  );
}