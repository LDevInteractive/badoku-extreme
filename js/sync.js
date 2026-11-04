// Keeps a view on the latest snapshot (CLAUDE.md section 5.1).
// Realtime only signals "the version changed", then the full state is fetched,
// debounced. While the channel is not SUBSCRIBED, the state is polled instead.

import { getClient, rpc } from './api.js';
import { addSample } from './clock.js';

const DEBOUNCE_MS = 100;
const POLL_MS = 2000;
const SUBSCRIBED = 'SUBSCRIBED';

/**
 * @param code  game code
 * @param token player token or null (TV)
 * @param onState called with every new snapshot, in order
 * @param onConn  called with 'ok' | 'warn' | 'error' for the connection indicator
 * @param onGone  called when the game does not exist (any more)
 * @returns { refresh, setToken, stop }
 */
export function startSync({ code, token = null, onState, onConn, onGone }) {
  let currentToken = token;
  let stopped = false;
  let channel = null;
  let channelState = 'CLOSED';
  let gameId = null;
  let lastVersion = -1;
  let requestNo = 0;
  let appliedNo = 0;
  let debounce = null;
  let lastFetchFailed = false;

  const reportConn = () => {
    if (stopped) return;
    if (lastFetchFailed) onConn?.('error');
    else onConn?.(channelState === SUBSCRIBED ? 'ok' : 'warn');
  };

  async function fetchState() {
    if (stopped) return;
    const no = ++requestNo;
    const sentToken = currentToken;
    const t0 = Date.now();
    let state;
    try {
      state = await rpc('get_state', { p_code: code, p_token: sentToken });
      lastFetchFailed = false;
    } catch (e) {
      console.warn('get_state failed', e);
      lastFetchFailed = true;
      reportConn();
      return;
    }
    const t1 = Date.now();
    // An answer from before joining must not count as "this token is invalid".
    if (stopped || no < appliedNo || sentToken !== currentToken) return;
    appliedNo = no;
    if (!state.ok) {
      if (state.reason === 'not_found') onGone?.();
      return;
    }
    addSample(state.server_now, t0, t1);
    lastVersion = state.game.version;
    if (!gameId) {
      gameId = state.game.id;
      subscribe();
    }
    reportConn();
    onState(state);
  }

  function scheduleFetch() {
    clearTimeout(debounce);
    debounce = setTimeout(fetchState, DEBOUNCE_MS);
  }

  function subscribe() {
    channel = getClient()
      .channel(`game-${gameId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gameId}` }, (payload) => {
        if (payload.new?.version !== lastVersion) scheduleFetch();
      })
      .subscribe((status) => {
        const wasLive = channelState === SUBSCRIBED;
        channelState = status;
        // Changes may have been missed while the channel was down.
        if (status === SUBSCRIBED && !wasLive) scheduleFetch();
        reportConn();
      });
  }

  const pollTimer = setInterval(() => {
    if (channelState !== SUBSCRIBED) fetchState();
  }, POLL_MS);

  const onVisible = () => {
    if (document.visibilityState === 'visible') fetchState();
  };
  document.addEventListener('visibilitychange', onVisible);

  fetchState();

  return {
    refresh: fetchState,
    setToken(next) {
      currentToken = next;
      return fetchState();
    },
    stop() {
      stopped = true;
      clearTimeout(debounce);
      clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', onVisible);
      if (channel) getClient().removeChannel(channel);
    },
  };
}
