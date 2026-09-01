'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clearSession, getSession } from '@/lib/session';
import DashboardHeader from './DashboardHeader';
import Sidebar from './Sidebar';
import { LogoMark } from './icons';

const SessionContext = createContext(null);

/** Access the signed-in user ({ username, department, loginAt }) inside the shell. */
export function useSession() {
  return useContext(SessionContext);
}

function AuthSplash() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100">
      <span className="flex h-14 w-14 animate-pulse items-center justify-center rounded-2xl bg-gradient-to-br from-blue-700 via-indigo-700 to-purple-800 shadow-lg shadow-indigo-600/30">
        <LogoMark className="h-7 w-7 text-white" />
      </span>
      <p className="text-sm font-medium text-slate-500">Loading your workspace...</p>
    </div>
  );
}

/**
 * Post-login application shell: auth gate + collapsible sidebar + top header.
 * Children (the routed page) render inside the main content column.
 */
export default function AppShell({ children }) {
  const router = useRouter();
  const [status, setStatus] = useState('checking'); // 'checking' | 'authed'
  const [user, setUser] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Auth gate: verify the local session on mount, otherwise bounce to login.
  useEffect(() => {
    const session = getSession();
    if (session?.username) {
      setUser(session);
      setStatus('authed');
    } else {
      router.replace('/');
    }
  }, [router]);

  // Restore the sidebar collapse preference.
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem('tracksync.sidebarCollapsed') === '1');
    } catch {
      /* ignore storage errors */
    }
  }, []);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileOpen]);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      try {
        window.localStorage.setItem('tracksync.sidebarCollapsed', prev ? '0' : '1');
      } catch {
        /* ignore storage errors */
      }
      return !prev;
    });
  }

  function handleLogout() {
    clearSession();
    router.replace('/');
  }

  if (status !== 'authed') return <AuthSplash />;

  return (
    <SessionContext.Provider value={user}>
      <div className="min-h-screen bg-slate-100">
        <Sidebar
          collapsed={collapsed}
          mobileOpen={mobileOpen}
          onCloseMobile={() => setMobileOpen(false)}
        />
        <div
          className={`flex min-h-screen flex-col transition-all duration-300 ${
            collapsed ? 'lg:ml-20' : 'lg:ml-72'
          }`}
        >
          <DashboardHeader
            user={user}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapsed}
            onOpenMobile={() => setMobileOpen(true)}
            onLogout={handleLogout}
          />
          <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
          <footer className="px-4 pb-6 text-center text-xs text-slate-400 sm:px-6 lg:px-8">
            Concord TrackSync · Production Tracking System · © {new Date().getFullYear()} Concord
            Footwear (Pvt) Ltd
          </footer>
        </div>
      </div>
    </SessionContext.Provider>
  );
}