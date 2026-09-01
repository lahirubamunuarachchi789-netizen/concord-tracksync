import AppShell from '@/components/AppShell';

/**
 * Protected post-login shell: collapsible sidebar + sticky header + auth gate.
 * Route protection also happens earlier in middleware.js before this renders.
 */
export default function MainLayout({ children }) {
  return <AppShell>{children}</AppShell>;
}