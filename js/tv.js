// TV view: creates or reconnects to a game, shows the lobby, drives the tick
// (CLAUDE.md sections 5.4 and 9.3). The screen is rebuilt from get_state only.

import { rpc } from './api.js';
import { startSync } from './sync.js';
import { qrSvg } from './qr.js';
import { $, esc, setConn, storeGet, storeRemove, storeSet, withBusy } from './util.js';

const STAGE_W = 1920;
const STAGE_H = 1080;
const TICK_MS = 1000;
const CODE_KEY = 'badoku.tv.code';

const ERRORS = {
  bad_pin: 'Die PIN muss 4 bis 6 Ziffern haben.',
  wrong_pin: 'Die PIN stimmt nicht.',
  not_found: 'Dieses Spiel gibt es nicht.',
  bad_config: 'Die Einstellungen sind ungültig.',
  no_free_code: 'Kein freier Spielcode gefunden, bitte nochmals versuchen.',
  network: 'Keine Verbindung zum Server, bitte nochmals versuchen.',
};

let sync = null;
let tickTimer = null;
let code = null;
let hostPin = null; // kept in memory only (CLAUDE.md 9.3)
let qrFor = null;
let qrMarkup = '';
let difficulty = 'leicht';

function fitStage() {
  const scale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
  const tv = $('tv');
  const x = (window.innerWidth - STAGE_W * scale) / 2;
  const y = (window.innerHeight - STAGE_H * scale) / 2;
  tv.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
}

// ---------- Start ----------
function renderStart(message = '') {
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
}

function leaveGame(message = '') {
  sync?.stop();
  clearInterval(tickTimer);
  sync = null;
  code = null;
  hostPin = null;
  storeRemove(CODE_KEY);
  renderStart(message);
}

function render(state) {
  const { game } = state;
  if (game.phase === 'lobby') renderLobby(state);
  else renderRunning(state);
}

function renderLobby({ game, players, palette }) {
  if (qrFor !== game.code) {
    const url = new URL(`play.html?g=${game.code}`, location.href).href;
    qrMarkup = qrSvg(url, 'QR-Code zum Beitritt');
    qrFor = game.code;
  }
  const inkOf = (color) => palette.find((c) => c.color === color)?.ink || '#000000';
  const seats = [];
  for (let i = 0; i < game.config.max_players; i++) {
    const p = players[i];
    seats.push(p
      ? `<div class="tv-player" style="--c:${esc(p.color)};--ink:${inkOf(p.color)}">${esc(p.name)}</div>`
      : '<div class="tv-player empty">wartet …</div>');
  }
  $('tv').innerHTML = `<div class="tv-lobby">
    <div class="qr">${qrMarkup}</div>
    <div class="tv-lobby-side">
      <div><span class="tv-label">Spielcode</span><div class="code">${esc(game.code)}</div></div>
      <div class="tv-players">${seats.join('')}</div>
      <div class="tv-actions">
        <button class="btn" type="button" disabled>Proberunde</button>
        <button class="btn btn-primary" type="button" disabled>Hauptspiel starten</button>
        <span class="tv-hint">Spielstart folgt mit M3.</span>
      </div>
    </div>
    <button class="tv-leave" id="leave" type="button">Anderes Spiel</button>
  </div>`;
  $('leave').addEventListener('click', () => leaveGame());
}

function renderRunning({ game }) {
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
