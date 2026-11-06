// Sound mock-up: every TV sound in two to three variants, generated with WebAudio (no files).
// The chosen variants later move into js/sound.js. Only the TV plays sounds, the phone stays silent.

let ctx = null;
let master = null;
let bus = null;
let previewBus = null;
let volume = 0.8;
let noiseBuffer = null;

/** Creates the audio graph on first use; must be called from a click (browser rule). */
export function unlock() {
  if (!ctx) {
    ctx = new AudioContext();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(comp);
    comp.connect(ctx.destination);
    bus = newBus();
    previewBus = newBus();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function newBus() {
  const g = ctx.createGain();
  g.connect(master);
  return g;
}

export const now = () => (ctx ? ctx.currentTime : 0);

export function setVolume(v) {
  volume = v;
  if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
}

/** Silences everything scheduled for the scene, e.g. when jumping to another chapter. */
export function cutScene() {
  if (!ctx) return;
  const old = bus;
  old.gain.setTargetAtTime(0, ctx.currentTime, 0.015);
  setTimeout(() => old.disconnect(), 200);
  bus = newBus();
}

function cutPreview() {
  const old = previewBus;
  old.gain.setTargetAtTime(0, ctx.currentTime, 0.015);
  setTimeout(() => old.disconnect(), 200);
  previewBus = newBus();
}

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

function drumroll(out, t, dur, from = 0.04, to = 0.3) {
  const hits = Math.floor(dur / 0.045);
  for (let i = 0; i < hits; i++) {
    const k = i / hits;
    noise(out, t + i * 0.045, { dur: 0.06, gain: from + (to - from) * k * k, bp: 1700, q: 0.8 });
  }
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
// The sounds. play(out, t, opt): out = destination, t = AudioContext time.
// ---------------------------------------------------------------------------

const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];

export const SOUNDS = [
  {
    id: 'start', name: 'Sudoku startet', when: 'Ein neues Sudoku beginnt (auch nach der Pause, wenn alle bereit sind).',
    variants: [
      { key: 'A', label: 'Fanfare', play: (o, t) => { [3, 7, 10].forEach((s, i) => brass(o, t + i * 0.12, note(s), 0.14)); brass(o, t + 0.36, note(15), 0.7, 0.14); brass(o, t + 0.36, note(10), 0.7, 0.08); } },
      { key: 'B', label: 'Gong', play: (o, t) => gong(o, t, 98) },
      { key: 'C', label: 'Startpfiff', play: (o, t) => { whistle(o, t, 0.18); whistle(o, t + 0.28, 0.7); } },
    ],
  },
  {
    id: 'pop', name: 'Ballon platzt', when: 'Pro Feld, wenn eine Linie gelöst wird: genau dann, wenn auf dem TV der Ballon platzt.',
    variants: [
      { key: 'A', label: 'Plopp', play: (o, t) => { tone(o, t, { f: 620, f2: 140, glide: 0.07, dur: 0.1, gain: 0.3 }); noise(o, t, { dur: 0.03, gain: 0.12, hp: 2500 }); } },
      { key: 'B', label: 'Knall', play: (o, t) => { noise(o, t, { dur: 0.14, gain: 0.5, bp: 1600, q: 0.6 }); tone(o, t, { f: 120, f2: 60, dur: 0.1, gain: 0.25 }); } },
      { key: 'C', label: 'Tonleiter', play: (o, t, opt = {}) => { const f = 523 * 2 ** (PENTA[Math.min(opt.i ?? 0, PENTA.length - 1)] / 12); tone(o, t, { type: 'triangle', f, dur: 0.18, gain: 0.22 }); noise(o, t, { dur: 0.025, gain: 0.08, hp: 3000 }); } },
      { key: 'off', label: 'aus', play: () => {} },
    ],
  },
  {
    id: 'line', name: 'Linie gelöst', when: 'Wenn die Linie nach dem letzten Ballon aufleuchtet und der Name erscheint.',
    variants: [
      { key: 'A', label: 'Treffer-Akkord', play: (o, t) => { [3, 7, 10, 15].forEach((s) => tone(o, t, { type: 'triangle', f: note(s), dur: 0.8, gain: 0.09 })); tone(o, t, { type: 'sawtooth', f: note(3), dur: 0.5, gain: 0.05, lp: 2000, lpTo: 400 }); } },
      { key: 'B', label: 'Arcade', play: (o, t) => [7, 11, 14, 19].forEach((s, i) => tone(o, t + i * 0.065, { type: 'square', f: note(s), dur: 0.1, gain: 0.14, lp: 4000 })) },
      { key: 'off', label: 'aus (nur Ballone)', play: () => {} },
    ],
  },
  {
    id: 'neutral', name: 'Neutrale Linie', when: 'Graue Linien ohne Löser, auch am Rundenende und bei «Letzte Felder».',
    variants: [
      { key: 'A', label: 'leises Wischen', play: (o, t) => noise(o, t, { dur: 0.55, gain: 0.25, a: 0.12, bp: 500, bpTo: 2600, q: 1.2 }) },
      { key: 'off', label: 'aus', play: () => {} },
    ],
  },
  {
    id: 'success', name: 'Ballon im Depot', when: 'Eine Jagd ist erfolgreich (Spieler drückt «Ballon im Depot»).',
    variants: [
      { key: 'A', label: 'Kasse', play: (o, t) => { noise(o, t, { dur: 0.09, gain: 0.25, bp: 3000, q: 2 }); bell(o, t + 0.07, 1568, 0.9, 0.16); bell(o, t + 0.07, 2093, 0.9, 0.12); } },
      { key: 'B', label: 'Glocken aufwärts', play: (o, t) => [10, 15, 19, 22].forEach((s, i) => bell(o, t + i * 0.09, note(s + 12), 0.8, 0.12)) },
      { key: 'C', label: 'Korb-Treffer', play: (o, t) => { thump(o, t, 0.45); bell(o, t + 0.06, 1760, 0.7, 0.16); } },
    ],
  },
  {
    id: 'fail', name: 'Jagd ohne Erfolg', when: 'Zeit abgelaufen oder «Kein Ballon gefunden».',
    variants: [
      { key: 'A', label: 'Wah-wah', play: (o, t) => [[-2, 0.28], [-3, 0.28], [-4, 0.28], [-5, 0.8]].forEach(([s, d], i) => tone(o, t + i * 0.3, { type: 'sawtooth', f: note(s), dur: d, gain: 0.18, a: 0.02, hold: d - 0.12, lp: 900, vib: i === 3 ? { rate: 6, depth: 6 } : null })) },
      { key: 'B', label: 'dumpfer Ton', play: (o, t) => { tone(o, t, { type: 'triangle', f: 196, f2: 130, dur: 0.5, gain: 0.3 }); tone(o, t, { f: 98, dur: 0.5, gain: 0.2 }); } },
      { key: 'off', label: 'aus', play: () => {} },
    ],
  },
  {
    id: 'lock', name: 'Sperre', when: 'Jemand hat 3 Fehler gemacht und ist 20 s gesperrt.',
    variants: [
      { key: 'A', label: 'Buzzer', play: (o, t) => { tone(o, t, { type: 'square', f: 98, dur: 0.55, gain: 0.12, hold: 0.4, lp: 1400 }); tone(o, t, { type: 'square', f: 104, dur: 0.55, gain: 0.12, hold: 0.4, lp: 1400 }); } },
      { key: 'B', label: 'Gittertür', play: (o, t) => [0, 0.2].forEach((d) => { noise(o, t + d, { dur: 0.3, gain: 0.3, bp: 900, q: 6 }); tone(o, t + d, { type: 'square', f: 233, dur: 0.25, gain: 0.06, lp: 2000 }); tone(o, t + d, { type: 'square', f: 347, dur: 0.2, gain: 0.05, lp: 2000 }); }) },
      { key: 'off', label: 'aus', play: () => {} },
    ],
  },
  {
    id: 'race', name: 'Wettrennen', when: 'Mehr Jagden laufen, als Ballone in der Halle sind.',
    variants: [
      { key: 'A', label: 'Trommelwirbel', play: (o, t) => { drumroll(o, t, 1.8, 0.08, 0.6); thump(o, t + 1.8, 0.5); } },
      { key: 'B', label: 'Alarm', play: (o, t) => { for (let i = 0; i < 8; i++) tone(o, t + i * 0.25, { type: 'triangle', f: i % 2 ? 660 : 880, dur: 0.25, gain: 0.14, a: 0.01, hold: 0.2 }); } },
      { key: 'off', label: 'aus', play: () => {} },
    ],
  },
  {
    id: 'empty', name: 'Halle leer', when: 'Der letzte Ballon hat die Halle verlassen, das Spiel endet.',
    variants: [
      { key: 'A', label: 'Schlussgong', play: (o, t) => { gong(o, t, 73, 4, 0.35); [3, 7, 10, 15].forEach((s) => brass(o, t + 0.05, note(s - 12), 1.6, 0.06)); } },
      { key: 'B', label: 'Stadion-Horn', play: (o, t) => [[0, 0.3], [0.45, 1.1]].forEach(([d, len]) => [0, -9, 9].forEach((det) => tone(o, t + d, { type: 'sawtooth', f: 233, f2: 247, glide: 0.08, dur: len, gain: 0.1, a: 0.02, hold: len - 0.1, detune: det, lp: 2200 }))) },
      { key: 'C', label: 'Tusch', play: (o, t) => [[0, 0.16], [0.24, 1.2]].forEach(([d, len]) => [3, 7, 10, 15].forEach((s) => brass(o, t + d, note(s - 12), len, 0.07))) },
    ],
  },
  {
    id: 'countdown', name: 'Letzte 10 Sekunden', when: 'Rundentimer zeigt 0:10 bis 0:01 (pro Sekunde ein Ton).',
    variants: [
      { key: 'A', label: 'Ticken', play: (o, t, opt = {}) => { const hot = (opt.left ?? 10) <= 3; tone(o, t, { f: hot ? 1700 : 1200, dur: 0.05, gain: hot ? 0.35 : 0.22 }); noise(o, t, { dur: 0.02, gain: 0.1, bp: 3000, q: 3 }); } },
      { key: 'B', label: 'Piepen', play: (o, t, opt = {}) => { const hot = (opt.left ?? 10) <= 3; tone(o, t, { f: hot ? 1320 : 880, dur: hot ? 0.18 : 0.1, gain: hot ? 0.22 : 0.12, hold: 0.05 }); } },
      { key: 'C', label: 'nur letzte 3 s', play: (o, t, opt = {}) => { if ((opt.left ?? 3) <= 3) tone(o, t, { f: 1320, dur: 0.18, gain: 0.22, hold: 0.05 }); } },
      { key: 'off', label: 'aus', play: () => {} },
    ],
  },
  {
    id: 'end', name: 'Rundenende', when: 'Die Runde ist vorbei (Zeit abgelaufen oder alle 18 Linien gesperrt).',
    variants: [
      { key: 'A', label: 'Schlusspfiff', play: (o, t) => { whistle(o, t, 0.2); whistle(o, t + 0.3, 0.2); whistle(o, t + 0.6, 0.9); } },
      { key: 'B', label: 'Gong', play: (o, t) => gong(o, t, 131) },
      { key: 'C', label: 'Horn kurz', play: (o, t) => [0, -9, 9].forEach((det) => tone(o, t, { type: 'sawtooth', f: 196, dur: 0.8, gain: 0.1, a: 0.02, hold: 0.6, detune: det, lp: 1800 })) },
    ],
  },
  {
    id: 'shot', name: 'Shot verteilt', when: 'In der Pause, bei jedem Shot, den jemand verteilt.',
    variants: [
      { key: 'A', label: 'Gläser', play: (o, t) => { const f = 2400 + Math.random() * 500; tone(o, t, { f, dur: 0.35, gain: 0.1 }); tone(o, t, { f: f * 1.48, dur: 0.25, gain: 0.06 }); noise(o, t, { dur: 0.02, gain: 0.06, hp: 4000 }); } },
      { key: 'B', label: 'Plopp tief', play: (o, t) => tone(o, t, { f: 320, f2: 90, glide: 0.08, dur: 0.12, gain: 0.35 }) },
      { key: 'off', label: 'aus', play: () => {} },
    ],
  },
  {
    id: 'rise', name: 'Beträge steigen', when: 'Kassensturz: die ersten 8 s, in denen alle Säulen ohne Namen steigen.',
    variants: [
      { key: 'A', label: 'steigender Ton', play: (o, t, opt = {}) => { const d = opt.dur ?? 8; tone(o, t, { type: 'triangle', f: 110, f2: 660, dur: d, gain: 0.1, a: d * 0.6, lp: 1800 }); tone(o, t, { type: 'sawtooth', f: 110.5, f2: 661, dur: d, gain: 0.04, a: d * 0.6, lp: 900 }); } },
      { key: 'B', label: 'Ticken schneller', play: (o, t, opt = {}) => { const d = opt.dur ?? 8; let x = 0; while (x < d) { tone(o, t + x, { f: 1200, dur: 0.04, gain: 0.15 }); x += 0.45 - 0.39 * (x / d); } } },
      { key: 'C', label: 'Trommelwirbel', play: (o, t, opt = {}) => drumroll(o, t, opt.dur ?? 8, 0.02, 0.22) },
      { key: 'off', label: 'aus', play: () => {} },
    ],
  },
  {
    id: 'place', name: 'Platz aufgedeckt', when: 'Kassensturz: alle 5 s wird ein Platz enthüllt, vom letzten bis zum zweiten.',
    variants: [
      { key: 'A', label: 'Paukenschlag', play: (o, t) => thump(o, t, 0.6) },
      { key: 'B', label: 'Ding', play: (o, t) => bell(o, t, 1046, 1.1, 0.18) },
      { key: 'C', label: 'Tusch kurz', play: (o, t) => [3, 7, 10].forEach((s) => brass(o, t, note(s - 12), 0.35, 0.08)) },
    ],
  },
  {
    id: 'winner', name: 'Sieger', when: 'Kassensturz: Platz 1 wird enthüllt.',
    variants: [
      { key: 'A', label: 'Fanfare', play: (o, t) => { [[-2, 0], [3, 0.14], [7, 0.28], [10, 0.42]].forEach(([s, d]) => brass(o, t + d, note(s), 0.13)); [10, 15, 19].forEach((s) => brass(o, t + 0.6, note(s), 1.6, 0.08)); thump(o, t + 0.6, 0.5); } },
      { key: 'B', label: 'Glockenregen', play: (o, t) => { for (let i = 0; i < 18; i++) bell(o, t + i * 0.09, note(15 + PENTA[Math.floor(Math.random() * 7)]), 0.6, 0.07); [3, 7, 10].forEach((s) => tone(o, t, { type: 'triangle', f: note(s), dur: 2, gain: 0.07, a: 0.05 })); } },
      { key: 'C', label: 'Gong + Akkord', play: (o, t) => { gong(o, t, 65, 4, 0.3); [3, 7, 10, 15].forEach((s) => brass(o, t + 0.1, note(s), 2, 0.06)); } },
    ],
  },
];

const byId = new Map(SOUNDS.map((s) => [s.id, s]));

const STORE_KEY = 'badoku.mock.sounds';
const choice = (() => {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
})();

export const chosen = (id) => choice[id] ?? byId.get(id).variants[0].key;

export function choose(id, key) {
  choice[id] = key;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(choice)); } catch { /* memory only */ }
}

/** Plays the chosen variant of a sound in the scene, delay in seconds from now. */
export function play(id, delay = 0, opt = {}) {
  if (!ctx) return;
  const sound = byId.get(id);
  const variant = sound.variants.find((v) => v.key === chosen(id)) || sound.variants[0];
  variant.play(bus, ctx.currentTime + Math.max(0, delay) + 0.01, opt);
}

/** Plays one variant on its own (sound list), stopping the previous preview. */
export function preview(id, key) {
  unlock();
  cutPreview();
  const sound = byId.get(id);
  const variant = sound.variants.find((v) => v.key === key);
  const t = ctx.currentTime + 0.03;
  if (id === 'pop') for (let i = 0; i < 6; i++) variant.play(previewBus, t + i * 0.095, { i });
  else if (id === 'countdown') for (let left = 5; left >= 1; left--) variant.play(previewBus, t + (5 - left) * 0.6, { left });
  else if (id === 'shot') for (let i = 0; i < 3; i++) variant.play(previewBus, t + i * 0.5, {});
  else if (id === 'rise') variant.play(previewBus, t, { dur: 4 });
  else variant.play(previewBus, t, {});
}
