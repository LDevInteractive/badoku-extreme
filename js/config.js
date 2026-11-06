// Public Supabase project settings for Badoku-Extreme.
// The publishable key (formerly "anon key") is meant to be public; it is
// protected by RLS and by the RPC-only access model (CLAUDE.md section 5.2).
// The service_role key must NEVER appear here or anywhere in this repo.

export const SUPABASE_URL = 'https://jcdfuixhottekfwktmis.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_E_QoyQG9Ekkmch8AZH0YUw_VMyAQg5T';

export const APP_VERSION = '0.8.0-balloons';

// Hunt screen on the phone (CLAUDE.md section 9.2): how long the outcome stays, vibration at the start.
export const HUNT_RESULT_MS = 2000;
export const HUNT_VIBRATE = [250, 120, 250];

// Line reveal effect, all times in ms (CLAUDE.md section 9.5). step = delay per cell
// away from the completing cell, lead = time until the first balloon pops, cell = one
// cell's animation, tail = afterglow of the line, name* = the solver's name.
export const REVEAL_FX = {
  balloon: { step: 95, lead: 430, cell: 460, tail: 560, nameDelay: 300, nameDur: 1500 },
  neutral: { step: 26, lead: 0, cell: 520, tail: 0, nameDelay: 0, nameDur: 0 },
  shardsPerBalloon: 7,
};
