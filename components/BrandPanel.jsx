import { CheckCircleIcon, LogoMark } from './icons';

const FEATURES = [
  'Real-time production line tracking',
  'Department-wise dashboards & reports',
  'Secure, role-based access control',
];

const STATS = [
  { value: '24/7', label: 'Line monitoring' },
  { value: '10+', label: 'Connected departments' },
  { value: '100%', label: 'Audit-ready records' },
];

/**
 * Left side of the split-screen layout: blue-purple industrial gradient
 * panel with the Concord TrackSync branding.
 */
export default function BrandPanel() {
  return (
    <aside className="relative hidden w-[46%] max-w-xl flex-col justify-between overflow-hidden bg-gradient-to-br from-blue-700 via-indigo-700 to-purple-800 p-10 lg:flex xl:p-14">
      {/* Blueprint grid + glow decorations */}
      <div className="absolute inset-0 bg-blueprint-grid bg-[length:34px_34px]" aria-hidden="true" />
      <div className="absolute -right-28 -top-28 h-96 w-96 rounded-full bg-purple-400/30 blur-3xl" aria-hidden="true" />
      <div className="absolute -bottom-32 -left-28 h-96 w-96 rounded-full bg-sky-400/25 blur-3xl" aria-hidden="true" />

      {/* Brand row */}
      <div className="relative z-10 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/25 backdrop-blur">
          <LogoMark className="h-6 w-6 text-white" />
        </span>
        <div>
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-white">Concord</p>
          <p className="text-xs text-blue-200">Footwear (Pvt) Ltd</p>
        </div>
      </div>

      {/* Headline block */}
      <div className="relative z-10 max-w-md">
        <h1 className="text-4xl font-extrabold leading-tight tracking-tight text-white xl:text-5xl">
          Concord{' '}
          <span className="bg-gradient-to-r from-sky-300 via-blue-200 to-purple-300 bg-clip-text text-transparent">
            TrackSync
          </span>
        </h1>
        <p className="mt-4 text-base leading-relaxed text-blue-100">
          Production Tracking System - Concord Footwear (Pvt) Ltd
        </p>

        <ul className="mt-8 space-y-3.5">
          {FEATURES.map((feature) => (
            <li key={feature} className="flex items-center gap-3 text-sm font-medium text-blue-50">
              <CheckCircleIcon className="h-5 w-5 shrink-0 text-emerald-300" />
              {feature}
            </li>
          ))}
        </ul>

        <div className="mt-10 grid grid-cols-3 gap-3">
          {STATS.map((stat) => (
            <div
              key={stat.label}
              className="rounded-2xl bg-white/10 px-4 py-3.5 ring-1 ring-white/15 backdrop-blur"
            >
              <p className="text-lg font-bold text-white">{stat.value}</p>
              <p className="mt-0.5 text-[11px] leading-tight text-blue-200">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>

      <p className="relative z-10 text-xs text-blue-200/80">
        © {new Date().getFullYear()} Concord Footwear (Pvt) Ltd. All rights reserved.
      </p>
    </aside>
  );
}
