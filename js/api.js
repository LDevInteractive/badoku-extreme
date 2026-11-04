// RPC wrapper around supabase-js. Every server call in the app goes through
// rpc() so errors are handled in one place (CLAUDE.md section 9.1).
// vendor/supabase.js (UMD) must be loaded before this module; it provides
// window.supabase.

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

const PLACEHOLDER_URL = /DEIN-PROJEKT/;
const PLACEHOLDER_KEY = /HIER_EINTRAGEN/;

/** True when config.js has been filled in with a real project. */
export function isConfigured() {
  return (
    /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SUPABASE_URL) &&
    !PLACEHOLDER_URL.test(SUPABASE_URL) &&
    SUPABASE_PUBLISHABLE_KEY.length > 20 &&
    !PLACEHOLDER_KEY.test(SUPABASE_PUBLISHABLE_KEY)
  );
}

let client = null;

/** Lazily creates the single supabase client of this page. */
export function getClient() {
  if (client) return client;
  if (!window.supabase) {
    throw new ApiError('vendor/supabase.js wurde nicht geladen');
  }
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return client;
}

export class ApiError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ApiError';
    this.cause = cause;
  }
}

/**
 * Calls a Postgres function. Resolves with its jsonb result.
 * Expected refusals ({ok:false, reason}) are returned, not thrown;
 * transport/SQL errors are thrown as ApiError.
 */
export async function rpc(name, params = {}) {
  const { data, error } = await getClient().rpc(name, params);
  if (error) {
    throw new ApiError(`${name}: ${error.message}`, error);
  }
  return data;
}

/**
 * Calls server_time() and measures the round trip.
 * Returns { serverNow: Date, roundTripMs, offsetMs } where
 * offsetMs = serverNow - localMidpoint (CLAUDE.md section 5.5).
 */
export async function measureServerTime() {
  const t0 = Date.now();
  const data = await rpc('server_time');
  const t1 = Date.now();
  const serverNow = new Date(data.server_now);
  return {
    serverNow,
    roundTripMs: t1 - t0,
    offsetMs: serverNow.getTime() - (t0 + t1) / 2,
  };
}
