// N x N grid for TV and phone, including the line reveal effect (CLAUDE.md 9.5).
// Everything is drawn from the snapshot. Effects are positioned by elapsed time, so a
// redraw continues a running animation instead of restarting it.

import { REVEAL_FX } from './config.js';
import { serverNow } from './clock.js';
import { esc } from './util.js';

const NEUTRAL_COLOR = '#8B8D98';
const BOX = { 4: [2, 2], 6: [2, 3], 9: [3, 3] };

const lineCells = (n, type, i) => Array.from({ length: n }, (_, k) => (type === 'row' ? i * n + k : k * n + i));

// When this device first saw each line. A slow connection then still shows the whole
// effect, only lines that were solved long ago stay without one (reload).
const firstSeen = new Map();

function fxTotal(style, reach) {
  const t = REVEAL_FX[style];
  return Math.max(t.lead + reach * t.step + t.cell + t.tail, t.nameDelay + t.nameDur);
}

/** Describes all locked lines of the round in claim order, with their running effect. */
function describeLines(state) {
  const { round, lines } = state;
  const n = round.size;
  const covered = new Set();
  const out = [];
  for (const line of lines) {
    const cells = lineCells(n, line.line_type, line.idx);
    const originK = line.origin_cell === null ? Math.floor(n / 2) : cells.indexOf(line.origin_cell);
    const reach = Math.max(originK, n - 1 - originK);
    const style = line.status === 'neutral' ? 'neutral' : 'balloon';
    const total = fxTotal(style, reach);
    const key = `${round.id}/${line.line_type}/${line.idx}`;
    if (!firstSeen.has(key) && serverNow() - new Date(line.claimed_at).getTime() < total) {
      firstSeen.set(key, Date.now());
    }
    const seen = firstSeen.get(key);
    const elapsed = seen === undefined ? Infinity : Date.now() - seen;
    out.push({
      line, cells, originK, style,
      active: elapsed < total,
      elapsed,
      // A digit counts as uncovered by the first line that reaches it.
      fresh: new Set(cells.filter((c) => round.givens[c] === '0' && !covered.has(c))),
      prior: new Set(cells.filter((c) => covered.has(c))),
    });
    cells.forEach((c) => covered.add(c));
  }
  return out;
}

/** True while a reveal effect is running in this round. */
export function isFxRunning(state) {
  return !!state.round && describeLines(state).some((d) => d.active);
}

/**
 * Sound cues of the running reveal effects, in ms from now: when each balloon pops and when
 * the line lights up. Uses the same timing as the effect, so sound and picture stay together.
 */
export function revealCues(state) {
  if (!state.round) return [];
  const n = state.round.size;
  return describeLines(state).filter((d) => d.active).map((d) => {
    const t = REVEAL_FX[d.style];
    const reach = Math.max(d.originK, n - 1 - d.originK);
    return {
      key: `${state.round.id}/${d.line.line_type}/${d.line.idx}`,
      neutral: d.style === 'neutral',
      pops: d.cells.flatMap((c, k) => (d.fresh.has(c) ? [t.lead + Math.abs(k - d.originK) * t.step - d.elapsed] : [])),
      glow: t.lead + reach * t.step + t.cell * 0.35 - d.elapsed,
    };
  });
}

function seeded(seed) {
  const x = Math.sin(seed * 127.1 + 11.7) * 43758.5453;
  return x - Math.floor(x);
}

function fxLayerHtml(n, items, playerById) {
  let html = '';
  let names = '';
  for (const d of items) {
    if (d.style === 'neutral') continue;
    const t = REVEAL_FX[d.style];
    const { line } = d;
    const player = playerById.get(line.player_id);
    const color = esc(player.color);
    const reach = Math.max(d.originK, n - 1 - d.originK);
    const pos = line.line_type === 'row'
      ? `top:calc(100% * ${line.idx} / ${n});height:calc(100% / ${n});left:0;width:100%`
      : `left:calc(100% * ${line.idx} / ${n});width:calc(100% / ${n});top:0;height:100%`;
    const glowDelay = t.lead + reach * t.step + t.cell * 0.35 - d.elapsed;
    html += `<div class="fx-band" style="${pos};--fxc:${color};--d:${glowDelay}ms;--dur:${t.tail + t.cell * 0.65}ms"></div>`;
    d.cells.forEach((c, k) => {
      if (!d.fresh.has(c)) return;
      const start = Math.abs(k - d.originK) * t.step - d.elapsed;
      const popAt = start + t.lead;
      const at = `left:calc(100% * ${(c % n) + 0.5} / ${n});top:calc(100% * ${Math.floor(c / n) + 0.5} / ${n});--fxc:${color}`;
      html += `<i class="fx-balloon" style="${at};--size:calc(100% / ${n} * 0.84);--d:${start}ms;--dur:${t.lead}ms"></i>`;
      html += `<i class="fx-ring" style="${at};--size:calc(100% / ${n});--d:${popAt}ms"></i>`;
      for (let s = 0; s < REVEAL_FX.shardsPerBalloon; s++) {
        const angle = ((s + seeded(c * 13 + s)) / REVEAL_FX.shardsPerBalloon) * Math.PI * 2;
        const dist = 0.75 + seeded(c * 7 + s * 3) * 0.95;
        html += `<i class="fx-shard${s % 3 === 2 ? ' white' : ''}" style="${at};--dx:${(Math.cos(angle) * dist).toFixed(2)}em;--dy:${(Math.sin(angle) * dist).toFixed(2)}em;--rot:${Math.round(seeded(c + s) * 540 - 270)}deg;--d:${popAt}ms"></i>`;
      }
    });
    // Across the line the name shifts with its position, so it always stays inside the grid.
    const x = line.line_type === 'row' ? 0.5 : (line.idx + 0.5) / n;
    const y = line.line_type === 'row' ? (line.idx + 0.5) / n : 0.5;
    names += `<i class="fx-name" style="left:${x * 100}%;top:${y * 100}%;--shift:${-x * 100}%;--fxc:${color};--ink:${esc(player.ink)};--d:${t.nameDelay - d.elapsed}ms;--dur:${t.nameDur}ms">${esc(player.name)}</i>`;
  }
  return html ? `<div class="fx-layer">${html}${names}</div>` : '';
}

/**
 * @param state    snapshot from get_state, with a round
 * @param options  phone: buttons and own entries; entries: Map cell -> digit;
 *                 sel: selected cell or -1; flash: cell flashing red or -1; meColor
 */
export function gridHtml(state, { phone = false, entries = new Map(), sel = -1, flash = -1, meColor = '' } = {}) {
  const { round, players, palette } = state;
  const n = round.size;
  const [boxRows, boxCols] = BOX[n];
  const inkOf = (color) => palette.find((c) => c.color === color)?.ink || '#000000';
  const playerById = new Map(players.map((p) => [p.id, { ...p, ink: inkOf(p.color) }]));
  const colorOf = (line) => (line.status === 'neutral' ? NEUTRAL_COLOR : playerById.get(line.player_id).color);

  const described = describeLines(state);
  const rowOwner = new Map();
  const colOwner = new Map();
  for (const { line } of described) (line.line_type === 'row' ? rowOwner : colOwner).set(line.idx, colorOf(line));

  // At a crossing, the line that actually uncovers the digit drives the cell's animation.
  const active = described.filter((d) => d.active);
  const fxByCell = new Map();
  for (const d of active) {
    d.cells.forEach((c, k) => {
      if (!fxByCell.has(c) || d.fresh.has(c)) fxByCell.set(c, { d, k });
    });
  }

  const selRow = sel >= 0 ? Math.floor(sel / n) : -1;
  const selCol = sel >= 0 ? sel % n : -1;
  let html = `<div class="grid-wrap"><div class="grid" style="--n:${n}${meColor ? `;--me:${esc(meColor)}` : ''}">`;
  for (let idx = 0; idx < n * n; idx++) {
    const r = Math.floor(idx / n);
    const c = idx % n;
    const cls = ['cell'];
    if ((c + 1) % boxCols === 0 && c < n - 1) cls.push('br');
    if ((r + 1) % boxRows === 0 && r < n - 1) cls.push('bb');
    let digit = '';
    let style = '';
    const rowColor = rowOwner.get(r);
    const colColor = colOwner.get(c);
    if (rowColor || colColor) {
      digit = round.revealed[idx];
      cls.push('rev');
      style = `--line:${esc(rowColor || colColor)};`;
      if (rowColor && colColor && rowColor !== colColor) {
        cls.push('rev-cross');
        style += `--line2:${esc(colColor)};`;
      }
    } else if (round.givens[idx] !== '0') {
      digit = round.givens[idx];
      cls.push('given');
    } else if (phone && entries.has(idx)) {
      digit = entries.get(idx);
      cls.push('own');
    }
    if (phone) {
      if (idx === sel) cls.push('sel');
      else if (r === selRow || c === selCol) cls.push('peer');
      if (idx === flash) cls.push('flash');
    }
    const fx = fxByCell.get(idx);
    if (fx) {
      const t = REVEAL_FX[fx.d.style];
      const delay = t.lead + Math.abs(fx.k - fx.d.originK) * t.step - fx.d.elapsed;
      cls.push('fx', `fx-c-${fx.d.style}`);
      if (fx.d.fresh.has(idx)) cls.push('fx-fresh');
      if (fx.d.prior.has(idx)) {
        cls.push('fx-prior');
        // Until the effect arrives, a crossed cell keeps the colour of the older line.
        style += `--prior:${esc(fx.d.line.line_type === 'row' ? colColor : rowColor)};`;
      }
      style += `--fxc:${esc(colorOf(fx.d.line))};--d:${delay}ms;--dur:${t.cell}ms;`;
    }
    const attr = style ? ` style="${style}"` : '';
    html += phone
      ? `<button class="${cls.join(' ')}"${attr} data-cell="${idx}" type="button" aria-label="Zeile ${r + 1}, Spalte ${c + 1}">${digit}</button>`
      : `<div class="${cls.join(' ')}"${attr}>${digit}</div>`;
  }
  return `${html}</div>${fxLayerHtml(n, active, playerById)}</div>`;
}
