// TV view: creates or reconnects to a game, shows lobby and round, drives the tick
// (CLAUDE.md sections 5.4 and 9.3). The screen is rebuilt from get_state only.

import { rpc } from './api.js';
import { startSync } from './sync.js';
import { serverNow, updateCountdowns } from './clock.js';
import { gridHtml, isFxRunning } from './grid.js';
import { qrSvg } from './qr.js';
import { CASH_COUNT_MS } from './config.js';
import { $, esc, isRevealing, money, setConn, storeGet, storeRemove, storeSet, withBusy } from './util.js';

const STAGE_W = 1920;
const STAGE_H = 1080;
const TICK_MS = 1000;
const COUNTDOWN_MS = 250;
const CODE_KEY = 'badoku.tv.code';
const pinKey = (gameCode) => `badoku.tv.pin.${gameCode}`;
const TICKER_LINES = 5;
const HUNTS_BIG = 3;
const FORCE_RETRY_MS = 400;
const FORCE_RETRIES = 5;

const ERRORS = {
  bad_pin: 'Die PIN muss 4 bis 6 Ziffern haben.',
  wrong_pin: 'Die PIN stimmt nicht.',
  not_found: 'Dieses Spiel gibt es nicht.',
  bad_config: 'Die Einstellungen sind ungültig.',
  no_free_code: 'Kein freier Spielcode gefunden, bitte nochmals versuchen.',
  too_few_players: 'Es braucht mindestens 2 Spieler.',
  too_early: 'Noch einen Moment, dann nochmals drücken.',
  no_puzzle: 'Im Rätsel-Pool ist kein passendes Rätsel mehr.',
  cash_missing: 'Es haben noch nicht alle eingegeben.',
  network: 'Keine Verbindung zum Server, bitte nochmals versuchen.',
};

let sync = null;
let tickTimer = null;
let countdownTimer = null;
let code = null;
let hostPin = null; // remembered per game on this TV, so it is asked only once
let qrFor = null;
let qrMarkup = '';
let difficulty = 'leicht';
let screen = null;
let gridKey = '';
let lastState = null;
let breakKey = '';
let starting = false;

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
      storeSet(pinKey(r.code), pin);
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
      storeSet(pinKey(wanted), pin);
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
  hostPin = storeGet(pinKey(code));
  screen = null;
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
  countdownTimer = setInterval(() => {
    // The last reveal effect has played out, no new snapshot announces that.
    if (screen === 'round' && lastState && isBreak(lastState.game.phase) && !isFxRunning(lastState)) render(lastState);
    // Neither does the end of the reveal.
    if (screen === 'reveal' && lastState && !isRevealing(lastState.game, serverNow())) render(lastState);
    updateCountdowns($('tv'));
    updateHuntBars();
    updateForce();
  }, COUNTDOWN_MS);
}

function leaveGame(message = '') {
  if (code) storeRemove(pinKey(code));
  sync?.stop();
  clearInterval(tickTimer);
  clearInterval(countdownTimer);
  sync = null;
  code = null;
  hostPin = null;
  lastState = null;
  storeRemove(CODE_KEY);
  renderStart(message);
}

const isBreak = (phase) => phase === 'break_distribute' || phase === 'break_drink';

function render(state) {
  lastState = state;
  const { phase } = state.game;
  if (phase === 'lobby') renderLobby(state);
  else if (state.round && ['round_running', 'round_ending', 'trial_running', 'trial_ending'].includes(phase)) renderRound(state);
  // A reveal effect that is still running gets to finish before the break takes over.
  else if (state.round && isBreak(phase) && isFxRunning(state)) renderRound(state);
  else if (phase === 'break_distribute') renderDistribute(state);
  else if (phase === 'break_drink') renderDrink(state);
  else if (phase === 'cashout') renderCashout(state);
  else if (isRevealing(state.game, serverNow())) renderReveal(state);
  else if (phase === 'tiebreak') renderTiebreak(state);
  else renderResults(state);
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
          <button class="btn" id="start-trial" type="button" disabled>Proberunde</button>
          <input class="input tv-pin tv-start-pin" id="start-pin" type="password" inputmode="numeric" maxlength="6" placeholder="PIN" aria-label="Host-PIN" autocomplete="off" ${hostPin ? 'hidden' : ''}>
          <button class="btn btn-primary" id="start-main" type="submit" disabled>Hauptspiel starten</button>
          <span class="tv-hint" id="start-hint"></span>
        </form>
      </div>
      <button class="tv-leave" id="leave" type="button">Anderes Spiel</button>
    </div>`;
    $('leave').addEventListener('click', () => leaveGame());
    $('f-start').addEventListener('submit', (e) => {
      e.preventDefault();
      startGame('host_start_main');
    });
    $('start-trial').addEventListener('click', () => startGame('host_start_trial'));
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
  if (!starting) {
    $('start-main').disabled = !enough;
    $('start-trial').disabled = !enough;
  }
  const hint = $('start-hint');
  if (hint.dataset.error !== '1') {
    if (!enough) hint.textContent = 'Es braucht mindestens 2 Spieler.';
    else hint.textContent = game.trial_done ? 'Proberunde fertig. Sie zählt nicht und lässt sich wiederholen.' : 'Die Proberunde zählt nicht.';
  }
}

async function startGame(fn) {
  const pin = hostPin || $('start-pin').value.trim();
  const hint = $('start-hint');
  const fail = (reason) => {
    hint.dataset.error = '1';
    hint.textContent = ERRORS[reason] || ERRORS.network;
  };
  starting = true;
  $('start-main').disabled = true;
  $('start-trial').disabled = true;
  delete hint.dataset.error;
  try {
    const r = await rpc(fn, { p_code: code, p_pin: pin });
    if (r.ok) {
      hostPin = pin;
      storeSet(pinKey(code), pin);
      await sync.refresh();
      return;
    }
    if (r.reason === 'bad_pin') {
      hostPin = null;
      storeRemove(pinKey(code));
      $('start-pin').hidden = false;
      fail('wrong_pin');
    } else if (r.reason !== 'wrong_phase') {
      fail(r.reason);
    }
  } catch (err) {
    console.warn(err);
    fail('network');
  } finally {
    starting = false;
    if ($('start-main')) {
      $('start-main').disabled = false;
      $('start-trial').disabled = false;
    }
  }
}

// ---------- Round ----------
function tickerLine(event) {
  const { type, payload } = event;
  if (type === 'line_claimed') return `${payload.name} löst ${payload.label}`;
  if (type === 'line_neutral') return `${payload.label} neutral aufgedeckt`;
  if (type === 'round_limit') return 'Zeit abgelaufen: offene Linien aufgedeckt';
  if (type === 'auto_reveal') return `Nur noch ${payload.cells} ${payload.cells === 1 ? 'Feld' : 'Felder'} offen: Rest aufgedeckt`;
  if (type === 'player_locked') return `${payload.name} ist ${payload.seconds} s gesperrt`;
  if (type === 'hunt_success') return `Jagd von ${payload.name} erfolgreich`;
  if (type === 'hunt_failed') return `Jagd von ${payload.name}: Zeit abgelaufen`;
  if (type === 'balloons_empty') return 'Letzter Ballon unterwegs: Das Spiel endet';
  if (type === 'round_started') return `Runde ${payload.round_no} startet`;
  return null;
}

// Up to three hunts get big bars, more share two columns so that seven still fit.
function huntsHtml({ hunts_active: hunts, players }) {
  if (!hunts.length) return '<p class="hunts-empty">Gerade keine Jagd.</p>';
  const byId = new Map(players.map((p) => [p.id, p]));
  return `<div class="hunts ${hunts.length <= HUNTS_BIG ? 'few' : ''}">${hunts.map((h) => {
    const p = byId.get(h.player_id);
    const start = new Date(h.started_at).getTime();
    const end = new Date(h.deadline).getTime();
    return `<div class="hunt-row" style="--c:${esc(p.color)}"><i class="fill" data-bar-start="${start}" data-bar-end="${end}"></i><span class="hl">${esc(p.name)} · ${esc(h.lines_label)}</span><span><span data-cd="${end}" data-fmt="s"></span> s</span></div>`;
  }).join('')}</div>`;
}

function updateHuntBars() {
  const now = serverNow();
  document.querySelectorAll('[data-bar-start]').forEach((el) => {
    const start = Number(el.dataset.barStart);
    const end = Number(el.dataset.barEnd);
    el.style.width = `${Math.max(0, Math.min(100, (100 * (end - now)) / (end - start)))}%`;
  });
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
    $('tv-grid').style.setProperty('--n', round.size);
    $('tv-grid').innerHTML = gridHtml(state);
  }

  const trial = round.kind === 'trial';
  const ending = !['round_running', 'trial_running'].includes(game.phase);
  const roundEnd = new Date(round.deadline).getTime();
  const roundValue = ending ? '–' : `<span data-cd="${roundEnd}"></span>`;
  const events = ticker.map(tickerLine).filter(Boolean).slice(0, TICKER_LINES);
  let tag = '';
  if (trial) tag = ending ? 'PROBERUNDE BEENDET' : 'PROBERUNDE · zählt nicht';
  else if (ending) tag = `RUNDE ${round.round_no} BEENDET`;
  // The trial leaves the players' counters alone, its lines and hunts count only here.
  const linesOf = (p) => (trial ? lines.filter((l) => l.player_id === p.id).length : p.lines_claimed);
  const huntsOf = (p) => (trial ? state.trial_success?.[p.id] || 0 : p.hunts_success);
  const stats = trial
    ? `<div class="tv-stats one">
      <div class="tv-panel tv-stat"><span class="tv-label">Probe</span><b>${roundValue}</b></div>
    </div>`
    : `<div class="tv-stats">
      <div class="tv-panel tv-stat"><span class="tv-label">Spiel</span><b><span data-cd="${new Date(game.main_started_at).getTime() + game.config.game_limit_s * 1000}"></span></b></div>
      <div class="tv-panel tv-stat"><span class="tv-label">Runde ${esc(round.round_no)}</span><b>${roundValue}</b></div>
      <div class="tv-panel tv-stat hot"><span class="tv-label">Ballone</span><b>${esc(game.balloons_left)}</b></div>
    </div>`;
  $('tv-side').innerHTML = `
    ${tag ? `<div><span class="tv-tag">${esc(tag)}</span></div>` : ''}
    ${stats}
    <div class="tv-panel"><h2 class="tv-label tv-hunts-title">Jagden</h2>${huntsHtml(state)}</div>
    <div class="tv-panel"><div class="score">
      <span></span><span class="h" style="text-align:left">Spieler</span><span class="h">Linien</span><span class="h">Jagden ✓</span>
      ${players.map((p) => `<span class="sw" style="--c:${esc(p.color)}"></span><span>${esc(p.name)}</span><span class="n">${esc(linesOf(p))}</span><span class="n">${esc(huntsOf(p))}</span>`).join('')}
    </div></div>
    <div class="tv-panel" style="flex:1"><div class="ticker">${events.map((t) => `<div>${esc(t)}</div>`).join('')}</div></div>
    ${ending ? '<button class="tv-leave" id="leave" type="button">Anderes Spiel</button>' : ''}`;
  if (ending) $('leave').addEventListener('click', () => leaveGame());
  updateCountdowns($('tv'));
  updateHuntBars();
}

// ---------- Break ----------
const shotsWord = (n) => (n === 1 ? 'Shot' : 'Shots');

// Rows of the transfer table are summed per pair, a tap is one row in the database.
function renderDistribute({ game, players, sip_transfers: transfers }) {
  const key = `${game.round_no}/${game.phase_started_at}`;
  if (screen !== 'distribute' || breakKey !== key) {
    screen = 'distribute';
    breakKey = key;
    $('tv').innerHTML = `<div class="tv-break">
      <div class="tv-break-head"><h1 class="tv-title">Pause: Wer gibt wem?</h1>
        <span class="tv-label">Automatisch in <b class="tv-break-cd"><span data-cd="${new Date(game.phase_deadline).getTime()}"></span></b></span></div>
      <table class="matrix" id="tv-matrix"></table>
      <button class="tv-leave" id="leave" type="button">Anderes Spiel</button>
    </div>`;
    $('leave').addEventListener('click', () => leaveGame());
    updateCountdowns($('tv'));
  }
  const sum = new Map();
  for (const t of transfers) {
    const key = `${t.from_player}/${t.to_player}`;
    sum.set(key, (sum.get(key) || 0) + t.amount);
  }
  const given = new Set(transfers.map((t) => t.from_player));
  const head = players.map((p) => `<th><span class="sw" style="--c:${esc(p.color)}"></span>${esc(p.name)}</th>`).join('');
  const rows = players.map((from) => {
    const cells = players.map((to) => {
      if (from.id === to.id) return '<td class="self"></td>';
      const n = sum.get(`${from.id}/${to.id}`) || 0;
      return `<td class="${n ? 'hit' : ''}" style="--c:${esc(from.color)}">${n || ''}</td>`;
    }).join('');
    const left = from.sips_to_distribute;
    const status = left
      ? `<td class="state">noch ${esc(left)}</td>`
      : `<td class="state ${given.has(from.id) ? 'ok' : ''}">${given.has(from.id) ? '✓ verteilt' : 'nichts'}</td>`;
    return `<tr><th class="from"><span class="sw" style="--c:${esc(from.color)}"></span>${esc(from.name)}</th>${cells}${status}</tr>`;
  }).join('');
  $('tv-matrix').innerHTML = `<thead><tr><th class="from-head"></th>${head}<th class="state-head">Status</th></tr></thead><tbody>${rows}</tbody>`;
}

// Built once and only updated in parts, so the PIN field and the button stay in place.
function renderDrink(state) {
  const { game, players } = state;
  const key = `${game.round_no}/${game.phase_started_at}`;
  if (screen !== 'drink' || breakKey !== key) {
    screen = 'drink';
    breakKey = key;
    const limit = new Date(game.main_started_at).getTime() + game.config.game_limit_s * 1000;
    const last = game.balloons_left <= 0 || serverNow() >= limit;
    $('tv').innerHTML = `<div class="tv-break">
      <h1 class="tv-title">Pause: Trinken &amp; bereit machen</h1>
      <div class="cash-grid" id="tv-drink"></div>
      <form class="tv-break-foot" id="f-force" autocomplete="off">
        <span class="dim" id="force-hint">${last ? 'Das war die letzte Runde: Sobald alle bereit sind, folgt der Kassensturz.' : 'Das nächste Sudoku startet, sobald alle bereit sind.'}</span>
        <span class="tv-force" id="force-box" hidden>
          <input class="input tv-pin tv-start-pin" id="force-pin" type="password" inputmode="numeric" maxlength="6" placeholder="PIN" aria-label="Host-PIN" autocomplete="off" ${hostPin ? 'hidden' : ''}>
          <button class="btn btn-primary" id="force-go" type="submit">Weiter erzwingen</button>
        </span>
      </form>
      <button class="tv-leave" id="leave" type="button">Anderes Spiel</button>
    </div>`;
    $('leave').addEventListener('click', () => leaveGame());
    $('f-force').addEventListener('submit', onForce);
  }
  $('tv-drink').innerHTML = players.map((p) => `<div class="cash-row"><span class="sw" style="--c:${esc(p.color)}"></span><div>${esc(p.name)}<small>trinkt ${esc(p.sips_to_drink)} ${shotsWord(p.sips_to_drink)}</small></div><span class="tick ${p.ready ? '' : 'no'}">${p.ready ? '✓' : '…'}</span></div>`).join('');
  updateForce();
}

// The button appears by the clock alone, no snapshot arrives at that moment.
function updateForce() {
  const box = $('force-box');
  if (!box || !lastState?.game.phase_deadline) return;
  box.hidden = serverNow() < new Date(lastState.game.phase_deadline).getTime();
}

async function onForce(e) {
  e.preventDefault();
  const pin = hostPin || $('force-pin').value.trim();
  const hint = $('force-hint');
  await withBusy($('force-go'), async () => {
    try {
      // The button appears by this device's clock, which can be slightly ahead of the server's.
      let r = await rpc('host_force_continue', { p_code: code, p_pin: pin });
      for (let i = 0; r.reason === 'too_early' && i < FORCE_RETRIES; i++) {
        await new Promise((resolve) => setTimeout(resolve, FORCE_RETRY_MS));
        r = await rpc('host_force_continue', { p_code: code, p_pin: pin });
      }
      if (r.ok) {
        hostPin = pin;
        storeSet(pinKey(code), pin);
        await sync.refresh();
      } else if (r.reason === 'bad_pin') {
        hostPin = null;
        storeRemove(pinKey(code));
        $('force-pin').hidden = false;
        hint.textContent = ERRORS.wrong_pin;
      } else if (r.reason === 'too_early') {
        hint.textContent = ERRORS.too_early;
      }
    } catch (err) {
      console.warn(err);
      hint.textContent = ERRORS.network;
    }
  });
}

// ---------- Cashout ----------
const balloonsWord = (n) => (n === 1 ? 'Ballon' : 'Ballone');
const allowedLine = (p) => `darf ${esc(p.hunts_success)} ${balloonsWord(p.hunts_success)} platzen lassen`;

// Built once and only updated in parts, so the PIN field and the button stay in place.
function renderCashout({ players }) {
  if (screen !== 'cashout') {
    screen = 'cashout';
    $('tv').innerHTML = `<div class="tv-break">
      <h1 class="tv-title">Kassensturz</h1>
      <div class="cash-grid" id="tv-cash"></div>
      <form class="tv-break-foot" id="f-close" autocomplete="off">
        <span class="dim" id="close-hint"></span>
        <span class="tv-force">
          <input class="input tv-pin tv-start-pin" id="close-pin" type="password" inputmode="numeric" maxlength="6" placeholder="PIN" aria-label="Host-PIN" autocomplete="off" ${hostPin ? 'hidden' : ''}>
          <button class="btn btn-primary" id="close-go" type="submit" disabled>Kassensturz abschliessen</button>
        </span>
      </form>
      <button class="tv-leave" id="leave" type="button">Anderes Spiel</button>
    </div>`;
    $('leave').addEventListener('click', () => leaveGame());
    $('f-close').addEventListener('submit', onCloseCash);
  }
  $('tv-cash').innerHTML = players.map((p) => `<div class="cash-row"><span class="sw" style="--c:${esc(p.color)}"></span><div>${esc(p.name)}<small>${allowedLine(p)}</small></div><span class="tick ${p.has_submitted_cash ? '' : 'no'}">${p.has_submitted_cash ? '✓' : '…'}</span></div>`).join('');
  const all = players.every((p) => p.has_submitted_cash);
  if (!starting) $('close-go').disabled = !all;
  const hint = $('close-hint');
  if (hint.dataset.error !== '1') {
    hint.textContent = all ? 'Alle haben eingegeben. Beträge bleiben verborgen, bis du abschliesst.' : 'Gib deinen Betrag auf dem Handy ein. Die Beträge bleiben verborgen.';
  }
}

async function onCloseCash(e) {
  e.preventDefault();
  const pin = hostPin || $('close-pin').value.trim();
  const hint = $('close-hint');
  const fail = (reason) => {
    hint.dataset.error = '1';
    hint.textContent = ERRORS[reason] || ERRORS.network;
  };
  starting = true;
  $('close-go').disabled = true;
  delete hint.dataset.error;
  try {
    const r = await rpc('host_close_cashout', { p_code: code, p_pin: pin });
    if (r.ok) {
      hostPin = pin;
      storeSet(pinKey(code), pin);
      await sync.refresh();
    } else if (r.reason === 'bad_pin') {
      hostPin = null;
      storeRemove(pinKey(code));
      $('close-pin').hidden = false;
      fail('wrong_pin');
    } else if (r.reason !== 'wrong_phase') {
      fail(r.reason);
    }
  } catch (err) {
    console.warn(err);
    fail('network');
  } finally {
    starting = false;
    if ($('close-go')) $('close-go').disabled = false;
  }
}

// The amounts count up by the server's clock, so a reload continues instead of restarting.
function paintCount(start) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const part = reduce ? 1 : Math.max(0, Math.min(1, (serverNow() - start) / CASH_COUNT_MS));
  document.querySelectorAll('[data-count]').forEach((el) => {
    el.textContent = money(Math.round(Number(el.dataset.count) * part));
  });
  if (part < 1 && screen === 'reveal') requestAnimationFrame(() => paintCount(start));
}

function renderReveal({ game, players }) {
  if (screen === 'reveal') return;
  screen = 'reveal';
  const total = players.reduce((sum, p) => sum + p.cash_cents, 0);
  const tie = game.phase === 'tiebreak';
  $('tv').innerHTML = `<div class="tv-break">
    <h1 class="tv-title">Kassensturz</h1>
    <div class="cash-grid">${players.map((p) => `<div class="cash-row"><span class="sw" style="--c:${esc(p.color)}"></span><div>${esc(p.name)}<small>${allowedLine(p)}</small></div><span class="val" data-count="${esc(p.cash_cents)}"></span></div>`).join('')}</div>
    <div class="tv-break-foot">
      <span>Summe aller Eingaben: <b class="tv-sum">${money(total)}</b> von max. ${money(game.config.coins_total_cents)}</span>
      <span class="tv-next">${tie ? 'Gleichstand! Powersudoku' : 'Rangliste'} in <b data-cd="${new Date(game.phase_deadline).getTime()}" data-fmt="s"></b> s</span>
    </div>
  </div>`;
  updateCountdowns($('tv'));
  paintCount(new Date(game.phase_started_at).getTime());
}

// ---------- Tiebreak ----------
function renderTiebreak({ game, round, players }) {
  if (screen !== 'tiebreak') {
    screen = 'tiebreak';
    $('tv').innerHTML = `<div class="tv-break">
      <div class="tv-break-head"><h1 class="tv-title">Powersudoku</h1>
        <span class="tv-label">Limit <b class="tv-break-cd"><span data-cd="${new Date(round.deadline).getTime()}"></span></b></span></div>
      <p class="dim">Gleicher Betrag, gleiches Rätsel. Wer in seiner Gruppe zuerst fertig ist, beendet das Powersudoku für die Gruppe.</p>
      <div class="tb-groups" id="tb-groups"></div>
      <button class="tv-leave" id="leave" type="button">Anderes Spiel</button>
    </div>`;
    $('leave').addEventListener('click', () => leaveGame());
    updateCountdowns($('tv'));
  }
  const open = [...round.givens].filter((d) => d === '0').length;
  const groups = new Map();
  for (const p of players) {
    if (p.tiebreak_group === null) continue;
    if (!groups.has(p.tiebreak_group)) groups.set(p.tiebreak_group, []);
    groups.get(p.tiebreak_group).push(p);
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]);
  $('tb-groups').innerHTML = ordered.map(([no, members]) => {
    const winner = members.find((p) => p.tiebreak_finished_at);
    return `<div class="tv-panel"><h2 class="tv-label">Gruppe ${esc(no)} · ${money(members[0].cash_cents)}${winner ? ' · fertig' : ''}</h2>
      ${members.map((p) => `<div class="tb-row"><span class="tb-name">${p === winner ? '✓ ' : ''}${esc(p.name)}</span><span class="mono">${esc(p.tiebreak_correct)}/${open}</span></div>
      <div class="prog" style="--c:${esc(p.color)}"><i style="width:${(100 * p.tiebreak_correct) / open}%"></i></div>`).join('')}
    </div>`;
  }).join('');
}

// ---------- Results ----------
const AWARDS = [
  ['lines', 'Linien-König', (w) => `${w.value} Linien`],
  ['hunter', 'Jagd-Profi', (w) => `${w.value} von ${w.total}`],
  ['errors', 'Fehlerteufel', (w) => `${w.value} Fehler`],
  ['magnet', 'Shot-Magnet', (w) => `${w.value} erhalten`],
  ['generous', 'Grosszügigster', (w) => `${w.value} verteilt`],
];
const PODIUM_HEIGHTS = { 1: 460, 2: 340, 3: 260 };

const clockOf = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

function renderResults({ players, palette, stats }) {
  if (screen === 'results') return;
  screen = 'results';
  const byId = new Map(players.map((p) => [p.id, p]));
  const statOf = new Map(stats.players.map((s) => [s.player_id, s]));
  const ranked = [...players].sort((a, b) => a.final_rank - b.final_rank);
  const pod = (p) => `<div class="pod" style="--c:${esc(p.color)};--ink:${esc(inkOf(palette, p.color))};height:${PODIUM_HEIGHTS[p.final_rank]}px"><b>${esc(p.final_rank)}</b><span class="pod-name">${esc(p.name)}</span><span class="pod-cash">${money(p.cash_cents)}</span></div>`;
  // Second, first, third: the winner stands in the middle.
  const podium = [ranked[1], ranked[0], ranked[2]].filter(Boolean).map(pod).join('');
  const rows = ranked.map((p) => {
    const s = statOf.get(p.id);
    return `<tr><td class="l">${esc(p.final_rank)}</td>
      <td class="l"><span class="sw" style="--c:${esc(p.color)}"></span>${esc(p.name)}${p.rank_by_lot ? '<span class="lot">Los</span>' : ''}</td>
      <td>${money(p.cash_cents)}</td><td>${esc(s.lines_total)}</td>
      <td>${s.fastest_line_s === null ? '–' : clockOf(s.fastest_line_s)}</td>
      <td>${esc(s.hunts_success)}/${esc(s.hunts_started)}</td>
      <td>${esc(s.errors_total)}</td><td>${esc(s.locks_total)}</td>
      <td>${esc(s.sips_given)}</td><td>${esc(s.sips_received)}</td></tr>`;
  }).join('');
  const awards = AWARDS.filter(([key]) => stats.awards[key]).map(([key, title, detail]) => {
    const winners = stats.awards[key];
    // Equal quotes can stand for different numbers of hunts, the quote is what they share.
    const text = key === 'hunter' && winners.length > 1
      ? `${Math.round((100 * winners[0].value) / winners[0].total)} %`
      : detail(winners[0]);
    return `<div class="award"><span>${title}</span>${winners.map((w) => esc(byId.get(w.player_id).name)).join(', ')}<small>${esc(text)}</small></div>`;
  }).join('');
  $('tv').innerHTML = `<div class="res">
    <div class="res-left">
      <h1 class="tv-title">Rangliste</h1>
      <div class="podium">${podium}</div>
    </div>
    <div class="res-right">
      <table class="rtable"><thead><tr><th class="l">Rang</th><th class="l">Name</th><th>Betrag</th><th>Linien</th><th>Schnellste</th><th>Jagden</th><th>Fehler</th><th>Sperren</th><th>Verteilt</th><th>Erhalten</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="awards">${awards}</div>
    </div>
    <button class="tv-leave" id="leave" type="button">Anderes Spiel</button>
  </div>`;
  $('leave').addEventListener('click', () => leaveGame());
}

// ---------- Boot ----------
window.addEventListener('resize', fitStage);
fitStage();

const remembered = storeGet(CODE_KEY);
if (remembered) openGame(remembered);
else renderStart();
