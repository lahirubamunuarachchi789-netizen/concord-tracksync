import { createClient } from '@supabase/supabase-js';

/**
 * Concord TrackSync - Supabase client bootstrap.
 *
 * Configuration is read dynamically from environment variables, with
 * explicit built-in fallbacks so the app still boots when ".env" is
 * absent (e.g., fresh clones). Only publishable (client-safe) values
 * are ever used here - never place secret keys in this file.
 */

const FALLBACK_SUPABASE_URL = 'https://zpfhzpjdrvduisubzlhk.supabase.co';
const FALLBACK_SUPABASE_ANON_KEY = 'sb_publishable_nPjB9DdglN8IHMfx6v8g6g_NxNnyQ5U';

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || FALLBACK_SUPABASE_URL;
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || FALLBACK_SUPABASE_ANON_KEY;

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  // Non-fatal: fallbacks keep development running without a .env file.
  console.warn(
    '[Concord TrackSync] NEXT_PUBLIC_SUPABASE_* env vars are not set - using built-in fallback configuration.'
  );
}

/**
 * Singleton browser client.
 * - persistSession:false     -> we do not use Supabase Auth sessions; login is
 *                               validated against the "Loging Table" table.
 * - detectSessionInUrl:false -> avoids parsing OAuth hash fragments.
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

/** Target table for authentication records (name contains a space, as defined in Supabase). */
export const AUTH_TABLE = 'Loging Table';

