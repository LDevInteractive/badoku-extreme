// Phone view: joining, lobby and the Sudoku round (CLAUDE.md section 9.2). The token
// stays on this device; a reload finds the player again through get_state.

import { ApiError, rpc } from './api.js';
import { HUNT_RESULT_MS, HUNT_VIBRATE } from './config.js';
import { startSync } from './sync.js';
import { msUntil, serverNow, updateCountdowns } from './clock.js';
import { gridHtml, isFxRunning } from './grid.js';
import * as wakelock from './wakelock.js';
import { $, esc, isRevealing, money, setConn, storeGet, storeRemove, storeSet, withBusy } from './util.js';

const TICK_FALLBACK_MS = 5000;
const UI_TICK_MS = 250;
const FLASH_MS = 520;
const NET_MESSAGE_MS = 2500;
const VIBRATE_ERROR_MS = 120;
const CODE_RE = /^[0-9]{4}$/;
const AMOUNT_RE = /^([0-9]{1,4})(?:[.,]([0-9]{1,2}))?$/;
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
let netMessage = '';
// Digits go out one after the other. A snapshot can show a digit before its answer arrives,
// and the player goes on at once; the next digit must wait here, not get lost.
let digitQueue = Promise.resolve();
const digitsOnTheirWay = new Set(); // a double tap stays one input (CLAUDE.md 9.4)
let optimisticRound = null;
const optimistic = new Map(); // correct entries the next snapshot will confirm

// Hunt state that only lives on this device. Answers of the server show at once; these
// keep them in place until a snapshot that is new enough confirms them.
let localHunt = null;
let localResult = null;
let pressBusy = false;
let vibratedFor = null;
let lateTickFor = null;

// Break state that only lives on this device: tiles count up at once, taps go out one
// after the other, and a snapshot that is on its way cannot take a shot back.
let breakRound = null;
let sipsAcked = Infinity; // what the server said is left
let sipsPending = 0;
let sipsQueue = Promise.resolve();
const sipsToTarget = new Map();
let readySent = false;
let breakMessage = '';

// Cashout state that only lives on this device.
let cashEditing = false;

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

const sameTime = (a, b) => new Date(a).getTime() === new Date(b).getTime();
const isRunning = (phase) => ['round_running', 'trial_running', 'tiebreak'].includes(phase);

// A snapshot that was on its way while the hunt started or ended must not undo that.
function reconcileHunt(me) {
  if (localResult) {
    if (me.hunt && sameTime(me.hunt.started_at, localResult.started_at)) me.hunt = null;
    if (me.last_hunt && sameTime(me.last_hunt.started_at, localResult.started_at)) localResult = null;
    else me.last_hunt = localResult;
  }
  if (localHunt) {
    const over = me.last_hunt && new Date(me.last_hunt.started_at) >= new Date(localHunt.started_at);
    if (me.hunt || over) localHunt = null;
    else me.hunt = localHunt;
  }
}

function onState(state) {
  lastState = state;
  if (state.me) {
    reconcileHunt(state.me);
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
  const hunt = huntView(state.me);
  const ending = phase === 'round_ending' || phase === 'trial_ending';
  if (hunt) renderHunt(hunt);
  else if (phase === 'lobby') renderLobby(state);
  else if (isRevealing(state.game, serverNow())) renderReveal(state);
  else if (phase === 'tiebreak') renderTiebreak(state);
  else if (state.round && isRunning(phase)) renderRound(state);
  // The finished grid stays until the break: nobody is hunting, or the last effect still plays out.
  else if (state.round && ending && (!state.hunts_active.length || isFxRunning(state))) renderRound(state);
  else if (state.round && (phase === 'break_distribute' || phase === 'break_drink') && isFxRunning(state)) renderRound(state);
  else if (ending) renderEnded(state);
  else if (phase === 'break_distribute') renderDistribute(state);
  else if (phase === 'break_drink') renderDrink(state);
  else if (phase === 'cashout') renderCashout(state);
  else renderResults(state);
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
function renderLobby({ me, players, game }) {
  const active = wakelock.isActive();
  draw('lobby', `${active}|${game.trial_done}|${players.map((p) => p.id).join()}`, () => `<div class="ph-pad">
    <h1 class="ph-title">${game.trial_done ? 'Proberunde geschafft. Warte auf das Hauptspiel.' : 'Warte auf den Start'}</h1>
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
  const running = isRunning(game.phase);
  if (!running || (sel >= 0 && (round.revealed[sel] !== '0' || entries.has(sel)))) sel = -1;
  const locked = running ? lockedUntil(state) : null;
  const errors = errorCount(state);
  const trial = round.kind === 'trial';
  const tie = round.kind === 'tiebreak';
  // The trial leaves the players' counters alone, its lines count only here.
  const myLines = trial
    ? state.lines.filter((l) => l.player_id === me.player_id).length
    : players.find((p) => p.id === me.player_id).lines_claimed;
  const key =[round.id, round.revealed, state.lines.length, entries.size, sel, flash, locked, errors, game.balloons_left, myLines, netMessage, game.phase].join('|');
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
    const roundTimer = running ? `<span data-cd="${new Date(round.deadline).getTime()}"></span>` : '–';
    let label = `Runde ${esc(round.round_no)}${running ? '' : ' beendet'}`;
    if (trial) label = running ? 'Proberunde, zählt nicht' : 'Proberunde beendet';
    if (tie) label = 'Powersudoku, zuerst fertig gewinnt';
    const open = [...round.givens].filter((d) => d === '0').length;
    const head = tie
      ? stat(roundTimer, 'Limit') + stat(esc(entries.size), 'Korrekt') + stat(esc(open - entries.size), 'Offen')
      : stat(roundTimer, trial ? 'Probe' : 'Runde') + stat(trial ? '–' : esc(game.balloons_left), 'Ballone') + stat(esc(myLines), 'Linien');
    return `<div class="ph-head">${head}</div>
      <div class="ph-sub"><span>${netMessage ? esc(netMessage) : label}</span>
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
  if (!state?.round || !isRunning(state.game.phase) || lockedUntil(state)) return;
  if (state.round.revealed[idx] !== '0' || entriesOf(state).has(idx)) return;
  sel = idx;
  redraw();
}

function onDigitTap(digit) {
  const state = lastState;
  if (sel < 0 || !state?.round || lockedUntil(state)) return;
  const cell = sel;
  const key = `${cell}/${digit}`;
  if (digitsOnTheirWay.has(key)) return;
  digitsOnTheirWay.add(key);
  const round = state.round.id;
  digitQueue = digitQueue.then(() => sendDigit(round, cell, digit, key));
}

// By the time the answer arrives the player may have selected another cell, that one stays.
async function sendDigit(round, cell, digit, key) {
  try {
    const r = await rpc('enter_digit', { p_code: syncedCode, p_token: token, p_cell: cell, p_digit: digit });
    const { me } = lastState;
    if (r.ok && r.result === 'correct') {
      if (optimisticRound === round) optimistic.set(cell, digit);
      if (sel === cell) sel = -1;
      if (r.hunt) {
        localHunt = r.hunt;
        me.hunt = r.hunt;
        sync?.refresh();
      }
      if (r.finished) sync?.refresh();
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
    } else if (r.reason === 'filled' && sel === cell) {
      sel = -1;
    }
  } catch (e) {
    console.warn(e);
    showNetMessage();
  } finally {
    digitsOnTheirWay.delete(key);
  }
  redraw();
}

// ---------- Hunt ----------
function huntView(me) {
  if (me.hunt) {
    return msUntil(me.hunt.deadline) > 0
      ? { kind: 'active', hunt: me.hunt }
      : { kind: 'failed', key: me.hunt.started_at, trial: me.hunt.kind === 'trial' };
  }
  const last = me.last_hunt;
  if (last && serverNow() - new Date(last.ended_at).getTime() < HUNT_RESULT_MS) {
    return { kind: last.status === 'success' ? 'success' : 'failed', key: last.started_at, trial: last.kind === 'trial' };
  }
  return null;
}

const ms = (time) => new Date(time).getTime();

function renderHunt(view) {
  if (view.kind === 'active') {
    const { hunt } = view;
    const drawn = draw('hunt', `active|${hunt.started_at}`, () => `<div class="overlay ov-hunt">
      <h1 class="ph-title">${esc(hunt.lines_label)} gelöst!</h1>
      <div class="cd"><span data-cd="${ms(hunt.deadline)}" data-fmt="s"></span></div>
      <p class="rule" id="hunt-rule">${hunt.kind === 'trial' ? 'Proberunde: Niemand rennt. Warte, bis der Knopf bereit ist, und drücke ihn.' : 'Handy liegen lassen. Ballon holen. Ab ins Depot.'}</p>
      <button class="hunt-btn" id="hunt-btn" data-press type="button" disabled><i class="fill"></i><span>BALLON IM DEPOT</span></button>
    </div>`);
    if (drawn) updateCountdowns($('phone'));
    if (vibratedFor !== hunt.started_at) {
      vibratedFor = hunt.started_at;
      if (serverNow() - ms(hunt.started_at) < HUNT_RESULT_MS) navigator.vibrate?.(HUNT_VIBRATE);
    }
    const span = ms(hunt.min_press_at) - ms(hunt.started_at);
    const waited = serverNow() - ms(hunt.started_at);
    const ready = waited >= span;
    const btn = $('hunt-btn');
    btn.disabled = !ready;
    btn.classList.toggle('ready', ready);
    btn.querySelector('.fill').style.width = ready ? '0' : `${Math.min(100, (100 * waited) / span)}%`;
    return;
  }
  if (view.kind === 'success') {
    draw('hunt', `success|${view.key}`, () => (view.trial
      ? '<div class="overlay ov-hunt"><div class="ov-mark">✔</div><h1 class="ph-title">Geschafft!</h1><p class="rule">Im Spiel dürftest du dafür einen Ballon mehr platzen lassen.</p></div>'
      : '<div class="overlay ov-hunt"><div class="ov-mark">✔</div><h1 class="ph-title">Ballon zählt!</h1><p class="rule">Du darfst beim Kassensturz einen Ballon mehr platzen lassen.</p></div>'));
    return;
  }
  draw('hunt', `failed|${view.key}`, () => `<div class="overlay ov-fail"><div class="ov-mark">✗</div><h1 class="ph-title">Zeit abgelaufen</h1><p class="rule">${view.trial ? 'Im Spiel würde ein Ballon jetzt nicht mehr zählen.' : 'Ein mitgebrachter Ballon darf ins Depot, zählt aber nicht.'}</p></div>`);
  // The clock of this phone says it is over: ask the server to close it now.
  if (lastState.me.hunt && lateTickFor !== view.key) {
    lateTickFor = view.key;
    rpc('tick', { p_code: syncedCode }).then(() => sync?.refresh()).catch((e) => console.warn('tick failed', e));
  }
}

async function onPress() {
  const hunt = lastState?.me?.hunt;
  if (pressBusy || !hunt) return;
  pressBusy = true;
  try {
    const r = await rpc('hunt_press', { p_code: syncedCode, p_token: token });
    const { me } = lastState;
    if (r.ok) {
      localHunt = null;
      localResult = { status: 'success', kind: hunt.kind, started_at: hunt.started_at, ended_at: new Date(serverNow()).toISOString() };
      me.hunt = null;
      me.last_hunt = localResult;
    } else if (r.reason === 'no_hunt') {
      localHunt = null;
    }
    sync?.refresh();
  } catch (e) {
    console.warn(e);
    const rule = $('hunt-rule');
    if (rule) rule.textContent = ERRORS.network;
  } finally {
    pressBusy = false;
  }
  redraw();
}

function renderEnded({ game }) {
  const trial = game.phase === 'trial_ending';
  draw('ended', String(trial), () => `<div class="ph-pad ph-center">
    <h1 class="ph-title">${trial ? 'Proberunde beendet' : 'Runde beendet'}</h1>
    <p class="dim">Warte auf laufende Jagden.</p>
  </div>`);
}

// ---------- Break ----------
const shotsWord = (n) => (n === 1 ? 'Shot' : 'Shots');

function syncBreak(game) {
  if (breakRound === game.round_no) return;
  breakRound = game.round_no;
  sipsAcked = Infinity;
  sipsPending = 0;
  sipsToTarget.clear();
  readySent = false;
  breakMessage = '';
}

const sipsLeft = (me) => Math.max(0, Math.min(me.sips_to_distribute, sipsAcked) - sipsPending);

// The tiles stay in place and only their text changes: a redraw under a finger would
// swallow the tap, and every shot of any player brings a new snapshot.
function renderDistribute(state) {
  const { game, players, me, palette, sip_transfers: transfers } = state;
  syncBreak(game);
  const left = sipsLeft(me);
  if (left <= 0) {
    const gaveAny = sipsPending > 0 || sipsAcked !== Infinity || transfers.some((t) => t.from_player === me.player_id);
    draw('sips-done', String(gaveAny), () => `<div class="ph-pad ph-center">
      <h1 class="ph-title">${gaveAny ? 'Alles verteilt' : 'Nichts zu verteilen'}</h1>
      <p class="dim">Warte auf die anderen.</p>
    </div>`);
    return;
  }
  const others = players.filter((p) => p.id !== me.player_id);
  const inkOf = (color) => palette.find((c) => c.color === color)?.ink || '#000000';
  const drawn = draw('sips', `${game.round_no}|${others.map((p) => p.id).join()}`, () => `<div class="ph-pad">
    <h1 class="ph-title sips-title" id="sips-title"></h1>
    <div class="tiles">${others.map((p) => `<button class="tile" style="--c:${esc(p.color)};--ink:${esc(inkOf(p.color))}" data-give="${esc(p.id)}" type="button"><span class="tile-name">${esc(p.name)}</span><small data-recv="${esc(p.id)}"></small></button>`).join('')}</div>
    <button class="btn btn-block" id="sips-random" data-random type="button">Zufall</button>
    <p class="small faint center">Automatisch per Zufall in <span id="sips-cd" data-cd="${new Date(game.phase_deadline).getTime()}"></span></p>
    <p class="form-err" id="sips-err" role="alert"></p>
  </div>`);
  if (drawn) updateCountdowns($('phone'));
  $('sips-title').textContent = `Du hast ${left} ${shotsWord(left)} zu verteilen`;
  // Own shots may be ahead of the snapshot, shots of others come only from it.
  for (const p of others) {
    let fromOthers = 0;
    let fromMe = 0;
    for (const t of transfers) {
      if (t.to_player !== p.id) continue;
      if (t.from_player === me.player_id) fromMe += t.amount;
      else fromOthers += t.amount;
    }
    const total = fromOthers + Math.max(fromMe, sipsToTarget.get(p.id) || 0);
    document.querySelector(`[data-recv="${p.id}"]`).textContent = `${total} erhalten`;
  }
  $('sips-err').textContent = breakMessage;
}

function showBreakMessage() {
  breakMessage = ERRORS.network;
  setTimeout(() => {
    breakMessage = '';
    redraw();
  }, NET_MESSAGE_MS);
}

function onGive(target) {
  const state = lastState;
  if (!state?.me || state.game.phase !== 'break_distribute' || sipsLeft(state.me) <= 0) return;
  sipsPending += 1;
  sipsToTarget.set(target, (sipsToTarget.get(target) || 0) + 1);
  redraw();
  const round = breakRound;
  sipsQueue = sipsQueue.then(async () => {
    try {
      const r = await rpc('give_sip', { p_code: syncedCode, p_token: token, p_target: target });
      if (round !== breakRound) return;
      sipsPending -= 1;
      if (r.ok) {
        sipsAcked = r.left;
      } else {
        sipsToTarget.set(target, Math.max(0, sipsToTarget.get(target) - 1));
        if (r.reason === 'nothing_left') sipsAcked = 0;
      }
    } catch (e) {
      console.warn(e);
      if (round !== breakRound) return;
      sipsPending -= 1;
      sipsToTarget.set(target, Math.max(0, sipsToTarget.get(target) - 1));
      showBreakMessage();
    }
    redraw();
  });
}

function onRandom() {
  const state = lastState;
  if (!state?.me || state.game.phase !== 'break_distribute' || sipsLeft(state.me) <= 0) return;
  const round = breakRound;
  const button = $('sips-random');
  if (button) button.disabled = true;
  sipsQueue = sipsQueue.then(async () => {
    try {
      const r = await rpc('give_sips_random', { p_code: syncedCode, p_token: token });
      if (round !== breakRound) return;
      if (r.ok || r.reason === 'nothing_left') sipsAcked = 0;
      sync?.refresh();
    } catch (e) {
      console.warn(e);
      if (round !== breakRound) return;
      showBreakMessage();
      const again = $('sips-random');
      if (again) again.disabled = false;
    }
    redraw();
  });
}

function renderDrink(state) {
  const { game, me, players } = state;
  syncBreak(game);
  if (me.ready || readySent) {
    draw('drink-ready', '', () => `<div class="ph-pad ph-center">
      <div class="ph-big ph-ok">✓</div>
      <h1 class="ph-title">Bereit</h1>
      <p class="dim">Warte auf die anderen.</p>
    </div>`);
    return;
  }
  const total = me.sips_to_drink;
  const byId = new Map(players.map((p) => [p.id, p]));
  const senders = me.sip_senders.map((s) => ({ ...s, player: byId.get(s.from_player) })).sort((a, b) => b.amount - a.amount || a.player.seat_no - b.player.seat_no);
  draw('drink', `${game.round_no}|${total}|${senders.map((s) => `${s.from_player}:${s.amount}`).join()}`, () => `<div class="ph-pad ph-center">
    <p class="label">Du musst trinken</p>
    <div class="ph-big ph-drink">${esc(total)}</div>
    <h1 class="ph-title">${shotsWord(total)}</h1>
    <ul class="plist">${senders.map((s) => `<li><span class="sw" style="--c:${esc(s.player.color)}"></span><strong class="grow">${esc(s.player.name)}</strong><b>${esc(s.amount)}</b></li>`).join('')}</ul>
    <p class="form-err" id="drink-err" role="alert"></p>
    <button class="btn btn-primary btn-big btn-block drink-go" id="drink-go" data-ready type="button">Getrunken &amp; bereit</button>
  </div>`);
}

async function onReady() {
  const button = $('drink-go');
  if (!button || button.disabled) return;
  await withBusy(button, async () => {
    try {
      const r = await rpc('confirm_ready', { p_code: syncedCode, p_token: token });
      if (r.ok) readySent = true;
      await sync?.refresh();
    } catch (e) {
      console.warn(e);
      const err = $('drink-err');
      if (err) err.textContent = ERRORS.network;
    }
  });
  redraw();
}

// ---------- Cashout ----------
const balloonsWord = (n) => (n === 1 ? 'Ballon' : 'Ballone');

// Integer arithmetic only: 1.37 must become exactly 137 cents. Null when it is no amount.
function parseCents(text) {
  const match = AMOUNT_RE.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}

// The field is only rebuilt when sent or not sent changes, typing is never disturbed.
function renderCashout({ me }) {
  const sent = me.cash_cents !== null && !cashEditing;
  const allowed = me.balloons_allowed;
  draw('cashout', `${sent}|${allowed}|${sent ? me.cash_cents : ''}`, () => `<form class="ph-pad" id="cash-form" autocomplete="off">
    <p class="label">Kassensturz</p>
    <h1 class="ph-title">Du darfst ${esc(allowed)} ${balloonsWord(allowed)} platzen lassen</h1>
    <p class="dim">Zähle dein Geld am Tisch und gib den Gesamtbetrag ein.</p>
    <div class="field"><label class="label" for="cash">Betrag in Euro</label>
      <input class="input amount" id="cash" inputmode="decimal" maxlength="7" placeholder="0.00" autocomplete="off" value="${me.cash_cents === null ? '' : (me.cash_cents / 100).toFixed(2)}" ${sent ? 'disabled' : ''}></div>
    ${sent
      ? '<p class="cash-ok">✓ Gesendet. Der Betrag bleibt verborgen.</p><button class="btn btn-block" id="cash-edit" data-cash-edit type="button">Ändern</button>'
      : '<button class="btn btn-primary btn-big btn-block" id="cash-go" type="submit">Senden</button><p class="form-err" id="cash-err" role="alert"></p>'}
  </form>`);
}

async function onCashSubmit(e) {
  e.preventDefault();
  const { game } = lastState;
  const cents = parseCents($('cash').value);
  const refuse = () => {
    $('cash-err').textContent = `Bitte einen Betrag wie 1.37 eingeben, höchstens ${(game.config.cash_max_cents / 100).toFixed(2)}.`;
  };
  if (cents === null || cents > game.config.cash_max_cents) return refuse();
  await withBusy($('cash-go'), async () => {
    try {
      const r = await rpc('submit_cash', { p_code: syncedCode, p_token: token, p_cents: cents });
      if (r.ok) {
        cashEditing = false;
        lastState.me.cash_cents = r.cash_cents;
        sync?.refresh();
      } else if (r.reason === 'bad_amount') {
        refuse();
      } else if (r.reason === 'wrong_phase') {
        sync?.refresh();
      }
    } catch (err) {
      console.warn(err);
      $('cash-err').textContent = ERRORS.network;
    }
  });
  redraw();
}

function renderReveal({ game, players, me }) {
  const inGroup = game.phase === 'tiebreak' && players.find((p) => p.id === me.player_id).tiebreak_group !== null;
  const drawn = draw('reveal', String(inGroup), () => `<div class="ph-pad ph-center">
    <h1 class="ph-title">${inGroup ? 'Gleichstand! Du spielst das Powersudoku.' : 'Kassensturz abgeschlossen'}</h1>
    ${inGroup
      ? `<div class="ph-big ph-ok"><span data-cd="${new Date(game.phase_deadline).getTime()}" data-fmt="s"></span></div>`
      : '<p class="dim">Schau auf den TV.</p>'}
  </div>`);
  if (drawn) updateCountdowns($('phone'));
}

// ---------- Tiebreak ----------
function renderTiebreak(state) {
  const { round, players, me } = state;
  const mine = players.find((p) => p.id === me.player_id);
  if (mine.tiebreak_group === null) {
    const drawn = draw('tie-watch', '', () => `<div class="ph-pad ph-center">
      <h1 class="ph-title">Zuschauen</h1>
      <p class="dim">Auf dem TV läuft das Powersudoku. Noch <span data-cd="${new Date(round.deadline).getTime()}"></span>.</p>
    </div>`);
    if (drawn) updateCountdowns($('phone'));
    return;
  }
  const winner = players.find((p) => p.tiebreak_group === mine.tiebreak_group && p.tiebreak_finished_at);
  if (winner) {
    draw('tie-done', winner.id, () => `<div class="ph-pad ph-center">
      <div class="ph-big ph-ok">✓</div>
      <h1 class="ph-title">${winner.id === me.player_id ? 'Du warst zuerst fertig!' : `${esc(winner.name)} war zuerst fertig`}</h1>
      <p class="dim">Warte auf die anderen Gruppen.</p>
    </div>`);
    return;
  }
  renderRound(state);
}

// ---------- Results ----------
const clockOf = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

function renderResults({ players, me, stats }) {
  const mine = players.find((p) => p.id === me.player_id);
  const s = stats.players.find((x) => x.player_id === me.player_id);
  draw('results', String(mine.final_rank), () => {
    const victim = s.favourite_victim;
    const perRound = s.lines_by_round.length > 1 ? ` (${s.lines_by_round.join(' · ')})` : '';
    const rows = [
      ['Beanspruchte Linien', `${s.lines_total}${perRound}`],
      ['Schnellste Linie', s.fastest_line_s === null ? '–' : `${clockOf(s.fastest_line_s)} ab Rundenstart`],
      ['Jagden', s.hunts_started ? `${s.hunts_success} von ${s.hunts_started} erfolgreich (${s.hunts_quote} %)` : 'keine'],
      ['Fehler', s.errors_total],
      ['Ausgelöste Sperren', s.locks_total],
      ['Shots verteilt', s.sips_given],
      ['Shots erhalten', s.sips_received],
      ['Lieblingsopfer', victim ? `${players.find((p) => p.id === victim.player_id).name}, ${victim.amount} ${shotsWord(victim.amount)}` : '–'],
    ];
    return `<div class="ph-pad">
      <p class="label">Dein Resultat</p>
      <div class="ph-big ph-rank">${esc(mine.final_rank)}. Rang</div>
      ${mine.rank_by_lot ? '<p class="lot-note">Per Los entschieden</p>' : ''}
      <h1 class="ph-title">${money(mine.cash_cents)}</h1>
      <div>${rows.map(([k, v]) => `<div class="statline"><span class="dim">${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
    </div>`;
  });
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
  if (digit) {
    onDigitTap(Number(digit.dataset.digit));
    return;
  }
  if (e.target.closest('[data-press]')) {
    onPress();
    return;
  }
  const give = e.target.closest('[data-give]');
  if (give) {
    onGive(give.dataset.give);
    return;
  }
  if (e.target.closest('[data-random]')) {
    onRandom();
    return;
  }
  if (e.target.closest('[data-cash-edit]')) {
    cashEditing = true;
    redraw();
    return;
  }
  if (e.target.closest('[data-ready]')) onReady();
});

$('phone').addEventListener('submit', (e) => {
  if (e.target.id === 'cash-form') onCashSubmit(e);
});

// Time passes without a new snapshot: countdowns, lock end, error window, end of an effect.
setInterval(() => {
  redraw();
  updateCountdowns($('phone'));
}, UI_TICK_MS);

const fromUrl = new URLSearchParams(location.search).get('g') || '';
renderJoin(CODE_RE.test(fromUrl) ? fromUrl : '');
if (CODE_RE.test(fromUrl)) connect(fromUrl);
