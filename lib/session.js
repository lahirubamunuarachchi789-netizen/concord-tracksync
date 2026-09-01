/**
 * Concord TrackSync - lightweight client-side session store.
 *
 * Login is validated against the Supabase "Loging Table" (lib/authService.js),
 * not Supabase Auth, so the signed-in user is persisted in localStorage. A
 * lightweight companion cookie ("tracksync_auth") lets middleware guard the
 * protected routes before any protected page HTML is streamed.
 *
 * NOTE: this is a UX-level gate, not server-side authorization. For hardened
 * security, migrate to Supabase Auth or verify sessions server-side.
 */

const STORAGE_KEY = 'tracksync.session';
export const SESSION_COOKIE = 'tracksync_auth';
const COOKIE_MAX_AGE = 60 * 60 * 12; // 12 hours

function isBrowser() {
  return typeof window !== 'undefined';
}

/** Persist the logged-in user after a successful login. */
export function saveSession(user) {
  if (!isBrowser() || !user?.username) return;
  const session = {
    username: user.username,
    department: user.department || '',
    loginAt: new Date().toISOString(),
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  document.cookie = `${SESSION_COOKIE}=1; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
}

/** Read the current session, or null when signed out / corrupted. */
export function getSession() {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.username) {
      clearSession();
      return null;
    }
    return parsed;
  } catch {
    clearSession();
    return null;
  }
}

/** Remove every client-side trace of the session (logout). */
export function clearSession() {
  if (!isBrowser()) return;
  window.localStorage.removeItem(STORAGE_KEY);
  document.cookie = `${SESSION_COOKIE}=; path=/; max-age=0; samesite=lax`;
}