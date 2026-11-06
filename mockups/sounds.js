// Sound mock-up: plays short scenes on the real TV view (real grid.js, real TV styles) and
// fires every sound exactly when it would happen in the game. The sound list next to it
// switches the variants. Mock data only, nothing talks to the server.

import { gridHtml } from '../js/grid.js';
import { REVEAL_FX } from '../js/config.js';
import { updateCountdowns } from '../js/clock.js';
import { $, esc, money } from '../js/util.js';
import { SOUNDS, unlock, play, preview, cutScene, chosen, choose, setVolume } from './sound-variants.js';

const STAGE_W = 1920;
const { givens: GIVENS, solution: SOL } = window.MOCK_DATA.puzzles['9'];
const N = 9;

const PALETTE = [
  { color: '#E5484D', ink: '#FFFFFF' }, { color: '#F76B15', ink: '#000000' }, { color: '#FFC53D', ink: '#000000' },
  { color: '#30A46C', ink: '#000000' }, { color: '#12A594', ink: '#000000' }, { color: '#3E63DD', ink: '#FFFFFF' },
  { color: '#8E4EC6', ink: '#FFFFFF' },
];
const NAMES = ['Anna', 'Ben', 'Cara', 'Dario', 'Elif', 'Finn', 'Gina'];
const P = Object.fromEntries(NAMES.map((n, i) => [n, `p${i}`]));
const inkOf = (color) => PALETTE.find((c) => c.color === color)?.ink || '#000000';
const soundName = new Map(SOUNDS.map((s) => [s.id, s.name]));

const lineCells = (type, i) => Array.from({ length: N }, (_, k) => (type === 'row' ? i * N + k : k * N + i));
const label = (type, i) => `${type === 'row' ? 'Zeile' : 'Spalte'} ${i + 1}`;

let st = null; // current mock snapshot, same shape as get_state
let screen = '';
let gridKey = '';
let roundSeq = 0;
let timers = [];
let chapterStart = 0;
let playingAll = false;

// ---------------------------------------------------------------------------
// Mock snapshot
// ---------------------------------------------------------------------------

function players(lines = [0, 0, 0, 0, 0, 0, 0], hunts = [0, 0, 0, 0, 0, 0, 0]) {
  return NAMES.map((name, i) => ({ id: `p${i}`, name, color: PALETTE[i].color, lines_claimed: lines[i], hunts_success: hunts[i] }));
}

function roundState({ no, balloons, mainAgoS, deadlineInS, lines = [], counts, hunts, ticker = [] }) {
  const t = Date.now();
  roundSeq++;
  const s = {
    game: { phase: 'round_running', balloons_left: balloons, main_started_at: new Date(t - mainAgoS * 1000).toISOString(), config: { game_limit_s: 1500 } },
    round: { id: `mock-${roundSeq}`, kind: 'main', size: N, round_no: no, givens: GIVENS, revealed: GIVENS, deadline: new Date(t + deadlineInS * 1000).toISOString() },
    lines: [],
    players: players(counts, hunts),
    palette: PALETTE,
    hunts_active: [],
    ticker,
  };
  // Lines solved before the scene starts carry an old timestamp, so they show no effect.
  for (const [type, idx, who] of lines) lockLine(s, type, idx, who, null, t - 300000);
  return s;
}

function lockLine(s, type, idx, who, origin, at = Date.now()) {
  const cells = lineCells(type, idx);
  const rev = [...s.round.revealed];
  cells.forEach((c) => { rev[c] = SOL[c]; });
  s.round.revealed = rev.join('');
  s.lines.push({
    line_type: type, idx, status: who ? 'claimed' : 'neutral', player_id: who ? P[who] : null,
    claimed_at: new Date(at).toISOString(), origin_cell: who ? origin : null,
  });
}

const isLocked = (type, idx) => st.lines.some((l) => l.line_type === type && l.idx === idx);

/** A player claims one or two lines: balloons pop cell by cell, then the line lights up. */
function claim(who, lines, origin, huntS = 50) {
  const fx = REVEAL_FX.balloon;
  const covered = new Set(st.lines.flatMap((l) => lineCells(l.line_type, l.idx)));
  const pops = [];
  let glow = 0;
  for (const [type, idx] of lines) {
    const cells = lineCells(type, idx);
    const originK = cells.indexOf(origin);
    const reach = Math.max(originK, N - 1 - originK);
    cells.forEach((c, k) => {
      if (GIVENS[c] === '0' && !covered.has(c)) pops.push(fx.lead + Math.abs(k - originK) * fx.step);
    });
    cells.forEach((c) => covered.add(c));
    glow = Math.max(glow, fx.lead + reach * fx.step + fx.cell * 0.35);
  }
  pops.sort((a, b) => a - b).forEach((ms, i) => fire('pop', ms / 1000, { i }));
  fire('line', glow / 1000);
  for (const [type, idx] of lines) lockLine(st, type, idx, who, origin);
  const p = st.players.find((x) => x.name === who);
  p.lines_claimed += lines.length;
  const text = lines.map(([type, idx]) => label(type, idx)).join(' + ');
  if (st.game.balloons_left > 0) {
    const t = Date.now();
    st.hunts_active.push({ id: `h-${who}-${t}`, player_id: P[who], kind: 'main', lines_label: text, started_at: new Date(t).toISOString(), deadline: new Date(t + huntS * 1000).toISOString() });
  }
  st.ticker.unshift(`${who} löst ${text}`);
  render();
  return glow / 1000;
}

function neutral(lines) {
  for (const [type, idx] of lines) lockLine(st, type, idx, null, null);
  fire('neutral', 0);
  st.ticker.unshift(lines.length === 1 ? `${label(...lines[0])} neutral aufgedeckt` : 'Zeit abgelaufen: offene Linien aufgedeckt');
  render();
}

function endHunt(who) {
  st.hunts_active = st.hunts_active.filter((h) => h.player_id !== P[who]);
}

// ---------------------------------------------------------------------------
// TV screens (markup as in js/tv.js)
// ---------------------------------------------------------------------------

function render() {
  if (st.screen === 'distribute') renderDistribute();
  else if (st.screen === 'drink') renderDrink();
  else if (st.screen === 'reveal') renderReveal();
  else if (st.screen === 'results') renderResults();
  else renderRound();
}

function huntsHtml() {
  const hunts = st.hunts_active;
  if (!hunts.length) return '<p class="hunts-empty">Gerade keine Jagd.</p>';
  const byId = new Map(st.players.map((p) => [p.id, p]));
  return `<div class="hunts ${hunts.length <= 3 ? 'few' : ''}">${hunts.map((h) => {
    const p = byId.get(h.player_id);
    const start = new Date(h.started_at).getTime();
    const end = new Date(h.deadline).getTime();
    return `<div class="hunt-row" style="--c:${esc(p.color)}"><i class="fill" data-bar-start="${start}" data-bar-end="${end}"></i><span class="hl">${esc(p.name)} · ${esc(h.lines_label)}</span><span><span data-cd="${end}" data-fmt="s"></span> s</span></div>`;
  }).join('')}</div>`;
}

function renderRound() {
  const { game, round, players: list } = st;
  if (screen !== 'round') {
    screen = 'round';
    gridKey = '';
    $('tv').innerHTML = '<div class="tv-round"><div class="tv-grid" id="tv-grid"></div><div class="tv-side" id="tv-side"></div><div class="tv-banner" id="tv-banner" hidden></div></div>';
  }
  const key = `${round.id}/${st.lines.length}/${round.revealed}`;
  if (key !== gridKey) {
    gridKey = key;
    $('tv-grid').style.setProperty('--n', N);
    $('tv-grid').innerHTML = gridHtml(st);
  }
  const ending = game.phase !== 'round_running';
  const roundValue = ending ? '–' : `<span data-cd="${new Date(round.deadline).getTime()}"></span>`;
  const left = game.balloons_left;
  const mainHunts = st.hunts_active.length;
  let huntsTitle = '<h2 class="tv-label tv-hunts-title">Jagden</h2>';
  if (left === 1 && mainHunts >= 2) huntsTitle = '<h2 class="tv-race">Wettrennen um den letzten Ballon!</h2>';
  else if (left > 0 && mainHunts > left) huntsTitle = `<h2 class="tv-race">Wettrennen: ${mainHunts} Jagden, ${left} Ballone</h2>`;
  const banner = $('tv-banner');
  banner.hidden = !st.emptiedBy;
  if (st.emptiedBy) banner.innerHTML = `<b>HALLE LEER!</b><span>${esc(st.emptiedBy)} hat den letzten Ballon geholt</span>`;
  $('tv-side').innerHTML = `
    ${ending ? `<div><span class="tv-tag">RUNDE ${round.round_no} BEENDET</span></div>` : ''}
    <div class="tv-stats">
      <div class="tv-panel tv-stat"><span class="tv-label">Spiel</span><b><span data-cd="${new Date(game.main_started_at).getTime() + game.config.game_limit_s * 1000}"></span></b></div>
      <div class="tv-panel tv-stat"><span class="tv-label">Runde ${round.round_no}</span><b>${roundValue}</b></div>
      <div class="tv-panel tv-stat hot"><span class="tv-label">Ballone</span><b>${left}</b></div>
    </div>
    <div class="tv-panel">${huntsTitle}${huntsHtml()}</div>
    <div class="tv-panel"><div class="score">
      <span></span><span class="h" style="text-align:left">Spieler</span><span class="h">Linien</span><span class="h">Jagden ✓</span>
      ${list.map((p) => `<span class="sw" style="--c:${esc(p.color)}"></span><span>${esc(p.name)}</span><span class="n">${p.lines_claimed}</span><span class="n">${p.hunts_success}</span>`).join('')}
    </div></div>
    <div class="tv-panel" style="flex:1"><div class="ticker">${st.ticker.slice(0, 5).map((t) => `<div>${esc(t)}</div>`).join('')}</div></div>`;
  paintClock();
}

const shotsWord = (n) => (n === 1 ? 'Shot' : 'Shots');

function renderDistribute() {
  if (screen !== 'distribute') {
    screen = 'distribute';
    $('tv').innerHTML = `<div class="tv-break">
      <div class="tv-break-head"><h1 class="tv-title">Pause: Wer gibt wem?</h1>
        <span class="tv-label">Automatisch in <b class="tv-break-cd"><span data-cd="${st.breakDeadline}"></span></b></span></div>
      <table class="matrix" id="tv-matrix"></table>
    </div>`;
  }
  const sum = new Map();
  for (const t of st.transfers) sum.set(`${t.from}/${t.to}`, (sum.get(`${t.from}/${t.to}`) || 0) + 1);
  const head = st.players.map((p) => `<th><span class="sw" style="--c:${esc(p.color)}"></span>${esc(p.name)}</th>`).join('');
  const rows = st.players.map((from) => {
    const cells = st.players.map((to) => {
      if (from.id === to.id) return '<td class="self"></td>';
      const n = sum.get(`${from.id}/${to.id}`) || 0;
      return `<td class="${n ? 'hit' : ''}" style="--c:${esc(from.color)}">${n || ''}</td>`;
    }).join('');
    const total = st.toGive[from.id] || 0;
    const given = st.transfers.filter((t) => t.from === from.id).length;
    let status = `<td class="state">${total ? '✓ verteilt' : 'nichts'}</td>`;
    if (given < total) status = `<td class="state">noch ${total - given}</td>`;
    else if (total) status = '<td class="state ok">✓ verteilt</td>';
    return `<tr><th class="from"><span class="sw" style="--c:${esc(from.color)}"></span>${esc(from.name)}</th>${cells}${status}</tr>`;
  }).join('');
  $('tv-matrix').innerHTML = `<thead><tr><th class="from-head"></th>${head}<th class="state-head">Status</th></tr></thead><tbody>${rows}</tbody>`;
  paintClock();
}

function renderDrink() {
  if (screen !== 'drink') {
    screen = 'drink';
    $('tv').innerHTML = `<div class="tv-break">
      <h1 class="tv-title">Pause: Trinken &amp; bereit machen</h1>
      <div class="cash-grid" id="tv-drink"></div>
      <div class="tv-break-foot"><span class="dim">Das nächste Sudoku startet, sobald alle bereit sind.</span></div>
    </div>`;
  }
  const drink = new Map();
  for (const t of st.transfers) drink.set(t.to, (drink.get(t.to) || 0) + 1);
  $('tv-drink').innerHTML = st.players.map((p) => {
    const n = drink.get(p.id) || 0;
    const ok = st.ready.has(p.id);
    return `<div class="cash-row"><span class="sw" style="--c:${esc(p.color)}"></span><div>${esc(p.name)}<small>trinkt ${n} ${shotsWord(n)}</small></div><span class="tick ${ok ? '' : 'no'}">${ok ? '✓' : '…'}</span></div>`;
  }).join('');
}

const MASK = '• • • • •';
const CASH_COUNT_S = 8;
const CASH_STEP_S = 5;

function cashOrder() {
  return st.players.slice().sort((a, b) => b.cash_cents - a.cash_cents).map((p, i) => ({ rank: i + 1, p }));
}

function renderReveal() {
  if (screen === 'reveal') return;
  screen = 'reveal';
  const rising = st.players.slice().sort((a, b) => a.cash_cents - b.cash_cents);
  const ranked = cashOrder();
  $('tv').innerHTML = `<div class="cr">
    <div class="cr-head"><h1 class="tv-title">Kassensturz</h1><span class="cr-step" id="cr-step"></span></div>
    <div class="cr-body">
      <div class="cr-chart-box">
        <div class="cr-chart" style="--n:${rising.length}">${rising.map((p) => `<div class="cr-col" data-pid="${p.id}" style="--c:${esc(p.color)}"><div class="cr-amt" data-cents="${p.cash_cents}">${money(0)}</div><div class="cr-bar" data-bar="${p.cash_cents}"></div></div>`).join('')}</div>
        <div class="cr-names" style="--n:${rising.length}">${rising.map((p) => `<div data-pid="${p.id}" style="--c:${esc(p.color)}">?</div>`).join('')}</div>
      </div>
      <div class="cr-table">${ranked.map(({ rank, p }) => `<div class="cr-row" data-pid="${p.id}" style="--c:${esc(p.color)}"><span class="cr-rk">${rank}.</span><span class="cr-sw"></span><span class="cr-nm">${MASK}</span><span class="cr-val" data-cents="${p.cash_cents}">${money(0)}</span></div>`).join('')}</div>
    </div>
    <div class="cr-foot"><span>Summe aller Eingaben: <b id="cr-sum">${money(0)}</b> von max. ${money(940)}</span><span class="cr-next" id="cr-next"></span></div>
  </div>`;
  requestAnimationFrame(paintReveal);
}

function paintReveal() {
  if (screen !== 'reveal' || st.screen !== 'reveal') return;
  const t = (Date.now() - st.revealStart) / 1000;
  const list = st.players;
  const max = Math.max(1, ...list.map((p) => p.cash_cents));
  const shown = (cents) => (t >= CASH_COUNT_S ? cents : Math.min(cents, Math.floor((max * t) / CASH_COUNT_S)));
  document.querySelectorAll('.cr [data-cents]').forEach((el) => { el.textContent = money(shown(Number(el.dataset.cents))); });
  document.querySelectorAll('.cr [data-bar]').forEach((el) => { el.style.setProperty('--h', shown(Number(el.dataset.bar)) / max); });
  $('cr-sum').textContent = money(list.reduce((sum, p) => sum + shown(p.cash_cents), 0));
  const order = cashOrder().reverse();
  const done = t < CASH_COUNT_S ? 0 : Math.min(order.length, 1 + Math.floor((t - CASH_COUNT_S) / CASH_STEP_S));
  const open = new Set(order.slice(0, done).map((g) => g.p.id));
  const top = order[order.length - 1].p.id;
  const nameOf = new Map(list.map((p) => [p.id, p.name]));
  document.querySelectorAll('.cr-col').forEach((el) => {
    el.classList.toggle('shown', open.has(el.dataset.pid));
    el.classList.toggle('top', open.has(el.dataset.pid) && el.dataset.pid === top);
  });
  document.querySelectorAll('.cr-names div, .cr-row').forEach((el) => {
    const on = open.has(el.dataset.pid);
    if (on === el.classList.contains('shown')) return;
    el.classList.toggle('shown', on);
    const target = el.classList.contains('cr-row') ? el.querySelector('.cr-nm') : el;
    target.textContent = on ? nameOf.get(el.dataset.pid) : (el.classList.contains('cr-row') ? MASK : '?');
  });
  if (done === 0) $('cr-step').textContent = 'Die Beträge steigen …';
  else if (done < order.length) $('cr-step').innerHTML = `Platz <b>${order[done - 1].rank}.</b> aufgedeckt · nächster in <b>${Math.max(0, Math.ceil(CASH_COUNT_S + done * CASH_STEP_S - t))}</b> s`;
  else $('cr-step').textContent = 'Alle aufgedeckt';
  $('cr-next').innerHTML = done >= order.length ? `Rangliste in <b>${Math.max(0, Math.ceil(CASH_COUNT_S + order.length * CASH_STEP_S - t))}</b> s` : '';
  requestAnimationFrame(paintReveal);
}

const PODIUM_HEIGHTS = { 1: 460, 2: 340, 3: 260 };

function renderResults() {
  if (screen === 'results') return;
  screen = 'results';
  const ranked = cashOrder();
  const pod = ({ rank, p }) => `<div class="pod" style="--c:${esc(p.color)};--ink:${esc(inkOf(p.color))};height:${PODIUM_HEIGHTS[rank]}px"><b>${rank}</b><span class="pod-name">${esc(p.name)}</span><span class="pod-cash">${money(p.cash_cents)}</span></div>`;
  const rows = ranked.map(({ rank, p }, i) => `<tr><td class="l">${rank}</td><td class="l"><span class="sw" style="--c:${esc(p.color)}"></span>${esc(p.name)}</td>
    <td>${money(p.cash_cents)}</td><td>${p.lines_claimed}</td><td>${['0:48', '1:05', '0:52', '1:31', '1:12', '2:03', '1:40'][i]}</td>
    <td>${p.hunts_success}/${p.hunts_success + (i % 3)}</td><td>${[2, 4, 1, 6, 3, 2, 5][i]}</td><td>${i === 3 ? 1 : 0}</td><td>${p.lines_claimed}</td><td>${[5, 7, 6, 4, 8, 6, 9][i]}</td></tr>`).join('');
  $('tv').innerHTML = `<div class="res">
    <div class="res-left"><h1 class="tv-title">Rangliste</h1><div class="podium">${[ranked[1], ranked[0], ranked[2]].map(pod).join('')}</div></div>
    <div class="res-right">
      <table class="rtable"><thead><tr><th class="l">Rang</th><th class="l">Name</th><th>Betrag</th><th>Linien</th><th>Schnellste</th><th>Jagden</th><th>Fehler</th><th>Sperren</th><th>Verteilt</th><th>Erhalten</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="awards">
        <div class="award"><span>Linien-König</span>Cara<small>14 Linien</small></div>
        <div class="award"><span>Jagd-Profi</span>Anna<small>8 von 9</small></div>
        <div class="award"><span>Fehlerteufel</span>Dario<small>6 Fehler</small></div>
        <div class="award"><span>Shot-Magnet</span>Gina<small>9 erhalten</small></div>
        <div class="award"><span>Grosszügigster</span>Cara<small>14 verteilt</small></div>
      </div>
    </div>
  </div>`;
}

function paintClock() {
  updateCountdowns($('tv'));
  const now = Date.now();
  document.querySelectorAll('#tv [data-bar-end]').forEach((el) => {
    const start = Number(el.dataset.barStart);
    const end = Number(el.dataset.barEnd);
    el.style.width = `${Math.max(0, Math.min(100, (100 * (end - now)) / (end - start)))}%`;
  });
}

// ---------------------------------------------------------------------------
// Scenes. Each step: seconds from the chapter start, what happens, which sounds.
// ---------------------------------------------------------------------------

const at = (s, fn) => timers.push(setTimeout(fn, s * 1000));

function fire(id, delay = 0, opt = {}) {
  play(id, delay, opt);
  setTimeout(() => flashSound(id), delay * 1000);
}

function say(text, ids = []) {
  const t = ((Date.now() - chapterStart) / 1000).toFixed(1);
  const sounds = ids.map((id) => `«${soundName.get(id)}»`).join(' + ');
  $('caption').innerHTML = `<b>${esc(text)}</b>${sounds ? `<span>Ton: ${esc(sounds)}</span>` : '<span>kein Ton</span>'}`;
  const li = document.createElement('li');
  li.innerHTML = `<span class="t">${t} s</span><span>${esc(text)}</span><span class="s">${esc(sounds || '–')}</span>`;
  $('log').prepend(li);
}

const CHAPTERS = [
  {
    title: 'Sudoku startet',
    note: 'Linien lösen, Jagden, Sperre. Zeiten gerafft.',
    len: 24,
    run() {
      st = roundState({ no: 2, balloons: 21, mainAgoS: 570, deadlineInS: 480.4, counts: [3, 2, 2, 1, 2, 1, 2], hunts: [2, 2, 1, 1, 2, 1, 1], ticker: ['Jagd von Gina erfolgreich', 'Elif löst Spalte 9'] });
      render();
      at(0.3, () => { st.ticker.unshift('Runde 2 startet'); render(); fire('start'); say('Sudoku 2 startet', ['start']); });
      at(2.8, () => { claim('Anna', [['row', 3]], 34); say('Anna löst Zeile 4, ihre Jagd startet', ['pop', 'line']); });
      at(7, () => { st.ticker.unshift('Ben ist 20 s gesperrt'); render(); fire('lock'); say('Ben macht den 3. Fehler und ist 20 s gesperrt', ['lock']); });
      at(9.5, () => { neutral([['col', 0]]); say('Spalte 1 ist durch Aufdecken voll: neutral', ['neutral']); });
      at(12, () => { claim('Cara', [['row', 1], ['col', 6]], 15, 8.5); say('Cara löst Zeile 2 + Spalte 7 mit einer Ziffer: eine Jagd', ['pop', 'line']); });
      at(16.5, () => { endHunt('Anna'); st.game.balloons_left--; st.players[0].hunts_success++; st.ticker.unshift('Jagd von Anna erfolgreich'); render(); fire('success'); say('Anna drückt «Ballon im Depot»', ['success']); });
      at(20.5, () => { endHunt('Cara'); st.ticker.unshift('Jagd von Cara: Zeit abgelaufen'); render(); fire('fail'); say('Caras 50 s sind um (hier gerafft auf 8 s)', ['fail']); });
    },
  },
  {
    title: 'Letzte 10 Sekunden',
    note: 'Rundentimer läuft ab, offene Linien werden grau.',
    len: 16,
    run() {
      st = roundState({
        no: 3, balloons: 12, mainAgoS: 1010, deadlineInS: 11.6, counts: [5, 4, 6, 3, 4, 3, 4], hunts: [4, 3, 4, 2, 3, 2, 3],
        lines: [['row', 0, 'Anna'], ['row', 2, 'Ben'], ['col', 4, 'Cara'], ['col', 8, 'Dario'], ['row', 6, 'Elif'], ['col', 1, 'Gina'], ['row', 8, null]],
        ticker: ['Gina löst Spalte 2', 'Jagd von Elif erfolgreich', 'Elif löst Zeile 7'],
      });
      render();
      say('Noch 11 Sekunden in Sudoku 3');
      const deadline = new Date(st.round.deadline).getTime();
      for (let left = 10; left >= 1; left--) {
        at((deadline - left * 1000 - chapterStart) / 1000, () => { fire('countdown', 0, { left }); if (left === 10 || left === 3) say(`Rundentimer ${left === 10 ? '0:10' : '0:03'}`, ['countdown']); });
      }
      at((deadline - chapterStart) / 1000, () => {
        st.game.phase = 'round_ending';
        fire('end');
        const open = [];
        for (const type of ['row', 'col']) for (let i = 0; i < N; i++) if (!isLocked(type, i)) open.push([type, i]);
        timers.push(setTimeout(() => neutral(open), 250));
        render();
        say('Zeit abgelaufen: Runde vorbei, offene Linien grau', ['end', 'neutral']);
      });
    },
  },
  {
    title: 'Pause',
    note: 'Shots verteilen, dann alle bereit.',
    len: 15,
    run() {
      st = roundState({ no: 3, balloons: 12, mainAgoS: 1040, deadlineInS: 0, counts: [5, 4, 6, 3, 4, 3, 4] });
      st.screen = 'distribute';
      st.breakDeadline = Date.now() + 60000;
      st.transfers = [];
      st.toGive = { p0: 2, p2: 3, p3: 1, p5: 2 };
      st.ready = new Set();
      render();
      say('Pause: Wer gibt wem?');
      const shots = [['p2', 'p1'], ['p0', 'p3'], ['p2', 'p1'], ['p5', 'p6'], ['p3', 'p0'], ['p2', 'p4'], ['p0', 'p6'], ['p5', 'p2']];
      shots.forEach(([from, to], i) => at(0.8 + i * 0.7, () => {
        st.transfers.push({ from, to });
        render();
        fire('shot');
        if (i === 0) say('Jeder verteilte Shot', ['shot']);
      }));
      at(7.3, () => { st.screen = 'drink'; render(); say('Trinken & bereit machen'); });
      st.players.forEach((p, i) => at(8 + i * 0.45, () => { st.ready.add(p.id); render(); }));
      at(11.8, () => {
        st = roundState({ no: 4, balloons: 12, mainAgoS: 1052, deadlineInS: 480, counts: [5, 4, 6, 3, 4, 3, 4], hunts: [4, 3, 4, 2, 3, 2, 3], ticker: ['Runde 4 startet'] });
        render();
        fire('start');
        say('Alle bereit: Sudoku 4 startet', ['start']);
      });
    },
  },
  {
    title: 'Der letzte Ballon',
    note: 'Wettrennen und Halle leer.',
    len: 13,
    run() {
      st = roundState({
        no: 5, balloons: 1, mainAgoS: 1380, deadlineInS: 230, counts: [7, 5, 8, 5, 6, 4, 5], hunts: [6, 5, 6, 4, 5, 4, 4],
        lines: [['row', 0, 'Cara'], ['col', 4, 'Anna'], ['row', 7, 'Dario'], ['col', 8, null]],
        ticker: ['Dario löst Zeile 8', 'Jagd von Ben erfolgreich'],
      });
      const t = Date.now();
      st.hunts_active.push({ id: 'h-dario', player_id: P.Dario, kind: 'main', lines_label: 'Zeile 8', started_at: new Date(t - 18000).toISOString(), deadline: new Date(t + 32000).toISOString() });
      render();
      say('Noch 1 Ballon in der Halle, Dario jagt ihn');
      at(1, () => {
        const glow = claim('Elif', [['col', 2]], 38);
        say('Elif löst Spalte 3: zwei Jagden, ein Ballon', ['pop', 'line']);
        timers.push(setTimeout(() => { fire('race'); say('Wettrennen um den letzten Ballon!', ['race']); }, (glow + 0.6) * 1000));
      });
      at(7, () => {
        st.hunts_active = [];
        st.game.balloons_left = 0;
        st.game.phase = 'round_ending';
        st.players[4].hunts_success++;
        st.emptiedBy = 'Elif';
        st.ticker.unshift('Halle leer: Elif holt den letzten Ballon');
        render();
        fire('success');
        fire('empty', 0.7);
        say('Elif bestätigt zuerst: Halle leer, Spiel vorbei', ['success', 'empty']);
      });
    },
  },
  {
    title: 'Kassensturz',
    note: 'Säulen steigen, Platz für Platz bis zum Sieger.',
    len: 46,
    run() {
      st = { screen: 'reveal', players: players([8, 5, 14, 6, 9, 4, 7], [8, 4, 7, 3, 6, 3, 4]), revealStart: Date.now() };
      [185, 90, 210, 55, 145, 120, 35].forEach((c, i) => { st.players[i].cash_cents = c; });
      render();
      fire('rise', 0, { dur: CASH_COUNT_S });
      say('Die Beträge steigen, ohne Namen', ['rise']);
      const order = cashOrder().reverse();
      order.forEach(({ rank, p }, k) => at(CASH_COUNT_S + k * CASH_STEP_S, () => {
        const last = k === order.length - 1;
        fire(last ? 'winner' : 'place');
        say(`Platz ${rank}: ${p.name}`, [last ? 'winner' : 'place']);
      }));
      at(CASH_COUNT_S + order.length * CASH_STEP_S, () => { st.screen = 'results'; render(); say('Rangliste'); });
    },
  },
];

function stopScene() {
  timers.forEach(clearTimeout);
  timers = [];
  cutScene();
}

function runChapter(i) {
  unlock();
  stopScene();
  screen = '';
  chapterStart = Date.now();
  document.querySelectorAll('#chapters button').forEach((b, k) => b.classList.toggle('on', k === i));
  $('log').innerHTML = '';
  CHAPTERS[i].run();
  if (playingAll && i < CHAPTERS.length - 1) at(CHAPTERS[i].len + 1, () => runChapter(i + 1));
  else at(CHAPTERS[i].len + 1, () => { playingAll = false; paintTransport(); });
  paintTransport();
}

function paintTransport() {
  $('play-all').textContent = playingAll ? 'Läuft …' : '▶ Alles abspielen';
}

// ---------------------------------------------------------------------------
// Sound list
// ---------------------------------------------------------------------------

function renderSounds() {
  $('sounds').innerHTML = SOUNDS.map((s) => `<div class="snd" data-id="${s.id}">
    <div class="snd-head"><b>${esc(s.name)}</b><small>${esc(s.when)}</small></div>
    <div class="snd-vars">${s.variants.map((v) => `<button type="button" class="${chosen(s.id) === v.key ? 'on' : ''}" data-var="${v.key}">${v.key === 'off' ? '' : `<i>${v.key}</i>`}${esc(v.label)}</button>`).join('')}</div>
  </div>`).join('');
  paintSummary();
}

function paintSummary() {
  $('summary').textContent = SOUNDS.map((s) => {
    const v = s.variants.find((x) => x.key === chosen(s.id));
    return `${s.name}: ${v.key === 'off' ? 'aus' : `${v.key} (${v.label})`}`;
  }).join('\n');
}

function flashSound(id) {
  const el = document.querySelector(`.snd[data-id="${id}"]`);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

$('sounds').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-var]');
  if (!btn) return;
  const id = btn.closest('.snd').dataset.id;
  choose(id, btn.dataset.var);
  btn.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
  paintSummary();
  preview(id, btn.dataset.var);
});

$('chapters').innerHTML = CHAPTERS.map((c, i) => `<button type="button" data-ch="${i}"><b>${i + 1}. ${esc(c.title)}</b><small>${esc(c.note)}</small></button>`).join('');
$('chapters').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-ch]');
  if (!btn) return;
  playingAll = false;
  runChapter(Number(btn.dataset.ch));
});
$('play-all').addEventListener('click', () => { playingAll = true; runChapter(0); });
$('stop').addEventListener('click', () => { playingAll = false; stopScene(); paintTransport(); say('Angehalten'); });
$('volume').addEventListener('input', (e) => setVolume(Number(e.target.value)));
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('summary').textContent);
    $('copy').textContent = 'Kopiert ✓';
  } catch {
    $('copy').textContent = 'Bitte von Hand markieren';
  }
  setTimeout(() => { $('copy').textContent = 'Auswahl kopieren'; }, 2000);
});

function fitStage() {
  const box = $('stage-box');
  $('tv').style.transform = `scale(${box.clientWidth / STAGE_W})`;
}
window.addEventListener('resize', fitStage);
fitStage();
setInterval(() => { if (st && screen !== 'reveal') paintClock(); }, 250);

renderSounds();
// Still picture of the first scene until something is played (sound needs a click first).
st = roundState({ no: 2, balloons: 21, mainAgoS: 570, deadlineInS: 480, counts: [3, 2, 2, 1, 2, 1, 2], hunts: [2, 2, 1, 1, 2, 1, 1], ticker: ['Jagd von Gina erfolgreich', 'Elif löst Spalte 9'] });
render();
