// Small shared helpers: HTML escaping, safe localStorage, connection indicator.

export const $ = (id) => document.getElementById(id);

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// localStorage can throw (private mode, blocked storage); fall back to memory (CLAUDE.md 9.4).
const memory = new Map();

export function storeGet(key) {
  try {
    const value = localStorage.getItem(key);
    if (value !== null) return value;
  } catch {
    // fall through to memory
  }
  return memory.has(key) ? memory.get(key) : null;
}

export function storeSet(key, value) {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    // memory copy is enough for this session
  }
}

export function storeRemove(key) {
  memory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // nothing to do
  }
}

const CONN_TEXT = { ok: 'verbunden', warn: 'verbinde …', error: 'getrennt' };

/** Updates the corner indicator (CLAUDE.md 9.4). */
export function setConn(state) {
  const dot = $('conn-dot');
  if (dot) dot.dataset.state = state;
  const text = $('conn-text');
  if (text) text.textContent = CONN_TEXT[state] || '';
}

/** Runs an async action with the button disabled until it answers (CLAUDE.md 9.4). */
export async function withBusy(button, action) {
  button.disabled = true;
  try {
    return await action();
  } finally {
    button.disabled = false;
  }
}
