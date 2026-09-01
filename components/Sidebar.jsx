'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  DashboardIcon,
  HomeIcon,
  LogoMark,
  ReportsIcon,
  StockIcon,
  TransactionsIcon,
} from './icons';

const NAV_ITEMS = [
  { label: 'Home', href: '/home', Icon: HomeIcon },
  { label: 'Dashboard', href: '/dashboard', Icon: DashboardIcon },
  { label: 'Transactions', href: '/transactions', Icon: TransactionsIcon },
  { label: 'Reports', href: '/reports', Icon: ReportsIcon },
  { label: 'Stock', href: '/stock', Icon: StockIcon },
];

/**
 * Primary navigation sidebar.
 * - Desktop : fixed column, collapsible to an icon rail (preference persisted).
 * - Mobile  : slide-in drawer over a dimmed backdrop, opened from the header.
 */
export default function Sidebar({ collapsed, mobileOpen, onCloseMobile }) {
  const pathname = usePathname();

  return (
    <>
      {/* Mobile backdrop */}
      <div
        aria-hidden="true"
        onClick={onCloseMobile}
        className={`fixed inset-0 z-30 bg-slate-900/50 backdrop-blur-sm transition-opacity duration-300 lg:hidden ${
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 transform flex-col overflow-hidden bg-white shadow-xl shadow-slate-900/5 ring-1 ring-slate-200 transition-all duration-300 ease-in-out ${
          collapsed ? 'lg:w-20' : 'lg:w-72'
        } ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}
      >
        {/* Brand header — mirrors the login screen gradient */}
        <div className="relative flex items-center gap-3 overflow-hidden bg-gradient-to-br from-blue-700 via-indigo-700 to-purple-800 px-4 py-5">
          <div
            className="absolute inset-0 bg-blueprint-grid bg-[length:24px_24px]"
            aria-hidden="true"
          />
          <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/25">
            <LogoMark className="h-5 w-5 text-white" />
          </span>
          <div
            className={`relative min-w-0 transition-opacity duration-200 ${
              collapsed ? 'lg:opacity-0' : 'opacity-100'
            }`}
          >
            <p className="truncate text-sm font-bold tracking-wide text-white">
              Concord TrackSync
            </p>
            <p className="truncate text-[11px] text-blue-200">Production Tracking System</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1.5 overflow-y-auto px-3 py-5" aria-label="Main navigation">
          {!collapsed ? (
            <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Menu
            </p>
          ) : null}
          {NAV_ITEMS.map(({ label, href, Icon }) => {
            const isActive = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                onClick={onCloseMobile}
                title={collapsed ? label : undefined}
                aria-current={isActive ? 'page' : undefined}
                className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-all duration-200 ${
                  isActive
                    ? 'bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 text-white shadow-lg shadow-indigo-600/25'
                    : 'text-slate-600 hover:bg-indigo-50 hover:text-indigo-700'
                } ${collapsed ? 'lg:justify-center lg:px-0' : ''}`}
              >
                <Icon
                  className={`h-5 w-5 shrink-0 ${
                    isActive ? 'text-white' : 'text-slate-400 group-hover:text-indigo-600'
                  }`}
                />
                <span className={`truncate transition-opacity duration-200 ${collapsed ? 'lg:hidden' : ''}`}>
                  {label}
                </span>
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="border-t border-slate-100 px-3 py-4 text-center">
          <p className="text-[11px] text-slate-400">
            <span className={collapsed ? 'hidden lg:inline' : 'hidden'}>v1.0</span>
            <span className={collapsed ? 'lg:hidden' : ''}>Concord TrackSync v1.0</span>
          </p>
        </div>
      </aside>
    </>
  );
}