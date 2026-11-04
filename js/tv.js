// TV view: creates or reconnects to a game, shows lobby and round, drives the tick
// (CLAUDE.md sections 5.4 and 9.3). The screen is rebuilt from get_state only.

import { rpc } from './api.js';
import { startSync } from './sync.js';
import { updateCountdowns } from './clock.js';
import { gridHtml } from './grid.js';
import { qrSvg } from './qr.js';
import { $, esc, setConn, storeGet, storeRemove, storeSet, withBusy } from './util.js';

const STAGE_W = 1920;
const STAGE_H = 1080;
const TICK_MS = 1000;
const COUNTDOWN_MS = 250;
const CODE_KEY = 'badoku.tv.code';
const TICKER_LINES = 5;

const ERRORS = {
  bad_pin: 'Die PIN muss 4 bis 6 Ziffern haben.',
  wrong_pin: 'Die PIN stimmt nicht.',
  not_found: 'Dieses Spiel gibt es nicht.',
  bad_config: 'Die Einstellungen sind ungültig.',
  no_free_code: 'Kein freier Spielcode gefunden, bitte nochmals versuchen.',
  too_few_players: 'Es braucht mindestens 2 Spieler.',
  no_puzzle: 'Im Rätsel-Pool ist kein passendes Rätsel mehr.',
  network: 'Keine Verbindung zum Server, bitte nochmals versuchen.',
};

let sync = null;
let tickTimer = null;
let countdownTimer = null;
let code = null;
let hostPin = null; // kept in memory only (CLAUDE.md 9.3)
let qrFor = null;
let qrMarkup = '';
let difficulty = 'leicht';
let screen = null;
let gridKey = '';

function fitStage() {
  const scale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
  const x = (window.innerWidth - STAGE_W * scale) / 2;
  const y = (window.innerHeight - STAGE_H * scale) / 2;
  $('tv').style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
}

// ---------- Start ----------
function renderStart(message = '') {
  screen = 'start';
  $('conn').hidden = true;
  $('tv').innerHTML = `<div class="tv-center">
    <h1 class="brand tv-start-brand">Badoku<span class="brand-accent">-Extreme</span></h1>
    <p class="dim">Ein Sudoku, sieben Handys, 35 Ballone.</p>
    <div class="tv-start">
      <div class="tv-panel"><form id="f-new" autocomplete="off">
        <h2 class="tv-title">Neues Spiel</h2>
        <div class="tv-field"><label class="tv-label" for="new-pin">Host-PIN (4 bis 6 Ziffern)</label>
          <input class="input tv-pin" id="new-pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></div>
        <div class="tv-field"><span class="tv-label">Schwierigkeit</span>
          <div class="tv-seg" id="difficulty">
            <button class="btn" type="button" data-difficulty="leicht">leicht</button>
            <button class="btn" type="button" data-difficulty="mittel">mittel</button>
          </div></div>
        <button class="btn btn-primary tv-submit" id="new-go" type="submit">Spiel erstellen</button>
      </form></div>
      <div class="tv-panel"><form id="f-join" autocomplete="off">
        <h2 class="tv-title">Verbinden</h2>
        <div class="tv-field"><label class="tv-label" for="join-code">Spielcode</label>
          <input class="input mono" id="join-code" inputmode="numeric" maxlength="4" autocomplete="off"></div>
        <div class="tv-field"><label class="tv-label" for="join-pin">Host-PIN</label>
          <input class="input tv-pin" id="join-pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></div>
        <button class="btn tv-submit" id="join-go" type="submit">Verbinden</button>
      </form></div>
    </div>
    <p class="tv-err" id="start-err" role="alert">${esc(message)}</p>
  </div>`;
  paintDifficulty();
  $('difficulty').addEventListener('click', (e) => {
    const value = e.target.closest('[data-difficulty]')?.dataset.difficulty;
    if (value) {
      difficulty = value;
      paintDifficulty();
    }
  });
  $('f-new').addEventListener('submit', onCreate);
  $('f-join').addEventListener('submit', onConnect);
  $('new-pin').focus();
}

function paintDifficulty() {
  document.querySelectorAll('[data-difficulty]').forEach((b) => {
    b.classList.toggle('btn-primary', b.dataset.difficulty === difficulty);
  });
}

const startError = (reason) => {
  $('start-err').textContent = ERRORS[reason] || ERRORS.network;
};

async function onCreate(e) {
  e.preventDefault();
  const pin = $('new-pin').value.trim();
  await withBusy($('new-go'), async () => {
    try {
      const r = await rpc('create_game', { p_pin: pin, p_config: { difficulty } });
      if (!r.ok) return startError(r.reason);
      hostPin = pin;
      openGame(r.code);
    } catch (err) {
      console.warn(err);
      startError('network');
    }
  });
}

async function onConnect(e) {
  e.preventDefault();
  const wanted = $('join-code').value.trim();
  const pin = $('join-pin').value.trim();
  await withBusy($('join-go'), async () => {
    try {
      const r = await rpc('host_check', { p_code: wanted, p_pin: pin });
      if (!r.ok) return startError(r.reason === 'bad_pin' ? 'wrong_pin' : r.reason);
      hostPin = pin;
      openGame(wanted);
    } catch (err) {
      console.warn(err);
      startError('network');
    }
  });
}

// ---------- Game ----------
function openGame(nextCode) {
  code = nextCode;
  storeSet(CODE_KEY, code);
  $('conn').hidden = false;
  setConn('warn');
  sync = startSync({
    code,
    onState: render,
    onConn: setConn,
    onGone: () => leaveGame('Das letzte Spiel gibt es nicht mehr.'),
  });
  tickTimer = setInterval(() => {
    rpc('tick', { p_code: code }).catch((e) => console.warn('tick failed', e));
  }, TICK_MS);
  countdownTimer = setInterval(() => updateCountdowns($('tv')), COUNTDOWN_MS);
}

function leaveGame(message = '') {
  sync?.stop();
  clearInterval(tickTimer);
  clearInterval(countdownTimer);
  sync = null;
  code = null;
  hostPin = null;
  storeRemove(CODE_KEY);
  renderStart(message);
}

function render(state) {
  const { phase } = state.game;
  if (phase === 'lobby') renderLobby(state);
  else if (state.round && (phase === 'round_running' || phase === 'round_ending')) renderRound(state);
  else renderOther(state);
}

const inkOf = (palette, color) => palette.find((c) => c.color === color)?.ink || '#000000';

// ---------- Lobby ----------
function renderLobby({ game, players, palette }) {
  if (screen !== 'lobby') {
    screen = 'lobby';
    if (qrFor !== game.code) {
      qrMarkup = qrSvg(new URL(`play.html?g=${game.code}`, location.href).href, 'QR-Code zum Beitritt');
      qrFor = game.code;
    }
    // Built once, so a player joining never disturbs the PIN being typed.
    $('tv').innerHTML = `<div class="tv-lobby">
      <div class="qr">${qrMarkup}</div>
      <div class="tv-lobby-side">
        <div><span class="tv-label">Spielcode</span><div class="code">${esc(game.code)}</div></div>
        <div class="tv-players" id="tv-players"></div>
        <form class="tv-actions" id="f-start" autocomplete="off">
          <button class="btn" type="button" disabled>Proberunde</button>
          <input class="input tv-pin tv-start-pin" id="start-pin" type="password" inputmode="numeric" maxlength="6" placeholder="PIN" aria-label="Host-PIN" autocomplete="off" ${hostPin ? 'hidden' : ''}>
          <button class="btn btn-primary" id="start-main" type="submit" disabled>Hauptspiel starten</button>
          <span class="tv-hint" id="start-hint"></span>
        </form>
      </div>
      <button class="tv-leave" id="leave" type="button">Anderes Spiel</button>
    </div>`;
    $('leave').addEventListener('click', () => leaveGame());
    $('f-start').addEventListener('submit', onStartMain);
  }
  const seats = [];
  for (let i = 0; i < game.config.max_players; i++) {
    const p = players[i];
    seats.push(p
      ? `<div class="tv-player" style="--c:${esc(p.color)};--ink:${esc(inkOf(palette, p.color))}">${esc(p.name)}</div>`
      : '<div class="tv-player empty">wartet …</div>');
  }
  $('tv-players').innerHTML = seats.join('');
  const enough = players.length >= 2;
  const button = $('start-main');
  if (button.dataset.busy !== '1') button.disabled = !enough;
  const hint = $('start-hint');
  if (hint.dataset.error !== '1') hint.textContent = enough ? 'Proberunde folgt mit M6.' : 'Es braucht mindestens 2 Spieler.';
}

async function onStartMain(e) {
  e.preventDefault();
  const pin = hostPin || $('start-pin').value.trim();
  const button = $('start-main');
  const hint = $('start-hint');
  const fail = (reason) => {
    hint.dataset.error = '1';
    hint.textContent = ERRORS[reason] || ERRORS.network;
  };
  button.dataset.busy = '1';
  button.disabled = true;
  try {
    const r = await rpc('host_start_main', { p_code: code, p_pin: pin });
    if (r.ok) {
      hostPin = pin;
      await sync.refresh();
      return;
    }
    if (r.reason === 'bad_pin') {
      hostPin = null;
      $('start-pin').hidden = false;
      fail('wrong_pin');
    } else if (r.reason !== 'wrong_phase') {
      fail(r.reason);
    }
  } catch (err) {
    console.warn(err);
    fail('network');
  } finally {
    if ($('start-main')) {
      button.dataset.busy = '';
      button.disabled = false;
    }
  }
}

// ---------- Round ----------
function tickerLine(event) {
  const { type, payload } = event;
  if (type === 'line_claimed') return `${payload.name} löst ${payload.label}`;
  if (type === 'line_neutral') return `${payload.label} neutral aufgedeckt`;
  if (type === 'round_limit') return 'Zeit abgelaufen: offene Linien aufgedeckt';
  if (type === 'player_locked') return `${payload.name} ist ${payload.seconds} s gesperrt`;
  return null;
}

function renderRound(state) {
  const { game, round, players, ticker, lines } = state;
  if (screen !== 'round') {
    screen = 'round';
    gridKey = '';
    $('tv').innerHTML = '<div class="tv-round"><div class="tv-grid" id="tv-grid"></div><div class="tv-side" id="tv-side"></div></div>';
  }
  // The grid is only redrawn when its content changes, so effects run undisturbed.
  const key = `${round.id}/${lines.length}/${round.revealed}`;
  if (key !== gridKey) {
    gridKey = key;
    $('tv-grid').innerHTML = gridHtml(state);
  }

  const ending = game.phase === 'round_ending';
  const gameEnd = new Date(game.main_started_at).getTime() + game.config.game_limit_s * 1000;
  const roundEnd = new Date(round.deadline).getTime();
  const roundValue = ending ? '–' : `<span data-cd="${roundEnd}"></span>`;
  const events = ticker.map(tickerLine).filter(Boolean).slice(0, TICKER_LINES);
  $('tv-side').innerHTML = `
    ${ending ? `<div><span class="tv-tag">RUNDE ${esc(round.round_no)} BEENDET</span></div>` : ''}
    <div class="tv-stats">
      <div class="tv-panel tv-stat"><span class="tv-label">Spiel</span><b><span data-cd="${gameEnd}"></span></b></div>
      <div class="tv-panel tv-stat"><span class="tv-label">Runde ${esc(round.round_no)}</span><b>${roundValue}</b></div>
      <div class="tv-panel tv-stat hot"><span class="tv-label">Ballone</span><b>${esc(game.balloons_left)}</b></div>
    </div>
    <div class="tv-panel"><h2 class="tv-label">Jagden</h2><p class="hunts-empty">Gerade keine Jagd.</p></div>
    <div class="tv-panel"><div class="score">
      <span></span><span class="h" style="text-align:left">Spieler</span><span class="h">Linien</span><span class="h">Jagden ✓</span>
      ${players.map((p) => `<span class="sw" style="--c:${esc(p.color)}"></span><span>${esc(p.name)}</span><span class="n">${esc(p.lines_claimed)}</span><span class="n">${esc(p.hunts_success)}</span>`).join('')}
    </div></div>
    <div class="tv-panel" style="flex:1"><div class="ticker">${events.map((t) => `<div>${esc(t)}</div>`).join('')}</div></div>
    ${ending ? '<button class="tv-leave" id="leave" type="button">Anderes Spiel</button>' : ''}`;
  if (ending) $('leave').addEventListener('click', () => leaveGame());
  updateCountdowns($('tv'));
}

function renderOther({ game }) {
  screen = 'other';
  $('tv').innerHTML = `<div class="tv-center">
    <h1 class="tv-title">Spiel ${esc(game.code)} läuft</h1>
    <p class="dim">Diese Ansicht folgt mit den nächsten Meilensteinen.</p>
    <button class="btn" id="leave" type="button">Anderes Spiel</button>
  </div>`;
  $('leave').addEventListener('click', () => leaveGame());
}

// ---------- Boot ----------
window.addEventListener('resize', fitStage);
fitStage();

const remembered = storeGet(CODE_KEY);
if (remembered) openGame(remembered);
else renderStart();
