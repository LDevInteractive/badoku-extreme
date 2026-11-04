// Server clock offset and countdown helpers (CLAUDE.md section 5.5).
// All deadlines are server timestamps; clients only display them.

const WINDOW = 5;
const samples = [];
let offsetMs = 0;

/** Feeds one measurement: server_now from a response, t0/t1 local time around the call. */
export function addSample(serverNow, t0, t1) {
  const server = new Date(serverNow).getTime();
  if (!Number.isFinite(server)) return;
  samples.push(server - (t0 + t1) / 2);
  if (samples.length > WINDOW) samples.shift();
  offsetMs = samples.reduce((a, b) => a + b, 0) / samples.length;
}

/** Current time on the server's clock, in ms. */
export function serverNow() {
  return Date.now() + offsetMs;
}

/** Milliseconds until a server timestamp; negative once it has passed. */
export function msUntil(deadline) {
  return new Date(deadline).getTime() - serverNow();
}

/** Formats milliseconds as m:ss, never below 0:00. */
export function formatMmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
