'use client';

import Link from 'next/link';
import { useSession } from './AppShell';
import {
  ArrowRightIcon,
  DashboardIcon,
  HomeIcon,
  ReportsIcon,
  StockIcon,
  TransactionsIcon,
} from './icons';

const QUICK_LINKS = [
  {
    label: 'Dashboard',
    description: 'Live KPIs & line output',
    href: '/dashboard',
    Icon: DashboardIcon,
    gradient: 'from-blue-600 to-indigo-600',
  },
  {
    label: 'Transactions',
    description: 'Record movements',
    href: '/transactions',
    Icon: TransactionsIcon,
    gradient: 'from-indigo-600 to-purple-600',
  },
  {
    label: 'Reports',
    description: 'Summaries & exports',
    href: '/reports',
    Icon: ReportsIcon,
    gradient: 'from-sky-500 to-blue-600',
  },
  {
    label: 'Stock',
    description: 'Material levels',
    href: '/stock',
    Icon: StockIcon,
    gradient: 'from-purple-600 to-fuchsia-600',
  },
];

/**
 * Home section: gradient welcome hero (echoes the login brand panel) with
 * the signed-in user's name and department, plus quick links to modules.
 */
export default function HomeGreeting() {
  const user = useSession();
  const firstName = (user?.username || 'there').split(/\s+/)[0];
  const department = user?.department || 'your department';

  return (
    <div className="mx-auto max-w-7xl animate-fade-slide">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-blue-700 via-indigo-700 to-purple-800 px-6 py-10 shadow-xl shadow-indigo-600/20 sm:px-10 sm:py-14">
        <div
          className="absolute inset-0 bg-blueprint-grid bg-[length:34px_34px]"
          aria-hidden="true"
        />
        <div
          className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-purple-400/30 blur-3xl"
          aria-hidden="true"
        />
        <div
          className="absolute -bottom-28 -left-24 h-80 w-80 rounded-full bg-sky-400/25 blur-3xl"
          aria-hidden="true"
        />

        <div className="relative z-10 max-w-2xl">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-blue-100 ring-1 ring-white/20">
            <HomeIcon className="h-3.5 w-3.5" /> Signed in as {department}
          </span>
          <h1 className="mt-4 text-3xl font-extrabold leading-tight tracking-tight text-white sm:text-4xl">
            Welcome back,{' '}
            <span className="bg-gradient-to-r from-sky-300 via-blue-200 to-purple-300 bg-clip-text text-transparent">
              {firstName}
            </span>
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-blue-100 sm:text-base">
            Production Tracking System - Concord Footwear (Pvt) Ltd. Track lines, monitor output
            and keep every department in sync.
          </p>
        </div>
      </section>

      {/* Quick links */}
      <section className="mt-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">
          Jump to a module
        </h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {QUICK_LINKS.map(({ label, description, href, Icon, gradient }) => (
            <Link
              key={href}
              href={href}
              className="group rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:shadow-md hover:shadow-indigo-600/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <div className="flex items-center justify-between">
                <span
                  className={`flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br ${gradient} text-white shadow-md`}
                >
                  <Icon className="h-5 w-5" />
                </span>
                <ArrowRightIcon className="h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500" />
              </div>
              <p className="mt-4 text-sm font-bold text-slate-900">{label}</p>
              <p className="mt-0.5 text-xs text-slate-500">{description}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}