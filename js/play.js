// Phone view: joining, lobby and the Sudoku round (CLAUDE.md section 9.2). The token
// stays on this device; a reload finds the player again through get_state.

import { ApiError, rpc } from './api.js';
import { startSync } from './sync.js';
import { msUntil, serverNow, updateCountdowns } from './clock.js';
import { gridHtml, isFxRunning } from './grid.js';
import * as wakelock from './wakelock.js';
import { $, esc, setConn, storeGet, storeRemove, storeSet, withBusy } from './util.js';

const TICK_FALLBACK_MS = 5000;
const UI_TICK_MS = 250;
const FLASH_MS = 520;
const NET_MESSAGE_MS = 2500;
const VIBRATE_ERROR_MS = 120;
const CODE_RE = /^[0-9]{4}$/;
const KEYPAD_COLUMNS = { 4: 4, 6: 3, 9: 5 };
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
let screen = null; // 'join' | 'lobby' | 'round' | 'ended' | 'other'
let drawnKey = '';
let lastState = null;
let chosenColor = null;
let token = null;
let wakeArmed = false;

// Round state that only lives on this device.
let sel = -1;
let flash = -1;
let busy = false;
let netMessage = '';
let optimisticRound = null;
const optimistic = new Map(); // correct entries the next snapshot will confirm

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
    drawPlayer(state);
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

function drawPlayer(state) {
  armWakeLock();
  const { phase } = state.game;
  if (phase === 'lobby') renderLobby(state);
  else if (state.round && phase === 'round_running') renderRound(state);
  // The last line's effect still plays out before the screen changes.
  else if (state.round && phase === 'round_ending') (isFxRunning(state) ? renderRound(state) : renderEnded(state));
  else renderOther(state);
}

// Redraws only when the content changed: a redraw would restart nothing, but it would
// replace the button under a finger.
function draw(name, key, html) {
  const full = `${name}|${key}`;
  if (screen === name && drawnKey === full) return false;
  screen = name;
  drawnKey = full;
  $('phone').innerHTML = html();
  return true;
}

// ---------- Join ----------
function renderJoin(code = '') {
  screen = 'join';
  drawnKey = '';
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
  const active = wakelock.isActive();
  draw('lobby', `${active}|${players.map((p) => p.id).join()}`, () => `<div class="ph-pad">
    <h1 class="ph-title">Warte auf den Start</h1>
    ${active
      ? '<p class="small wake-ok">✓ Der Bildschirm bleibt an.</p>'
      : '<p class="dim">Tippe einmal auf den Bildschirm, damit er während der Jagd anbleibt.</p>'}
    <ul class="plist">${players.map((p) => `<li><span class="sw" style="--c:${esc(p.color)}"></span><strong>${esc(p.name)}</strong>${p.id === me.player_id ? '<span class="faint">du</span>' : ''}</li>`).join('')}</ul>
  </div>`);
}

// ---------- Round ----------
function entriesOf(state) {
  if (optimisticRound !== state.round.id) {
    optimistic.clear();
    optimisticRound = state.round.id;
    sel = -1;
  }
  const map = new Map(state.me.entries.map((e) => [e.cell, String(e.digit)]));
  optimistic.forEach((digit, cell) => map.set(cell, String(digit)));
  return map;
}

function errorCount(state) {
  const { err_window_count: count, err_window_started_at: started } = state.me;
  if (!count || !started) return 0;
  const age = serverNow() - new Date(started).getTime();
  return age > state.game.config.error_window_s * 1000 ? 0 : count;
}

const lockedUntil = (state) => {
  const until = state.me.locked_until;
  return until && msUntil(until) > 0 ? until : null;
};

function renderRound(state) {
  const { game, round, players, me } = state;
  const entries = entriesOf(state);
  if (sel >= 0 && (round.revealed[sel] !== '0' || entries.has(sel))) sel = -1;
  const locked = lockedUntil(state);
  const errors = errorCount(state);
  const mine = players.find((p) => p.id === me.player_id);
  const key = [round.id, round.revealed, state.lines.length, entries.size, sel, flash, locked, errors, game.balloons_left, mine.lines_claimed, netMessage, game.phase].join('|');
  const drawn = draw('round', key, () => {
    const n = round.size;
    const counts = new Map();
    for (let c = 0; c < n * n; c++) {
      const digit = round.revealed[c] !== '0' ? round.revealed[c] : entries.get(c);
      if (digit) counts.set(digit, (counts.get(digit) || 0) + 1);
    }
    const keys = [];
    for (let d = 1; d <= n; d++) {
      keys.push(`<button data-digit="${d}" class="${(counts.get(String(d)) || 0) >= n ? 'done' : ''}" type="button">${d}</button>`);
    }
    const stat = (value, label) => `<div class="ph-stat"><b>${value}</b><span>${label}</span></div>`;
    const roundTimer = game.phase === 'round_running' ? `<span data-cd="${new Date(round.deadline).getTime()}"></span>` : '–';
    return `<div class="ph-head">${stat(roundTimer, 'Runde')}${stat(esc(game.balloons_left), 'Ballone')}${stat(esc(mine.lines_claimed), 'Linien')}</div>
      <div class="ph-sub"><span>${netMessage ? esc(netMessage) : `Runde ${esc(round.round_no)}`}</span>
        <span class="err-dots" aria-label="${errors} Fehler">${Array.from({ length: game.config.error_max }, (_, k) => `<i class="${k < errors ? 'on' : ''}"></i>`).join('')}</span></div>
      <div class="ph-grid" style="--n:${n}">${gridHtml(state, { phone: true, entries, sel, flash, meColor: me.color })}</div>
      <div class="keypad" style="grid-template-columns:repeat(${KEYPAD_COLUMNS[n]},1fr)">${keys.join('')}</div>
      ${locked ? `<div class="overlay ov-lock"><p class="label">Gesperrt</p><div class="ph-big"><span data-cd="${new Date(locked).getTime()}" data-fmt="s"></span></div><h1 class="ph-title">${esc(game.config.error_max)} Fehler in ${esc(game.config.error_window_s)} Sekunden</h1><p class="dim">Danach geht es normal weiter.</p></div>` : ''}`;
  });
  if (drawn) updateCountdowns($('phone'));
}

function showNetMessage() {
  netMessage = ERRORS.network;
  setTimeout(() => {
    netMessage = '';
    redraw();
  }, NET_MESSAGE_MS);
}

function redraw() {
  if (lastState?.me) drawPlayer(lastState);
}

function onCellTap(idx) {
  const state = lastState;
  if (!state?.round || state.game.phase !== 'round_running' || lockedUntil(state)) return;
  if (state.round.revealed[idx] !== '0' || entriesOf(state).has(idx)) return;
  sel = idx;
  redraw();
}

async function onDigitTap(digit) {
  const state = lastState;
  if (busy || sel < 0 || !state?.round || lockedUntil(state)) return;
  const cell = sel;
  busy = true;
  try {
    const r = await rpc('enter_digit', { p_code: syncedCode, p_token: token, p_cell: cell, p_digit: digit });
    const { me } = lastState;
    if (r.ok && r.result === 'correct') {
      optimistic.set(cell, digit);
      sel = -1;
    } else if (r.ok && r.result === 'wrong') {
      flash = cell;
      setTimeout(() => {
        flash = -1;
        redraw();
      }, FLASH_MS);
      navigator.vibrate?.(VIBRATE_ERROR_MS);
      me.err_window_count = r.error_count;
      if (r.error_count === 1) me.err_window_started_at = new Date(serverNow()).toISOString();
      me.locked_until = r.locked_until;
      if (r.locked_until) sel = -1;
    } else if (r.reason === 'locked') {
      me.locked_until = r.locked_until;
      sel = -1;
    } else if (r.reason === 'filled') {
      sel = -1;
    }
  } catch (e) {
    console.warn(e);
    showNetMessage();
  } finally {
    busy = false;
  }
  redraw();
}

function renderEnded() {
  draw('ended', '', () => `<div class="ph-pad ph-center">
    <h1 class="ph-title">Runde beendet</h1>
    <p class="dim">Warte auf laufende Jagden.</p>
  </div>`);
}

function renderOther({ game }) {
  draw('other', game.phase, () => `<div class="ph-pad ph-center">
    <h1 class="ph-title">Spiel ${esc(game.code)} läuft</h1>
    <p class="dim">Diese Ansicht folgt mit den nächsten Meilensteinen.</p>
  </div>`);
}

// The first tap after joining switches the wake lock on (CLAUDE.md 2.2); a browser
// only allows that inside a user gesture.
function armWakeLock() {
  if (wakeArmed) return;
  wakeArmed = true;
  document.addEventListener('pointerdown', () => wakelock.requestWakeLock(), { once: true });
  wakelock.onChange(redraw);
}

// ---------- Boot ----------
$('phone').addEventListener('click', (e) => {
  const cell = e.target.closest('[data-cell]');
  if (cell) {
    onCellTap(Number(cell.dataset.cell));
    return;
  }
  const digit = e.target.closest('[data-digit]');
  if (digit) onDigitTap(Number(digit.dataset.digit));
});

// Time passes without a new snapshot: countdowns, lock end, error window, end of an effect.
setInterval(() => {
  redraw();
  updateCountdowns($('phone'));
}, UI_TICK_MS);

const fromUrl = new URLSearchParams(location.search).get('g') || '';
renderJoin(CODE_RE.test(fromUrl) ? fromUrl : '');
if (CODE_RE.test(fromUrl)) connect(fromUrl);
