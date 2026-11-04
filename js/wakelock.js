// Screen Wake Lock helper. The phone lies on the table during a hunt and must
// not go dark (CLAUDE.md section 2.2). Requires HTTPS (or localhost) and a
// user gesture for the first request. Re-acquires the lock automatically when
// the tab becomes visible again.

let sentinel = null;
let wanted = false;
const listeners = new Set();

export function isSupported() {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

export function isActive() {
  return sentinel !== null && !sentinel.released;
}

/** Register a callback that receives the current state ('active' | 'released' | 'unsupported' | 'error'). */
export function onChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function notify(state, detail) {
  for (const cb of listeners) {
    try {
      cb(state, detail);
    } catch (e) {
      console.error('wakelock listener failed', e);
    }
  }
}

async function acquire() {
  if (!isSupported()) {
    notify('unsupported');
    return false;
  }
  if (isActive()) return true;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
      notify('released');
    });
    notify('active');
    return true;
  } catch (e) {
    sentinel = null;
    notify('error', e);
    return false;
  }
}

/** Request the wake lock and keep re-requesting it after tab switches. */
export async function requestWakeLock() {
  wanted = true;
  return acquire();
}

/** Release the lock and stop re-requesting it. */
export async function releaseWakeLock() {
  wanted = false;
  if (sentinel) {
    try {
      await sentinel.release();
    } catch {
      // already released
    }
    sentinel = null;
  }
  notify('released');
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (wanted && document.visibilityState === 'visible') {
      acquire();
    }
  });
}
