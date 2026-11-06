#!/usr/bin/env node
// Bot simulation (CLAUDE.md section 10.3).
//
// Creates a game on the real Supabase project (URL and publishable key from js/config.js), lets
// bots join and play it through to the ranking, and acts as the TV: it calls tick, starts the
// game and closes the cashout. The bots never see a solution: like a person they only find
// Naked and Hidden Singles in what their phone shows (givens, revealed lines, own entries).
//
//   node tools/bots.mjs --players 7 --speed normal
//
// Options (all optional):
//   --players N        2 to 8 (default 7)
//   --speed S          slow | normal | fast: thinking time per digit (default normal)
//   --scale F          runs F times faster: all times in the config and the bots are divided
//                      by F; the report converts back to real time (default 1)
//   --difficulty D     leicht | mittel (default leicht)
//   --trial            play the 4x4 trial round first
//   --error-rate P     share of wrong digits (default 0.05)
//   --hunt-success P   share of hunts confirmed in time (default 0.75)
//   --no-balloon P     share of hunts given up with «Kein Ballon gefunden» (default 0.1);
//                      the rest comes back too late
//   --balloons N       balloons in the hall (default from the config)
//   --pin PIN          host PIN (default 4711)
//   --seed N           random seed for the bots (default: time)
//   --max-minutes M    stop after M minutes of real game time (default 90)
//
// While it runs, the TV view can watch: tv.html → «Verbinden» with the printed code and PIN.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geometry, candidateMask, makeRng } from './sudoku-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const SPEED_S = { slow: 14, normal: 9, fast: 5 }; // mean thinking time per 9x9 digit, real seconds
const SIZE_FACTOR = { 4: 0.4, 6: 0.6, 9: 1 };
const NAMES = ['Anna', 'Ben', 'Cara', 'Dario', 'Elif', 'Finn', 'Gina', 'Hugo'];
const COLORS = ['#E5484D', '#F76B15', '#FFC53D', '#30A46C', '#12A594', '#3E63DD', '#8E4EC6', '#D6409F'];

function parseArgs(argv) {
  const o = {
    players: 7, speed: 'normal', scale: 1, difficulty: 'leicht', trial: false,
    errorRate: 0.05, huntSuccess: 0.75, noBalloon: 0.1, balloons: null,
    pin: '4711', seed: Date.now() % 1e9, maxMinutes: 90,
  };
  const keys = {
    '--players': ['players', Number], '--speed': ['speed', String], '--scale': ['scale', Number],
    '--difficulty': ['difficulty', String], '--error-rate': ['errorRate', Number],
    '--hunt-success': ['huntSuccess', Number], '--no-balloon': ['noBalloon', Number],
    '--balloons': ['balloons', Number], '--pin': ['pin', String], '--seed': ['seed', Number],
    '--max-minutes': ['maxMinutes', Number],
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--trial') { o.trial = true; continue; }
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    const k = keys[a];
    if (!k) throw new Error(`unknown option ${a}`);
    const v = k[1](argv[++i]);
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${a} needs a number`);
    o[k[0]] = v;
  }
  if (!(o.players >= 2 && o.players <= 8)) throw new Error('--players must be 2 to 8');
  if (!SPEED_S[o.speed]) throw new Error('--speed must be slow, normal or fast');
  if (!(o.scale >= 1)) throw new Error('--scale must be 1 or more');
  if (!['leicht', 'mittel'].includes(o.difficulty)) throw new Error('--difficulty must be leicht or mittel');
  if (o.huntSuccess + o.noBalloon > 1) throw new Error('--hunt-success + --no-balloon must not exceed 1');
  return o;
}

let opt;
try {
  opt = parseArgs(process.argv);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
if (opt.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 30).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
const rng = makeRng(opt.seed);
const between = (a, b) => a + (b - a) * rng();
const realMs = (seconds) => (seconds * 1000) / opt.scale; // real seconds -> wall clock ms

// ---------------------------------------------------------------------------
// Server access
// ---------------------------------------------------------------------------

const cfgJs = readFileSync(join(ROOT, 'js', 'config.js'), 'utf8');
const URL_ = cfgJs.match(/SUPABASE_URL = '([^']+)'/)[1];
const KEY = cfgJs.match(/SUPABASE_PUBLISHABLE_KEY = '([^']+)'/)[1];
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;
let networkErrors = 0;

async function rpc(fn, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      requests++;
      const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) throw new Error(`${fn}: HTTP ${res.status} ${out.message || JSON.stringify(out)}`);
      return out;
    } catch (e) {
      networkErrors++;
      if (attempt >= 4 || /HTTP 4/.test(e.message)) throw e;
      await sleep(300 * (attempt + 1));
    }
  }
}

// Server clock offset (CLAUDE.md 5.5), moving average of the last 5 measurements.
const offsets = [];
let offset = 0;
async function getState(code, token = null) {
  const t0 = Date.now();
  const s = await rpc('get_state', { p_code: code, p_token: token });
  const t1 = Date.now();
  if (s.server_now) {
    offsets.push(Date.parse(s.server_now) - (t0 + t1) / 2);
    if (offsets.length > 5) offsets.shift();
    offset = offsets.reduce((a, b) => a + b, 0) / offsets.length;
  }
  return s;
}
const serverNow = () => Date.now() + offset;

// Defaults of the config straight from the newest migration that defines them.
function defaultConfig() {
  const dir = join(ROOT, 'supabase', 'migrations');
  const file = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().reverse()
    .find((f) => /function public\.default_config\(\)/.test(readFileSync(join(dir, f), 'utf8')));
  const sql = readFileSync(join(dir, file), 'utf8');
  const body = sql.slice(sql.indexOf('function public.default_config()'));
  const block = body.slice(body.indexOf('jsonb_build_object('), body.indexOf('$$;'));
  const cfg = {};
  for (const m of block.matchAll(/'(\w+)',\s*(\d+|'[^']*')/g)) cfg[m[1]] = m[2].startsWith("'") ? m[2].slice(1, -1) : Number(m[2]);
  return cfg;
}

function gameConfig() {
  const defaults = defaultConfig();
  const cfg = { difficulty: opt.difficulty };
  if (opt.players > defaults.max_players) cfg.max_players = opt.players;
  if (opt.balloons !== null) cfg.balloons_total = opt.balloons;
  if (opt.scale !== 1) {
    for (const [k, v] of Object.entries(defaults)) {
      if (k.endsWith('_s') && typeof v === 'number') cfg[k] = Math.max(1, Math.round(v / opt.scale));
    }
  }
  return { cfg, defaults };
}

// ---------------------------------------------------------------------------
// Thinking like a player: Naked and Hidden Singles in the visible grid
// ---------------------------------------------------------------------------

const popcount = (m) => { let c = 0; while (m) { m &= m - 1; c++; } return c; };
const firstDigit = (m) => 31 - Math.clz32(m & -m) + 1;

function viewOf(s) {
  const grid = Uint8Array.from(s.round.revealed, (ch) => ch.charCodeAt(0) - 48);
  for (const e of s.me.entries) grid[e.cell] = e.digit;
  return grid;
}

function findMoves(grid, n) {
  const geo = geometry(n);
  const masks = new Int32Array(geo.cells);
  const found = new Map();
  for (let i = 0; i < geo.cells; i++) {
    if (grid[i]) continue;
    masks[i] = candidateMask(grid, geo, i);
    if (popcount(masks[i]) === 1) found.set(i, firstDigit(masks[i]));
  }
  for (const unit of geo.units) {
    let present = 0;
    for (const i of unit) if (grid[i]) present |= 1 << (grid[i] - 1);
    for (let d = 1; d <= n; d++) {
      const bit = 1 << (d - 1);
      if (present & bit) continue;
      const where = unit.filter((i) => !grid[i] && masks[i] & bit);
      if (where.length === 1 && !found.has(where[0])) found.set(where[0], d);
    }
  }
  return [...found].map(([idx, d]) => ({ idx, d, mask: masks[idx] }));
}

// Lines close to completion are the interesting ones: a person aims at them.
function pickMove(moves, grid, n, aimAtLines) {
  if (!aimAtLines || rng() < 0.4) return moves[Math.floor(rng() * moves.length)];
  const openIn = (cells) => cells.reduce((a, i) => a + (grid[i] ? 0 : 1), 0);
  const geo = geometry(n);
  const score = (m) => Math.min(openIn(geo.rows[Math.floor(m.idx / n)]), openIn(geo.cols[m.idx % n]));
  const best = Math.min(...moves.map(score));
  const top = moves.filter((m) => score(m) === best);
  return top[Math.floor(rng() * top.length)];
}

function wrongDigit(move, n) {
  const others = [];
  for (let d = 1; d <= n; d++) if (d !== move.d && move.mask & (1 << (d - 1))) others.push(d);
  if (!others.length) for (let d = 1; d <= n; d++) if (d !== move.d) others.push(d);
  return others[Math.floor(rng() * others.length)];
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

const sim = { code: null, done: false, startedWall: Date.now() };

class Bot {
  constructor(i) {
    this.name = NAMES[i];
    this.color = COLORS[i];
    this.skill = between(0.75, 1.3);
    this.favourite = null;
    this.plan = null;
    this.huntPlan = null;
    this.question = null;
    this.phaseKey = '';
    this.busy = false;
    this.tiebreakOver = false;
    this.digits = 0;
    this.wrong = 0;
    this.outcomes = { press: 0, no_balloon: 0, late: 0 };
  }

  async join() {
    const r = await rpc('join_game', { p_code: sim.code, p_name: this.name, p_color: this.color });
    if (!r.ok) throw new Error(`join ${this.name}: ${r.reason}`);
    this.token = r.token;
    this.id = r.player_id;
  }

  thinkMs(size, available) {
    let f = between(0.5, 1.5);
    if (available <= 2) f *= 1.4;
    return realMs(SPEED_S[opt.speed] * SIZE_FACTOR[size] * this.skill * f);
  }

  async call(fn, extra = {}) {
    return rpc(fn, { p_code: sim.code, p_token: this.token, ...extra });
  }

  async loop(pollMs) {
    while (!sim.done) {
      try {
        const s = await getState(sim.code, this.token);
        if (s.ok) await this.step(s);
      } catch (e) {
        console.log(`  ! ${this.name}: ${e.message}`);
      }
      // Wake up in time for a planned digit instead of waiting for the next poll.
      const untilPlan = this.plan ? this.plan.at - serverNow() : Infinity;
      await sleep(Math.max(20, Math.min(pollMs * between(0.8, 1.2), untilPlan)));
    }
  }

  async step(s) {
    const g = s.game;
    const key = `${g.phase}:${s.round?.id || ''}`;
    if (key !== this.phaseKey) {
      this.phaseKey = key;
      this.plan = null;
    }
    const now = serverNow();
    switch (g.phase) {
      case 'round_running':
      case 'trial_running':
        if (await this.hunt(s, now)) return;
        return this.play(s, now, true);
      case 'round_ending':
      case 'trial_ending':
        return this.hunt(s, now);
      case 'break_distribute':
        if (await this.hunt(s, now)) return;
        return this.distribute(s, now);
      case 'break_drink':
        if (await this.hunt(s, now)) return;
        return this.drink(s, now);
      case 'cashout':
        return this.cash(s, now);
      case 'tiebreak':
        return this.tiebreak(s, now);
      default:
    }
  }

  // Own hunt and the question after a late one. Returns true while either keeps the bot busy.
  async hunt(s, now) {
    const h = s.me.hunt;
    if (h) {
      this.plan = null;
      if (this.huntPlan?.started !== h.started_at) {
        const min = Date.parse(h.min_press_at);
        const span = Date.parse(h.deadline) - min;
        const x = rng();
        let kind = 'late';
        let at = Infinity;
        if (h.kind === 'trial') {
          kind = 'press';
          at = min + span * between(0.05, 0.4); // nobody runs in the trial
        } else if (x < opt.huntSuccess) {
          kind = 'press';
          at = min + span * between(0.1, 0.9);
        } else if (x < opt.huntSuccess + opt.noBalloon) {
          kind = 'no_balloon';
          at = min + span * between(0.3, 0.9);
        }
        if (h.kind !== 'trial') this.outcomes[kind]++;
        this.huntPlan = { started: h.started_at, kind, at, done: false };
      }
      if (!this.huntPlan.done && now >= this.huntPlan.at) {
        this.huntPlan.done = true;
        await this.call(this.huntPlan.kind === 'press' ? 'hunt_press' : 'hunt_no_balloon');
      }
      return true;
    }
    const q = s.me.hunt_question;
    if (q) {
      if (this.question?.key !== q.started_at) {
        this.question = { key: q.started_at, at: now + realMs(between(2, 6)), brought: rng() < 0.5, done: false };
      }
      if (!this.question.done && now >= this.question.at) {
        this.question.done = true;
        await this.call('hunt_answer', { p_brought: this.question.brought });
      }
      return true;
    }
    return false;
  }

  async play(s, now, aimAtLines) {
    const me = s.me;
    if (me.locked_until && Date.parse(me.locked_until) > now) {
      this.plan = null;
      return;
    }
    const n = s.round.size;
    if (!this.plan) {
      const moves = findMoves(viewOf(s), n);
      if (moves.length) this.plan = { at: now + this.thinkMs(n, moves.length) };
      return;
    }
    if (now < this.plan.at) return;
    this.plan = null;
    const grid = viewOf(s);
    const moves = findMoves(grid, n);
    if (!moves.length) return;
    const m = pickMove(moves, grid, n, aimAtLines);
    const wrong = rng() < opt.errorRate;
    const r = await this.call('enter_digit', { p_cell: m.idx, p_digit: wrong ? wrongDigit(m, n) : m.d });
    if (r.ok) {
      this.digits++;
      if (r.result === 'wrong') this.wrong++;
      if (r.result === 'correct' && r.finished) this.tiebreakOver = true;
      // The next digit is thought about from now on, not from the next poll.
      if (!r.hunt && !r.locked_until) this.plan = { at: serverNow() + this.thinkMs(n, Math.max(1, moves.length - 1)) };
    } else if (r.reason === 'group_finished') {
      this.tiebreakOver = true;
    }
  }

  async distribute(s, now) {
    if (!(s.me.sips_to_distribute > 0)) return;
    if (!this.plan) {
      this.plan = { at: now + realMs(between(2, 8)) };
      return;
    }
    if (now < this.plan.at) return;
    this.plan = null;
    const others = s.players.filter((p) => p.id !== this.id);
    if (!this.favourite) this.favourite = others[Math.floor(rng() * others.length)].id;
    if (rng() < 0.35) {
      await this.call('give_sips_random');
    } else {
      const target = rng() < 0.6 ? this.favourite : others[Math.floor(rng() * others.length)].id;
      await this.call('give_sip', { p_target: target });
    }
  }

  async drink(s, now) {
    if (s.me.ready) return;
    if (!this.plan) {
      this.plan = { at: now + realMs(between(3, 20)) };
      return;
    }
    if (now < this.plan.at) return;
    this.plan = null;
    await this.call('confirm_ready');
  }

  // Bursting and counting happen at the table; the bot invents a plausible amount per balloon.
  async cash(s, now) {
    if (s.me.cash_cents !== null) return;
    if (!this.plan) {
      this.plan = { at: now + realMs(between(5, 25)) };
      return;
    }
    if (now < this.plan.at) return;
    this.plan = null;
    const cfg = s.game.config;
    const perBalloon = cfg.coins_total_cents / cfg.balloons_total;
    let cents = 0;
    for (let k = 0; k < s.me.balloons_allowed; k++) cents += Math.round(perBalloon * between(0.2, 1.8));
    await this.call('submit_cash', { p_cents: Math.min(cents, cfg.cash_max_cents) });
  }

  async tiebreak(s, now) {
    const mine = s.players.find((p) => p.id === this.id);
    if (!mine || mine.tiebreak_group === null || mine.tiebreak_finished_at || this.tiebreakOver) return;
    if (!s.round || s.round.kind !== 'tiebreak' || now < Date.parse(s.round.started_at)) return;
    return this.play(s, now, false);
  }
}

// ---------------------------------------------------------------------------
// Host: tick, phases, log, report
// ---------------------------------------------------------------------------

const fmt = (ms) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
const realClock = () => fmt((Date.now() - sim.startedWall) * opt.scale);
const log = (text) => console.log(`[${realClock()}] ${text}`);

const EVENT_TEXT = {
  line_claimed: (p) => `${p.name} löst ${p.label}`,
  line_neutral: (p) => `${p.label} neutral`,
  player_locked: (p) => `${p.name} ist ${p.seconds} s gesperrt`,
  hunt_success: (p) => `Jagd von ${p.name} erfolgreich`,
  hunt_failed: (p) => `Jagd von ${p.name} zu spät`,
  hunt_no_balloon: (p) => `${p.name}: kein Ballon gefunden`,
  hunt_late_answer: (p) => `${p.name}: zu spät, Ballon ${p.brought ? 'mitgebracht' : 'nicht mitgebracht'}`,
  hall_empty: (p) => `HALLE LEER (letzter Ballon: ${p.name})`,
  round_limit: () => 'Rundenlimit erreicht',
  round_started: (p) => `Sudoku ${p.round_no} startet`,
  auto_reveal: (p) => `Letzte Felder: ${p.cells} Felder aufgedeckt`,
};

const rounds = [];
let currentRound = null;
const seenEvents = new Set();
let lastPhase = null;
let lastState = null;
let tiebreak = null;

function observe(s) {
  lastState = s;
  const g = s.game;
  for (const e of [...s.ticker].reverse()) {
    const k = `${e.created_at}|${e.type}|${JSON.stringify(e.payload)}`;
    if (seenEvents.has(k)) continue;
    seenEvents.add(k);
    if (e.type === 'player_joined') continue;
    const f = EVENT_TEXT[e.type];
    log(f ? f(e.payload || {}) : `${e.type} ${JSON.stringify(e.payload)}`);
    if (currentRound) currentRound.events.push(e.type);
  }
  if (g.phase !== lastPhase) {
    log(`— Phase ${g.phase}`);
    lastPhase = g.phase;
  }
  if (g.phase === 'tiebreak' && s.round?.kind === 'tiebreak' && !tiebreak) {
    tiebreak = { start: Date.parse(s.round.started_at) - offset, end: null };
  }
  if (tiebreak && !tiebreak.end && g.phase === 'results') tiebreak.end = Date.now();
  const running = g.phase === 'round_running' || g.phase === 'trial_running';
  if (running && (!currentRound || currentRound.id !== s.round.id)) {
    const empty = [...s.round.givens].filter((ch) => ch === '0').length;
    currentRound = {
      id: s.round.id, kind: s.round.kind, no: s.round.round_no, start: Date.now(), end: null,
      givens: s.round.givens.length - empty, empty, huntsAtStart: g.hunts_started, events: [],
    };
    rounds.push(currentRound);
  }
  if (currentRound && !currentRound.end && !running) {
    currentRound.end = Date.now();
    currentRound.claimed = s.lines.filter((l) => l.status === 'claimed').length;
    currentRound.neutral = s.lines.filter((l) => l.status === 'neutral').length;
    currentRound.hunts = g.hunts_started - currentRound.huntsAtStart;
    const ev = currentRound.events;
    currentRound.reason = ev.includes('hall_empty') ? 'Halle leer'
      : ev.includes('round_limit') ? 'Rundenlimit'
        : ev.includes('auto_reveal') ? 'alle Linien (Letzte Felder)' : 'alle Linien';
  }
}

function report(bots, defaults) {
  const s = lastState;
  const pad = (v, w) => String(v).padEnd(w);
  const padL = (v, w) => String(v).padStart(w);
  console.log('\n=== Auswertung ===');
  console.log(`Tempo ${opt.speed}, ${opt.players} Bots, Schwierigkeit ${opt.difficulty}${opt.scale !== 1 ? `, ${opt.scale}× schneller (Zeiten unten auf echt umgerechnet)` : ''}, Seed ${opt.seed}`);
  console.log(`Spielcode ${sim.code}, gesamt ${realClock()}, ${requests} Anfragen, ${networkErrors} Netzfehler`);
  console.log('\nRunde        Dauer  Vorgaben  leer  beansprucht  neutral  Jagden  Ende');
  const main = [];
  for (const r of rounds) {
    const end = r.end ?? Date.now();
    const realDur = (end - r.start) * opt.scale;
    if (r.kind === 'main' && r.end && r.reason !== 'Halle leer') main.push(realDur); // a cut round says nothing about the length
    console.log(`${pad(r.kind === 'trial' ? 'Probe' : `Sudoku ${r.no}`, 12)} ${padL(fmt(realDur), 5)}  ${padL(r.givens, 8)}  ${padL(r.empty, 4)}  ${padL(r.claimed ?? '-', 11)}  ${padL(r.neutral ?? '-', 7)}  ${padL(r.kind === 'main' ? (r.hunts ?? '-') : '-', 6)}  ${r.end ? r.reason : 'läuft noch'}`);
  }
  if (main.length) {
    const avg = main.reduce((a, b) => a + b, 0) / main.length;
    const verdict = avg < 4 * 60000 ? 'kürzer als das Ziel von 4–6 Min.: mehr leere Felder (weniger Vorgaben)'
      : avg > 6 * 60000 ? 'länger als das Ziel von 4–6 Min.: weniger leere Felder (mehr Vorgaben)'
        : 'im Ziel von 4–6 Min.';
    console.log(`\nØ Haupt-Sudoku ${fmt(avg)} (ohne Runden, die wegen «Halle leer» abbrechen) – ${verdict}`);
  }
  if (s && tiebreak) {
    const groups = new Map();
    for (const p of s.players) if (p.tiebreak_group !== null) groups.set(p.tiebreak_group, [...(groups.get(p.tiebreak_group) || []), p]);
    const dur = tiebreak.end ? fmt((tiebreak.end - tiebreak.start) * opt.scale) : 'läuft noch';
    console.log(`Powersudoku ${dur}: ${[...groups.values()].map((ps) => `${(ps[0].cash_cents / 100).toFixed(2)} € → ${ps
      .sort((a, b) => (a.final_rank ?? 99) - (b.final_rank ?? 99))
      .map((p) => `${p.name} ${p.tiebreak_correct} richtig${p.tiebreak_finished_at ? ', fertig' : ''}${p.rank_by_lot ? ', Los' : ''}`).join(' vor ')}`).join(' · ')}`);
  }
  if (s) {
    console.log(`Ballone in der Halle: ${s.game.balloons_left} von ${s.game.config.balloons_total}, Jagden gestartet: ${s.game.hunts_started}`);
    console.log('\nSpieler  Rang  Betrag   Linien  Jagden ok/alle  Quote  Tipps  Fehler  Sperren  Shots gegeben/erhalten  Jagd-Plan ok/kein/spät');
    const stats = new Map((s.stats?.players || []).map((p) => [p.player_id, p]));
    const rows = bots.map((b) => ({ b, p: s.players.find((x) => x.id === b.id), st: stats.get(b.id) }))
      .sort((x, y) => (x.p?.final_rank ?? 99) - (y.p?.final_rank ?? 99));
    for (const { b, p, st } of rows) {
      const cash = p?.cash_cents === null || p?.cash_cents === undefined ? '-' : `${(p.cash_cents / 100).toFixed(2)} €`;
      const rank = p?.final_rank ? `${p.final_rank}${p.rank_by_lot ? ' (Los)' : ''}` : '-';
      console.log(`${pad(b.name, 8)} ${padL(rank, 4)}  ${padL(cash, 7)}  ${padL(p?.lines_claimed ?? '-', 6)}  ${padL(`${p?.hunts_success ?? '-'}/${p?.hunts_started ?? '-'}`, 14)}  ${padL(st?.hunts_quote ?? '-', 5)}  ${padL(b.digits, 5)}  ${padL(p?.errors_total ?? '-', 6)}  ${padL(p?.locks_total ?? '-', 7)}  ${padL(st ? `${st.sips_given}/${st.sips_received}` : '-', 22)}  ${b.outcomes.press}/${b.outcomes.no_balloon}/${b.outcomes.late}`);
    }
    const awards = s.stats?.awards;
    if (awards) {
      const nameOf = (id) => bots.find((b) => b.id === id)?.name ?? '?';
      const label = { lines: 'Linien-König', hunter: 'Jagd-Profi', errors: 'Fehlerteufel', magnet: 'Shot-Magnet', generous: 'Grosszügigster' };
      console.log(`\nAuszeichnungen: ${Object.entries(label).map(([k, l]) => `${l}: ${(awards[k] || []).map((w) => nameOf(w.player_id)).join(', ') || '–'}`).join(' · ')}`);
    }
  }
  if (defaults && opt.scale !== 1) console.log(`\nHinweis: Bei ${opt.scale}× werden Config-Zeiten gerundet (z. B. round_end_hold_s ${defaults.round_end_hold_s} → ${Math.max(1, Math.round(defaults.round_end_hold_s / opt.scale))}), die Dauer ist deshalb nur ungefähr.`);
}

async function main() {
  const { cfg, defaults } = gameConfig();
  const created = await rpc('create_game', { p_pin: opt.pin, p_config: cfg });
  if (!created.ok) throw new Error(`create_game: ${created.reason}`);
  sim.code = created.code;
  console.log(`Spiel ${sim.code} erstellt, PIN ${opt.pin}. Zuschauen: tv.html → «Verbinden» mit Code und PIN.`);
  const bots = Array.from({ length: opt.players }, (_, i) => new Bot(i));
  for (const b of bots) await b.join();
  const pollMs = Math.max(250, 1500 / opt.scale);
  const tickMs = Math.max(200, 1000 / opt.scale);

  let stopReason = null;
  const finish = (why) => { stopReason = why; sim.done = true; };
  process.on('SIGINT', () => finish('abgebrochen (Ctrl+C)'));

  const start = await rpc(opt.trial ? 'host_start_trial' : 'host_start_main', { p_code: sim.code, p_pin: opt.pin });
  if (!start.ok) throw new Error(`start: ${start.reason}`);
  sim.startedWall = Date.now();
  const loops = bots.map((b) => b.loop(pollMs));

  let mainStarted = !opt.trial;
  let closing = false;
  const deadlineWall = Date.now() + (opt.maxMinutes * 60000) / opt.scale;
  while (!sim.done) {
    try {
      await rpc('tick', { p_code: sim.code });
      const s = await getState(sim.code);
      observe(s);
      const phase = s.game.phase;
      if (!mainStarted && phase === 'lobby' && s.game.trial_done) {
        const r = await rpc('host_start_main', { p_code: sim.code, p_pin: opt.pin });
        if (r.ok) mainStarted = true;
      }
      if (phase === 'cashout' && !closing && s.players.every((p) => p.has_submitted_cash)) {
        closing = true;
        const r = await rpc('host_close_cashout', { p_code: sim.code, p_pin: opt.pin });
        if (!r.ok) { closing = false; log(`Kassensturz abschliessen: ${r.reason}`); }
      }
      if (phase === 'break_drink' && s.game.phase_deadline && serverNow() > Date.parse(s.game.phase_deadline)) {
        await rpc('host_force_continue', { p_code: sim.code, p_pin: opt.pin });
      }
      if (phase === 'results' && s.stats && (!s.game.phase_deadline || serverNow() > Date.parse(s.game.phase_deadline))) finish('fertig');
    } catch (e) {
      console.log(`  ! host: ${e.message}`);
    }
    if (Date.now() > deadlineWall) finish(`nach ${opt.maxMinutes} Min. abgebrochen`);
    await sleep(tickMs);
  }
  await Promise.all(loops);
  try { observe(await getState(sim.code)); } catch {}
  log(`Ende: ${stopReason}`);
  report(bots, defaults);
  return stopReason === 'fertig' ? 0 : 1;
}

main().then((code) => process.exit(code), (e) => {
  console.error(`Fehler: ${e.message}`);
  process.exit(1);
});
