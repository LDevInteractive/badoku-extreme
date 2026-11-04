// Phone view: joining and the lobby (CLAUDE.md section 9.2). The token stays on
// this device; a reload finds the player again through get_state.

import { ApiError, rpc } from './api.js';
import { startSync } from './sync.js';
import * as wakelock from './wakelock.js';
import { $, esc, setConn, storeGet, storeRemove, storeSet, withBusy } from './util.js';

const TICK_FALLBACK_MS = 5000;
const CODE_RE = /^[0-9]{4}$/;
const tokenKey = (code) => `badoku.token.${code}`;
const NAME_KEY = 'badoku.name';

const ERRORS = {
  not_found: 'Dieses Spiel gibt es nicht. Stimmt der Code?',
  wrong_phase: 'Das Spiel läuft schon, Beitreten geht nur in der Lobby.',
  name_invalid: 'Bitte einen Namen mit höchstens 16 Zeichen eingeben.',
  name_taken: 'Dieser Name ist schon vergeben.',
  color_invalid: 'Bitte eine Farbe wählen.',
  color_taken: 'Diese Farbe ist gerade vergeben worden.',
  full: 'Das Spiel ist schon voll.',
  network: 'Keine Verbindung zum Server, bitte nochmals versuchen.',
};

let sync = null;
let tickTimer = null;
let syncedCode = null;
let screen = null; // 'join' | 'lobby' | 'running'
let lastState = null;
let chosenColor = null;
let token = null;
let wakeArmed = false;

// ---------- Connection to one game ----------
function connect(code) {
  if (syncedCode === code) return;
  disconnect();
  syncedCode = code;
  token = storeGet(tokenKey(code));
  $('conn').hidden = false;
  setConn('warn');
  sync = startSync({
    code,
    token,
    onState,
    onConn: setConn,
    onGone: () => onGameMissing(code),
  });
  tickTimer = setInterval(() => {
    rpc('tick', { p_code: code }).catch((e) => console.warn('tick failed', e));
  }, TICK_FALLBACK_MS);
}

function disconnect() {
  sync?.stop();
  clearInterval(tickTimer);
  sync = null;
  syncedCode = null;
  lastState = null;
  $('conn').hidden = true;
}

function onGameMissing(code) {
  storeRemove(tokenKey(code));
  disconnect();
  token = null;
  if (screen !== 'join') renderJoin(code);
  paintColors();
  $('join-err').textContent = ERRORS.not_found;
}

function onState(state) {
  lastState = state;
  if (state.me) {
    if (state.game.phase === 'lobby') renderLobby(state);
    else renderRunning(state);
    return;
  }
  // A token that does not fit this game is useless, forget it.
  if (token) {
    storeRemove(tokenKey(state.game.code));
    token = null;
  }
  if (screen !== 'join') renderJoin(state.game.code);
  paintColors();
  // Updates arrive all the time, they must not wipe a refusal the player still has to read.
  const err = $('join-err');
  if (state.game.phase !== 'lobby') err.textContent = ERRORS.wrong_phase;
  else if (err.textContent === ERRORS.wrong_phase) err.textContent = '';
}

// ---------- Join ----------
function renderJoin(code = '') {
  screen = 'join';
  $('phone').innerHTML = `<form class="ph-pad" id="join" autocomplete="off">
    <h1 class="ph-title">Mitspielen</h1>
    <div class="field"><label class="label" for="j-code">Spielcode</label>
      <input class="input mono" id="j-code" value="${esc(code)}" inputmode="numeric" maxlength="4" autocomplete="off"></div>
    <div class="field"><label class="label" for="j-name">Name (max. 16 Zeichen)</label>
      <input class="input" id="j-name" maxlength="16" value="${esc(storeGet(NAME_KEY) || '')}" autocomplete="off" autocapitalize="words"></div>
    <div class="field"><span class="label">Farbe</span><div class="colors" id="colors"></div></div>
    <p class="form-err" id="join-err" role="alert"></p>
    <button class="btn btn-primary btn-big btn-block join-submit" id="join-go" type="submit">Beitreten</button>
  </form>`;
  $('j-code').addEventListener('input', onCodeInput);
  $('colors').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-color]');
    if (!btn || btn.disabled) return;
    chosenColor = btn.dataset.color;
    paintColors();
  });
  $('join').addEventListener('submit', onJoin);
  paintColors();
}

function onCodeInput() {
  const value = $('j-code').value.trim();
  $('join-err').textContent = '';
  if (CODE_RE.test(value)) {
    connect(value);
  } else {
    disconnect();
    paintColors();
  }
}

// Only the colour buttons are redrawn, so typing in the fields is never disturbed.
function paintColors() {
  const box = $('colors');
  if (!box) return;
  if (!lastState) {
    box.innerHTML = '<p class="small faint" style="grid-column:1/-1">Die Farben erscheinen, sobald der Spielcode stimmt.</p>';
    return;
  }
  const { palette, players, game } = lastState;
  const usable = palette.filter((c) => !c.test_only || game.config.max_players >= 8);
  const taken = new Map(players.map((p) => [p.color, p.name]));
  if (chosenColor && taken.has(chosenColor)) chosenColor = null;
  box.innerHTML = usable.map((c) => {
    const owner = taken.get(c.color);
    return `<button class="color-btn" type="button" style="--c:${esc(c.color)};--ink:${esc(c.ink)}" data-color="${esc(c.color)}" aria-label="${esc(c.name)}" aria-pressed="${chosenColor === c.color}" ${owner ? 'disabled' : ''}>${owner ? esc(owner) : ''}</button>`;
  }).join('');
}

async function onJoin(e) {
  e.preventDefault();
  const code = $('j-code').value.trim();
  const name = $('j-name').value.trim();
  const fail = (reason) => {
    $('join-err').textContent = ERRORS[reason] || ERRORS.network;
  };
  if (!CODE_RE.test(code)) return fail('not_found');
  if (!name) return fail('name_invalid');
  if (!chosenColor) return fail('color_invalid');
  storeSet(NAME_KEY, name);
  await withBusy($('join-go'), async () => {
    try {
      const r = await rpc('join_game', { p_code: code, p_name: name, p_color: chosenColor });
      if (!r.ok) {
        fail(r.reason);
        sync?.refresh();
        return;
      }
      token = r.token;
      storeSet(tokenKey(code), token);
      connect(code);
      await sync.setToken(token);
    } catch (err) {
      if (!(err instanceof ApiError)) console.warn(err);
      fail('network');
    }
  });
}

// ---------- Lobby ----------
function renderLobby({ me, players }) {
  screen = 'lobby';
  armWakeLock();
  const wakeText = wakelock.isActive()
    ? '<p class="small wake-ok">✓ Der Bildschirm bleibt an.</p>'
    : '<p class="dim">Tippe einmal auf den Bildschirm, damit er während der Jagd anbleibt.</p>';
  $('phone').innerHTML = `<div class="ph-pad">
    <h1 class="ph-title">Warte auf den Start</h1>
    ${wakeText}
    <ul class="plist">${players.map((p) => `<li><span class="sw" style="--c:${esc(p.color)}"></span><strong>${esc(p.name)}</strong>${p.id === me.player_id ? '<span class="faint">du</span>' : ''}</li>`).join('')}</ul>
  </div>`;
}

function renderRunning({ game }) {
  screen = 'running';
  armWakeLock();
  $('phone').innerHTML = `<div class="ph-pad ph-center">
    <h1 class="ph-title">Spiel ${esc(game.code)} läuft</h1>
    <p class="dim">Diese Ansicht folgt mit den nächsten Meilensteinen.</p>
  </div>`;
}

// The first tap after joining switches the wake lock on (CLAUDE.md 2.2); a browser
// only allows that inside a user gesture.
function armWakeLock() {
  if (wakeArmed) return;
  wakeArmed = true;
  document.addEventListener('pointerdown', () => wakelock.requestWakeLock(), { once: true });
  wakelock.onChange(() => {
    if (lastState?.me && screen === 'lobby') renderLobby(lastState);
  });
}

// ---------- Boot ----------
const fromUrl = new URLSearchParams(location.search).get('g') || '';
renderJoin(CODE_RE.test(fromUrl) ? fromUrl : '');
if (CODE_RE.test(fromUrl)) connect(fromUrl);
