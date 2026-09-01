import { NextResponse } from 'next/server';

/**
 * Route protection for the post-login area.
 *
 * The client stores a short-lived "tracksync_auth" cookie when a login
 * succeeds (see lib/session.js). Requests to the protected sections without
 * that cookie are bounced straight back to the login screen before any
 * protected page is rendered. The client-side AppShell performs the deeper
 * check against the stored user record.
 */
const SESSION_COOKIE = 'tracksync_auth';

export function middleware(request) {
  const hasSession = request.cookies.get(SESSION_COOKIE)?.value === '1';
  if (hasSession) return NextResponse.next();

  const loginUrl = new URL('/', request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    '/home/:path*',
    '/dashboard/:path*',
    '/transactions/:path*',
    '/reports/:path*',
    '/stock/:path*',
  ],
};