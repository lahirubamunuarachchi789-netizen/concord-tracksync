'use client';

import { usePathname } from 'next/navigation';
import { ChevronLeftDoubleIcon, LogoutIcon, LogoMark, MenuIcon } from './icons';

const SECTION_TITLES = {
  '/home': 'Home',
  '/dashboard': 'Dashboard',
  '/transactions': 'Transactions',
  '/reports': 'Reports',
  '/stock': 'Stock',
};

function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'U';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/**
 * Sticky top bar: mobile drawer trigger, desktop collapse trigger, app title,
 * current section, logged-in user details and the logout action.
 */
export default function DashboardHeader({
  user,
  collapsed,
  onToggleCollapse,
  onOpenMobile,
  onLogout,
}) {
  const pathname = usePathname();
  const sectionTitle = SECTION_TITLES[pathname] || '';

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/85 backdrop-blur">
      <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
        {/* Mobile drawer trigger */}
        <button
          type="button"
          onClick={onOpenMobile}
          aria-label="Open navigation menu"
          className="rounded-xl p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 lg:hidden"
        >
          <MenuIcon className="h-5 w-5" />
        </button>

        {/* Desktop collapse trigger */}
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="hidden rounded-xl p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 lg:inline-flex"
        >
          <ChevronLeftDoubleIcon
            className={`h-5 w-5 transition-transform duration-300 ${collapsed ? 'rotate-180' : ''}`}
          />
        </button>

        {/* App title */}
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 via-indigo-600 to-purple-700 shadow-md shadow-indigo-600/25 lg:hidden">
            <LogoMark className="h-5 w-5 text-white" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold leading-tight text-slate-900 sm:text-base">
              Concord{' '}
              <span className="bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 bg-clip-text text-transparent">
                TrackSync
              </span>
            </p>
            <p className="hidden truncate text-[11px] leading-tight text-slate-400 sm:block">
              Production Tracking System - Concord Footwear (Pvt) Ltd
            </p>
          </div>
        </div>

        {sectionTitle ? (
          <span className="ml-2 hidden rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-100 xl:inline">
            {sectionTitle}
          </span>
        ) : null}

        {/* User profile + logout */}
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white py-1.5 pl-1.5 pr-3 shadow-sm">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 via-indigo-600 to-purple-700 text-xs font-bold text-white">
              {initials(user?.username)}
            </span>
            <span className="hidden min-w-0 leading-tight sm:block">
              <span className="block truncate text-xs font-semibold text-slate-800">
                {user?.username}
              </span>
              <span className="block truncate text-[11px] text-slate-400">
                {user?.department || 'Signed in'}
              </span>
            </span>
          </div>

          <button
            type="button"
            onClick={onLogout}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 shadow-sm transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          >
            <LogoutIcon className="h-4 w-4" />
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </div>
    </header>
  );
}