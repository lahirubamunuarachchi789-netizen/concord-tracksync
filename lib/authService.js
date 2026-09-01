import { supabase, AUTH_TABLE } from './supabaseClient';

/**
 * Data-access helpers for the "Loging Table" authentication records.
 * Kept separate from the UI so forms only deal with plain results:
 *   { ok: boolean, message?: string, user?: { username, department } }
 */

function describeSupabaseError(error) {
  const message = error?.message || 'Unexpected database error.';
  if (/row-level security|permission denied/i.test(message)) {
    return (
      'Database access was blocked by Row Level Security (RLS). Ask your administrator to add the ' +
      'insert/select policies for "Loging Table" (see supabase/schema.sql).'
    );
  }
  if (/relation|does not exist|schema cache/i.test(message)) {
    return (
      'The "Loging Table" table was not found in the connected Supabase project. ' +
      'Run the SQL in supabase/schema.sql first.'
    );
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return (
      'Unable to reach the Supabase service. Check your internet connection and the ' +
      'NEXT_PUBLIC_SUPABASE_URL value.'
    );
  }
  if (/invalid api key|jwt/i.test(message)) {
    return 'Supabase rejected the API key. Verify NEXT_PUBLIC_SUPABASE_ANON_KEY in your .env file.';
  }
  return message;
}

/**
 * Login: query "Loging Table" and validate the username/password pair.
 */
export async function loginUser({ username, password }) {
  const cleanUsername = username.trim();

  const { data, error } = await supabase
    .from(AUTH_TABLE)
    .select('Username, Department')
    .eq('Username', cleanUsername)
    .eq('Password', password)
    .limit(1);

  if (error) return { ok: false, message: describeSupabaseError(error) };

  const user = Array.isArray(data) ? data[0] : null;
  if (!user) {
    return {
      ok: false,
      message:
        'Invalid username or password. Please check your credentials and try again.',
    };
  }
  return {
    ok: true,
    user: { username: user.Username, department: user.Department },
  };
}

/**
 * Register: prevent duplicates, then insert Username / Department / Password.
 */
export async function registerUser({ username, department, password }) {
  const cleanUsername = username.trim();

  const { data: existing, error: checkError } = await supabase
    .from(AUTH_TABLE)
    .select('Username')
    .eq('Username', cleanUsername)
    .maybeSingle();

  if (checkError) return { ok: false, message: describeSupabaseError(checkError) };
  if (existing) {
    return {
      ok: false,
      message: `The username "${cleanUsername}" is already registered. Please choose a different username.`,
    };
  }

  const { error: insertError } = await supabase.from(AUTH_TABLE).insert({
    Username: cleanUsername,
    Department: department,
    Password: password,
  });

  if (insertError) return { ok: false, message: describeSupabaseError(insertError) };
  return { ok: true };
}
