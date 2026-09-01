import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';
import {
  DEPARTMENT_PROGRESS,
  KPI,
  MAX_UNITS,
  OUTPUT_WEEK,
  RECENT_ACTIVITY,
  STATUS_STYLES,
} from './_data';

export const metadata = { title: 'Dashboard | Concord TrackSync' };

const PANEL = 'rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200';

export default function DashboardPage() {
  return (
    <div className="mx-auto max-w-7xl animate-fade-slide">
      <PageHeader
        title="Dashboard"
        subtitle="Live production overview across all departments - Concord Footwear (Pvt) Ltd"
      />

      {/* KPI cards */}
      <section aria-label="Key metrics" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {KPI.map(({ label, value, delta, tone, Icon, gradient }) => (
          <StatCard
            key={label}
            label={label}
            value={value}
            delta={delta}
            tone={tone}
            Icon={Icon}
            gradient={gradient}
          />
        ))}
      </section>

      {/* Weekly output + department progress */}
      <section className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className={`${PANEL} lg:col-span-2`}>
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-slate-900">Weekly production output</h2>
              <p className="text-xs text-slate-400">Units completed per day (thousands)</p>
            </div>
            <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-600 ring-1 ring-indigo-100">
              This week
            </span>
          </div>
          <div className="flex h-44 items-end gap-2 sm:gap-4">
            {OUTPUT_WEEK.map(({ day, units }) => (
              <div key={day} className="flex h-full flex-1 flex-col items-center justify-end gap-2">
                <span className="text-[10px] font-semibold text-slate-400">{units}k</span>
                <div
                  title={`${day}: ${units},000 units`}
                  style={{ height: `${Math.round((units / MAX_UNITS) * 100)}%` }}
                  className="w-full rounded-t-lg bg-gradient-to-t from-indigo-600 via-indigo-500 to-sky-400 transition hover:brightness-110"
                />
                <span className="text-[11px] font-medium text-slate-500">{day}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={PANEL}>
          <h2 className="text-sm font-bold text-slate-900">Department progress</h2>
          <p className="text-xs text-slate-400">Daily plan completion</p>
          <ul className="mt-5 space-y-4">
            {DEPARTMENT_PROGRESS.map(({ name, progress }) => (
              <li key={name}>
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-600">{name}</span>
                  <span className="font-bold text-slate-900">{progress}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Recent activity */}
      <section className={`${PANEL} mt-6 overflow-hidden p-0`}>
        <div className="px-5 pt-5">
          <h2 className="text-sm font-bold text-slate-900">Recent activity</h2>
          <p className="text-xs text-slate-400">Latest events from the production floor</p>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-y border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-3 font-semibold">Time</th>
                <th className="px-5 py-3 font-semibold">Line</th>
                <th className="px-5 py-3 font-semibold">Event</th>
                <th className="px-5 py-3 font-semibold">Department</th>
                <th className="px-5 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {RECENT_ACTIVITY.map((row) => (
                <tr
                  key={`${row.time}-${row.line}`}
                  className="border-b border-slate-50 transition last:border-0 hover:bg-slate-50/60"
                >
                  <td className="px-5 py-3.5 font-medium text-slate-500">{row.time}</td>
                  <td className="px-5 py-3.5 font-semibold text-slate-700">{row.line}</td>
                  <td className="px-5 py-3.5 text-slate-600">{row.event}</td>
                  <td className="px-5 py-3.5 text-slate-600">{row.department}</td>
                  <td className="px-5 py-3.5">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${
                        STATUS_STYLES[row.status] || STATUS_STYLES.Pending
                      }`}
                    >
                      {row.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}