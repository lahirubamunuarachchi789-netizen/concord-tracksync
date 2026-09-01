'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { loginUser, registerUser } from '@/lib/authService';
import { getSession, saveSession } from '@/lib/session';
import AuthInput from './AuthInput';
import BrandPanel from './BrandPanel';
import Notification from './Notification';
import { BuildingIcon, LockIcon, LogoMark, SpinnerIcon, UserIcon } from './icons';

const DEPARTMENTS = [
  'Desma',
  'Cutting',
  'Stitching',
  'Assembly',
  'Quality Control',
  'Warehouse & Logistics',
  'Production Planning',
  'Maintenance',
  'Human Resources',
  'Administration',
  'Management',
];

const SUBMIT_BUTTON_CLASSES =
  'mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition duration-200 hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Split-screen authentication screen:
 *   Left  -> industrial blue-purple gradient brand panel (BrandPanel)
 *   Right -> clean white card with Login / Register forms + toasts
 * Data operations are delegated to lib/authService.js ("Loging Table").
 */
export default function AuthCard() {
  const router = useRouter();
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [department, setDepartment] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  // Auto-dismiss status notifications after 6 seconds.
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  // Already signed in? Skip the login screen entirely.
  useEffect(() => {
    if (getSession()) router.replace('/dashboard');
  }, [router]);

  const notify = useCallback((type, title, message = '') => {
    setToast({ id: Date.now(), type, title, message });
  }, []);

  function switchMode(nextMode) {
    if (nextMode === mode || loading) return;
    setMode(nextMode);
    setPassword('');
    setToast(null);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (loading) return;
    if (mode === 'login') await handleLogin();
    else await handleRegister();
  }

  /** Login Action: query "Loging Table" and validate credentials. */
  async function handleLogin() {
    if (!username.trim() || !password) {
      notify('error', 'Missing details', 'Please enter both your username and password.');
      return;
    }
    setLoading(true);
    const result = await loginUser({ username, password });
    setLoading(false);
    if (result.ok) {
      saveSession(result.user);
      notify(
        'success',
        'Login successful',
        `Welcome back, ${result.user.username}! Taking you to your dashboard...`
      );
      setPassword('');
      // Brief pause so the success state is visible, then enter the shell.
      setTimeout(() => router.push('/dashboard'), 700);
    } else {
      notify('error', 'Login failed', result.message);
    }
  }

  /** Register Action: collect Username / Department / Password and insert. */
  async function handleRegister() {
    const cleanUsername = username.trim();
    if (!cleanUsername || cleanUsername.length < 3) {
      notify('error', 'Invalid username', 'Username must be at least 3 characters long.');
      return;
    }
    if (!department.trim()) {
      notify('error', 'Department required', 'Please enter your department to continue.');
      return;
    }
    if (!password || password.length < 6) {
      notify('error', 'Weak password', 'Password must be at least 6 characters long.');
      return;
    }
    setLoading(true);
    const result = await registerUser({
      username,
      department: department.trim(),
      password,
    });
    setLoading(false);
    if (result.ok) {
      notify(
        'success',
        'Registration successful',
        `Account created for ${cleanUsername} (${department.trim()}). You can now sign in.`
      );
      setMode('login');
      setDepartment('');
      setPassword('');
    } else {
      notify('error', 'Registration failed', result.message);
    }
  }

  const isLogin = mode === 'login';

  return (
    <div className="flex min-h-screen">
      {/* Left side: industrial gradient brand panel */}
      <BrandPanel />

      {/* Right side: clean white card container for auth forms */}
      <main className="flex flex-1 flex-col bg-slate-50">
        {/* Compact brand header for small screens (left panel is hidden there) */}
        <div className="relative overflow-hidden bg-gradient-to-r from-blue-700 via-indigo-700 to-purple-800 px-6 py-8 text-center lg:hidden">
          <div className="absolute inset-0 bg-blueprint-grid bg-[length:30px_30px]" aria-hidden="true" />
          <div className="relative z-10">
            <h1 className="text-2xl font-extrabold text-white">Concord TrackSync</h1>
            <p className="mt-1 text-xs text-blue-100">
              Production Tracking System - Concord Footwear (Pvt) Ltd
            </p>
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
          <div className="w-full max-w-md">
            <Notification toast={toast} onClose={() => setToast(null)} />

            <div className="rounded-3xl bg-white p-7 shadow-2xl shadow-slate-900/10 ring-1 ring-slate-200 sm:p-9">
              {/* Card heading (re-animates when toggling modes) */}
              <div key={`heading-${mode}`} className="animate-fade-slide">
                <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-purple-600 shadow-lg shadow-indigo-600/25">
                  <LogoMark className="h-6 w-6 text-white" />
                </span>
                <h2 className="mt-5 text-2xl font-bold tracking-tight text-slate-900">
                  {isLogin ? 'Welcome back' : 'Create your account'}
                </h2>
                <p className="mt-1.5 text-sm text-slate-500">
                  {isLogin
                    ? 'Sign in to access the production tracking dashboard.'
                    : 'Register your department account to get started with TrackSync.'}
                </p>
              </div>

              {/* Smooth Login / Register toggle with sliding indicator */}
              <div
                className="relative mt-6 grid grid-cols-2 rounded-xl bg-slate-100 p-1"
                role="tablist"
                aria-label="Authentication mode"
              >
                <span
                  aria-hidden="true"
                  className={`absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-lg bg-white shadow-sm ring-1 ring-slate-200 transition-transform duration-300 ease-out ${
                    isLogin ? 'translate-x-0' : 'translate-x-full'
                  }`}
                />
                <button
                  type="button"
                  role="tab"
                  aria-selected={isLogin}
                  onClick={() => switchMode('login')}
                  className={`relative z-10 rounded-lg py-2 text-sm font-semibold transition-colors duration-200 ${
                    isLogin ? 'text-indigo-700' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={!isLogin}
                  onClick={() => switchMode('register')}
                  className={`relative z-10 rounded-lg py-2 text-sm font-semibold transition-colors duration-200 ${
                    !isLogin ? 'text-indigo-700' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  Register
                </button>
              </div>

              {/* Forms — key={mode} re-triggers the fade/slide animation on toggle */}
              <form
                key={`form-${mode}`}
                onSubmit={handleSubmit}
                noValidate
                className="animate-fade-slide mt-7 space-y-5"
              >
                <AuthInput
                  label="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. Lahiru"
                  icon={<UserIcon className="h-5 w-5" />}
                  autoComplete="username"
                  disabled={loading}
                />

                {!isLogin ? (
                  <AuthInput
                    label="Department"
                    as="combo"
                    value={department}
                    onChange={(e) => setDepartment(e.target.value)}
                    placeholder="e.g. Desma, Cutting, Quality Control"
                    options={DEPARTMENTS}
                    icon={<BuildingIcon className="h-5 w-5" />}
                    autoComplete="organization"
                    disabled={loading}
                  />
                ) : null}

                <AuthInput
                  label="Password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isLogin ? 'Enter your password' : 'Minimum 6 characters'}
                  icon={<LockIcon className="h-5 w-5" />}
                  autoComplete={isLogin ? 'current-password' : 'new-password'}
                  disabled={loading}
                />

                <button type="submit" disabled={loading} className={SUBMIT_BUTTON_CLASSES}>
                  {loading ? (
                    <>
                      <SpinnerIcon className="h-4 w-4 animate-spin" />
                      {isLogin ? 'Signing in...' : 'Creating account...'}
                    </>
                  ) : isLogin ? (
                    'Sign In'
                  ) : (
                    'Create Account'
                  )}
                </button>

                <p className="text-center text-sm text-slate-500">
                  {isLogin ? "Don't have an account? " : 'Already registered? '}
                  <button
                    type="button"
                    onClick={() => switchMode(isLogin ? 'register' : 'login')}
                    className="font-semibold text-indigo-600 transition hover:text-indigo-700 hover:underline"
                  >
                    {isLogin ? 'Register here' : 'Sign in here'}
                  </button>
                </p>
              </form>

            </div>

            <p className="mt-6 text-center text-xs text-slate-400">
              Concord TrackSync · Internal production tracking access · © {new Date().getFullYear()}{' '}
              Concord Footwear (Pvt) Ltd
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

