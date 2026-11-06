// TV sounds, generated with WebAudio (no files, CLAUDE.md 9.1). The variants were chosen by
// ear in mockups/sounds.html. Only tv.js imports this module: the phone stays silent.

import { SOUND } from './config.js';

let ctx = null;
let master = null;
let noiseBuffer = null;

/**
 * Creates the audio graph on the first user gesture (browser rule) and wakes it up again
 * after the browser suspended it. Before that, play() does nothing.
 */
export function unlock() {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 4;
      master = ctx.createGain();
      master.gain.value = SOUND.volume;
      master.connect(comp);
      comp.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
  } catch (e) {
    console.warn('audio unavailable', e);
  }
}

/** True once sounds can actually be heard. */
export const isUnlocked = () => !!ctx && ctx.state === 'running';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function envelope(param, t, { gain, a, hold = 0, dur }) {
  param.setValueAtTime(0.0001, t);
  param.exponentialRampToValueAtTime(gain, t + a);
  if (hold > 0) param.setValueAtTime(gain, t + a + hold);
  param.exponentialRampToValueAtTime(0.0001, t + dur);
}

function filtered(node, t, dur, { lp, lpTo, hp, bp, bpTo, q = 0.7 }) {
  let out = node;
  const add = (type, f, fTo) => {
    const fl = ctx.createBiquadFilter();
    fl.type = type;
    fl.Q.value = q;
    fl.frequency.setValueAtTime(f, t);
    if (fTo) fl.frequency.exponentialRampToValueAtTime(fTo, t + dur);
    out.connect(fl);
    out = fl;
  };
  if (lp) add('lowpass', lp, lpTo);
  if (hp) add('highpass', hp);
  if (bp) add('bandpass', bp, bpTo);
  return out;
}

/** One oscillator note with glide, vibrato, filter and envelope. */
function tone(out, t, { type = 'sine', f, f2, glide, dur, gain = 0.2, a = 0.005, hold = 0, detune = 0, vib, ...flt }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.detune.value = detune;
  o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + (glide ?? dur));
  if (vib) {
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = vib.rate;
    depth.gain.value = vib.depth;
    lfo.connect(depth);
    depth.connect(o.frequency);
    lfo.start(t);
    lfo.stop(t + dur + 0.05);
  }
  const g = ctx.createGain();
  envelope(g.gain, t, { gain, a, hold, dur });
  filtered(o, t, dur, flt).connect(g);
  g.connect(out);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** Filtered white noise with envelope. */
function noise(out, t, { dur, gain = 0.2, a = 0.002, hold = 0, ...flt }) {
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const g = ctx.createGain();
  envelope(g.gain, t, { gain, a, hold, dur });
  filtered(src, t, dur, flt).connect(g);
  g.connect(out);
  src.start(t, Math.random());
  src.stop(t + dur + 0.05);
}

const note = (semis) => 440 * 2 ** (semis / 12); // 0 = A4

function bell(out, t, f, dur = 1, gain = 0.18) {
  tone(out, t, { f, dur, gain, a: 0.002 });
  tone(out, t, { f: f * 2.76, dur: dur * 0.45, gain: gain * 0.35, a: 0.002 });
  tone(out, t, { f: f * 5.4, dur: dur * 0.2, gain: gain * 0.15, a: 0.002 });
}

function brass(out, t, f, dur, gain = 0.12) {
  const hold = Math.max(0, dur - 0.18);
  for (const detune of [-6, 6]) {
    tone(out, t, { type: 'sawtooth', f, dur, gain, a: 0.03, hold, detune, lp: 2600, lpTo: 1100, q: 1 });
  }
}

function gong(out, t, f, dur = 3.2, gain = 0.3) {
  [[1, 1], [1.52, 0.5], [2.4, 0.35], [3.9, 0.2], [5.4, 0.12]].forEach(([m, k], i) => {
    tone(out, t, { f: f * m, dur: dur * (1 - i * 0.15), gain: gain * k, a: 0.004 });
  });
  noise(out, t, { dur: 0.15, gain: 0.12, lp: 900 });
}

function thump(out, t, gain = 0.55) {
  tone(out, t, { f: 110, f2: 48, glide: 0.25, dur: 0.6, gain });
  noise(out, t, { dur: 0.08, gain: gain * 0.4, lp: 600 });
}

function whistle(out, t, dur) {
  tone(out, t, { f: 2900, dur, gain: 0.12, a: 0.02, hold: dur - 0.1, vib: { rate: 28, depth: 140 } });
  noise(out, t, { dur, gain: 0.03, a: 0.02, hold: dur - 0.1, hp: 3000 });
}

// ---------------------------------------------------------------------------
// The sounds, one per moment of the game. (out, t, opt): t = AudioContext time.
// ---------------------------------------------------------------------------

const SOUNDS = {
  // Sudoku startet: Startpfiff
  start: (o, t) => { whistle(o, t, 0.18); whistle(o, t + 0.28, 0.7); },
  // Ballon platzt: Plopp, once per cell
  pop: (o, t) => { tone(o, t, { f: 620, f2: 140, glide: 0.07, dur: 0.1, gain: 0.3 }); noise(o, t, { dur: 0.03, gain: 0.12, hp: 2500 }); },
  // Linie gelöst: Treffer-Akkord, when the line lights up
  line: (o, t) => {
    [3, 7, 10, 15].forEach((s) => tone(o, t, { type: 'triangle', f: note(s), dur: 0.8, gain: 0.09 }));
    tone(o, t, { type: 'sawtooth', f: note(3), dur: 0.5, gain: 0.05, lp: 2000, lpTo: 400 });
  },
  // Neutrale Linie: leises Wischen
  neutral: (o, t) => noise(o, t, { dur: 0.55, gain: 0.25, a: 0.12, bp: 500, bpTo: 2600, q: 1.2 }),
  // Ballon im Depot: Kasse
  success: (o, t) => { noise(o, t, { dur: 0.09, gain: 0.25, bp: 3000, q: 2 }); bell(o, t + 0.07, 1568, 0.9, 0.16); bell(o, t + 0.07, 2093, 0.9, 0.12); },
  // Jagd ohne Erfolg: Wah-wah
  fail: (o, t) => [[-2, 0.28], [-3, 0.28], [-4, 0.28], [-5, 0.8]].forEach(([s, d], i) => tone(o, t + i * 0.3, {
    type: 'sawtooth', f: note(s), dur: d, gain: 0.18, a: 0.02, hold: d - 0.12, lp: 900, vib: i === 3 ? { rate: 6, depth: 6 } : null,
  })),
  // Sperre: Gittertür
  lock: (o, t) => [0, 0.2].forEach((d) => {
    noise(o, t + d, { dur: 0.3, gain: 0.3, bp: 900, q: 6 });
    tone(o, t + d, { type: 'square', f: 233, dur: 0.25, gain: 0.06, lp: 2000 });
    tone(o, t + d, { type: 'square', f: 347, dur: 0.2, gain: 0.05, lp: 2000 });
  }),
  // Wettrennen: Alarm
  race: (o, t) => { for (let i = 0; i < 8; i++) tone(o, t + i * 0.25, { type: 'triangle', f: i % 2 ? 660 : 880, dur: 0.25, gain: 0.14, a: 0.01, hold: 0.2 }); },
  // Halle leer: Schlussgong
  empty: (o, t) => { gong(o, t, 73, 4, 0.35); [3, 7, 10, 15].forEach((s) => brass(o, t + 0.05, note(s - 12), 1.6, 0.06)); },
  // Letzte 10 Sekunden: Piepen, higher and longer in the last three
  countdown: (o, t, opt = {}) => {
    const hot = (opt.left ?? 10) <= 3;
    tone(o, t, { f: hot ? 1320 : 880, dur: hot ? 0.18 : 0.1, gain: hot ? 0.22 : 0.12, hold: 0.05 });
  },
  // Rundenende: Horn kurz
  end: (o, t) => [0, -9, 9].forEach((det) => tone(o, t, { type: 'sawtooth', f: 196, dur: 0.8, gain: 0.1, a: 0.02, hold: 0.6, detune: det, lp: 1800 })),
  // Shot verteilt: Gläser
  shot: (o, t) => {
    const f = 2400 + Math.random() * 500;
    tone(o, t, { f, dur: 0.35, gain: 0.1 });
    tone(o, t, { f: f * 1.48, dur: 0.25, gain: 0.06 });
    noise(o, t, { dur: 0.02, gain: 0.06, hp: 4000 });
  },
  // Beträge steigen: steigender Ton over opt.dur seconds
  rise: (o, t, opt = {}) => {
    const d = opt.dur ?? 8;
    tone(o, t, { type: 'triangle', f: 110, f2: 660, dur: d, gain: 0.1, a: d * 0.6, lp: 1800 });
    tone(o, t, { type: 'sawtooth', f: 110.5, f2: 661, dur: d, gain: 0.04, a: d * 0.6, lp: 900 });
  },
  // Platz aufgedeckt: Ding
  place: (o, t) => bell(o, t, 1046, 1.1, 0.18),
  // Sieger: Fanfare
  winner: (o, t) => {
    [[-2, 0], [3, 0.14], [7, 0.28], [10, 0.42]].forEach(([s, d]) => brass(o, t + d, note(s), 0.13));
    [10, 15, 19].forEach((s) => brass(o, t + 0.6, note(s), 1.6, 0.08));
    thump(o, t + 0.6, 0.5);
  },
};

/** Plays a sound, delay in seconds from now. Silent until unlock() ran in a user gesture. */
export function play(id, delay = 0, opt = {}) {
  if (!isUnlocked() || !SOUNDS[id]) return;
  try {
    SOUNDS[id](master, ctx.currentTime + Math.max(0, delay) + 0.01, opt);
  } catch (e) {
    console.warn('sound failed', id, e);
  }
}
