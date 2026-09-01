/**
 * KPI metric card with a gradient icon tile, matching the login theme.
 * tone: 'up' (green) | 'down' (red) | 'flat' (neutral)
 */
export default function StatCard({
  label,
  value,
  delta,
  tone = 'flat',
  Icon,
  gradient = 'from-blue-600 to-indigo-600',
}) {
  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:shadow-md hover:shadow-indigo-600/5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
          <p className="mt-2 text-2xl font-extrabold tracking-tight text-slate-900">{value}</p>
        </div>
        <span
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${gradient} text-white shadow-md`}
        >
          <Icon className="h-5 w-5" />
        </span>
      </div>
      {delta ? (
        <p
          className={`mt-3 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            tone === 'up'
              ? 'bg-emerald-50 text-emerald-600'
              : tone === 'down'
                ? 'bg-red-50 text-red-600'
                : 'bg-slate-100 text-slate-500'
          }`}
        >
          {delta}
        </p>
      ) : null}
    </div>
  );
}