import { CheckCircleIcon } from './icons';

/**
 * Themed placeholder panel for modules that are scaffolded but not yet
 * wired to live data. Keeps every section visually consistent.
 */
export default function EmptyState({ Icon, title, description, items = [] }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 via-indigo-600 to-purple-700 text-white shadow-lg shadow-indigo-600/25">
        <Icon className="h-7 w-7" />
      </span>
      <h2 className="mt-5 text-lg font-bold text-slate-900">{title}</h2>
      <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-slate-500">{description}</p>
      {items.length ? (
        <ul className="mx-auto mt-6 grid max-w-lg gap-2 text-left sm:grid-cols-2">
          {items.map((item) => (
            <li
              key={item}
              className="flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600 ring-1 ring-slate-100"
            >
              <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              {item}
            </li>
          ))}
        </ul>
      ) : null}
      <span className="mt-6 inline-flex items-center rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-600 ring-1 ring-indigo-100">
        Module under development
      </span>
    </div>
  );
}