import { createClient } from '@supabase/supabase-js';

/**
 * Concord TrackSync - Supabase client bootstrap.
 *
 * Configuration is read dynamically from environment variables so no
 * credentials are ever hard-coded into the source code. Values placed in
 * the root ".env" file (git-ignored) are injected by Next.js at
 * build/run time because of their NEXT_PUBLIC_ prefix.
 */

const SUPABASE_URL_VAR = 'NEXT_PUBLIC_SUPABASE_URL';
const SUPABASE_ANON_KEY_VAR = 'NEXT_PUBLIC_SUPABASE_ANON_KEY';

function readRequiredConfig(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `[Concord TrackSync] Missing required configuration "${name}". ` +
        'Add it to the root .env file (see .env.example) and restart the dev server.'
    );
  }
  return value.trim();
}

function parseValidUrl(rawUrl, varName) {
  try {
    return new URL(rawUrl);
  } catch {
    throw new Error(
      `[Concord TrackSync] ${varName} is not a valid URL: "${rawUrl}".`
    );
  }
}

const supabaseUrl = readRequiredConfig(SUPABASE_URL_VAR);
const parsedUrl = parseValidUrl(supabaseUrl, SUPABASE_URL_VAR);
const supabaseAnonKey = readRequiredConfig(SUPABASE_ANON_KEY_VAR);

if (!parsedUrl.hostname.toLowerCase().endsWith('supabase.co')) {
  // Non-fatal: allows local emulators / self-hosted instances.
  console.warn(
    '[Concord TrackSync] Supabase URL does not look like a hosted supabase.co project. Continuing anyway.'
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
