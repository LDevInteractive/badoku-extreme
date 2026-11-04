// Badoku-Extreme - clickable mock-up of all screens. No server, no real game
// logic: a small local state imitates what get_state would deliver. Classic
// script (no ES module) so the file also opens with a double click.
(function () {
  'use strict';

  // Values mirror config in CLAUDE.md section 6.2.
  const CFG = {
    hunt_duration_s: 50, hunt_min_press_s: 10, trial_hunt_duration_s: 15, trial_hunt_min_press_s: 5,
    error_window_s: 30, error_max: 3, lock_s: 20, distribute_timeout_s: 60, force_continue_after_s: 120,
    tiebreak_limit_s: 90, balloons_total: 35, coins_total_cents: 940,
  };

  const PLAYERS = [
    { name: 'Anna', color: '#E5484D', ink: '#fff', lines: 5, ok: 3, hunts: 4, cents: 127 },
    { name: 'Ben', color: '#F76B15', ink: '#000', lines: 7, ok: 4, hunts: 5, cents: 190 },
    { name: 'Cara', color: '#FFC53D', ink: '#000', lines: 2, ok: 1, hunts: 3, cents: 88 },
    { name: 'Dario', color: '#30A46C', ink: '#000', lines: 4, ok: 3, hunts: 4, cents: 127 },
    { name: 'Elin', color: '#12A594', ink: '#000', lines: 3, ok: 3, hunts: 3, cents: 130 },
    { name: 'Fabio', color: '#3E63DD', ink: '#fff', lines: 1, ok: 1, hunts: 2, cents: 88 },
    { name: 'Luca', color: '#8E4EC6', ink: '#fff', lines: 3, ok: 2, hunts: 3, cents: 190 },
  ];
  const ME = 6;
  const NEUTRAL = '#8B8D98';
  const others = PLAYERS.map((_, i) => i).filter((i) => i !== ME);

  // Reveal effect, all timings in ms. step = delay per cell away from the
  // completing cell, cell = length of one cell's animation, lead = time until
  // the first balloon pops, tail = afterglow of the whole line. The solver's
  // name shows from nameDelay for nameDur.
  const FX = {
    balloon: { step: 95, lead: 430, cell: 460, tail: 560, nameDelay: 300, nameDur: 1500 },
    neutral: { step: 26, lead: 0, cell: 520, tail: 0, nameDelay: 0, nameDur: 0 },
  };
  const SHARDS_PER_BALLOON = 7;

  const PLAY_SUBS = [['play', 'Spielen'], ['lock', 'Sperre'], ['hunt', 'Jagd: Button gesperrt'], ['huntready', 'Jagd: Button aktiv'], ['success', 'Erfolg'], ['failed', 'Zeit abgelaufen'], ['many', 'TV: 7 Jagden gleichzeitig']];
  const PHASES = [
    { id: 'start', label: 'Start', subs: [] },
    { id: 'lobby', label: 'Lobby', subs: [['wait', 'Spieler treten bei'], ['trialdone', 'Proberunde fertig']] },
    { id: 'trial', label: 'Proberunde 4×4', subs: PLAY_SUBS },
    { id: 'round', label: 'Sudoku 9×9', subs: PLAY_SUBS },
    { id: 'ending', label: 'Rundenende', subs: [] },
    { id: 'distribute', label: 'Pause: Verteilen', subs: [['have', 'Hat Shots'], ['none', 'Nichts zu verteilen']] },
    { id: 'drink', label: 'Pause: Trinken', subs: [['drink', 'Trinken'], ['force', 'Weiter erzwingen']] },
    { id: 'cashout', label: 'Kassensturz', subs: [['input', 'Eingabe'], ['reveal', 'Enthüllung']] },
    { id: 'tiebreak', label: 'Powersudoku 6×6', subs: [['play', 'In einer Gruppe'], ['watch', 'Zuschauen']] },
    { id: 'results', label: 'Resultate', subs: [] },
  ];

  const S = {
    phase: 'round', sub: 'play', view: window.innerWidth < 900 ? 'phone' : 'both',
    joinColor: 6, joinName: 'Luca', joined: false,
    balloons: 23, roundEnd: 0, gameEnd: 0,
    hunt: null, lockedUntil: 0, errCount: 0, errStart: 0, flash: -1, sel: -1,
    games: {}, hunts: [], ticker: [],
    gave: {}, cashInput: '', cashSent: false, drinkReady: false, reveal: 0, revealStart: 0,
    tbEnd: 0, distributeEnd: 0,
    fxItems: [], fxNextPlayer: 1, demoNote: '',
  };

  // ---------- Small helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const now = () => Date.now();
  const money = (c) => `${(c / 100).toFixed(2)} €`;
  const swatch = (i) => `<span class="sw" style="--c:${PLAYERS[i].color}"></span>`;
  const countdown = (end, fmt = 'mmss') => `<span data-cd="${end}" data-fmt="${fmt}"></span>`;
  const fmtTime = (ms, fmt) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return fmt === 's' ? String(s) : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const stat = (value, label) => `<div class="ph-stat"><b>${value}</b><span>${label}</span></div>`;

  // ---------- Puzzle state ----------
  function boxOf(n) { return n === 4 ? [2, 2] : n === 6 ? [2, 3] : [3, 3]; }
  function lineCells(n, type, i) {
    const out = [];
    for (let k = 0; k < n; k++) out.push(type === 'row' ? i * n + k : k * n + i);
    return out;
  }
  function newGame(n, kind) {
    const p = window.MOCK_DATA.puzzles[n];
    const g = {
      n, kind,
      givens: [...p.givens].map(Number), sol: [...p.solution].map(Number),
      revealed: [...p.givens].map(Number), entries: new Set(), locks: {}, owner: {}, target: -1,
    };
    if (kind === 'main') {
      claim(g, 'row', 1, 0); claim(g, 'col', 5, 1); claim(g, 'row', 6, 2); claim(g, 'col', 0, 3); claim(g, 'col', 3, 4);
      claim(g, 'row', 4, 'neutral');
    }
    if (kind !== 'tie') prepareTarget(g);
    return g;
  }
  // Pre-fills one line almost completely so a single tap shows the claim flow.
  function prepareTarget(g) {
    g.target = -1;
    let best = null;
    for (let i = 0; i < g.n; i++) {
      if (g.locks[`row${i}`] !== undefined) continue;
      const empty = lineCells(g.n, 'row', i).filter((c) => !g.revealed[c]);
      if (empty.length >= 2 && (!best || empty.length < best.length)) best = empty;
    }
    if (best) {
      best.slice(0, -1).forEach((c) => g.entries.add(c));
      g.target = best[best.length - 1];
    }
  }
  function claim(g, type, i, who) {
    g.locks[type + i] = who;
    for (const c of lineCells(g.n, type, i)) {
      if (g.owner[c] === undefined) g.owner[c] = who;
      g.revealed[c] = g.sol[c];
      g.entries.delete(c);
    }
  }
  function game() {
    const key = S.phase;
    if (!S.games[key]) S.games[key] = newGame(key === 'trial' ? 4 : key === 'tiebreak' ? 6 : 9, key === 'trial' ? 'trial' : key === 'tiebreak' ? 'tie' : 'main');
    return S.games[key];
  }

  // ---------- Reveal effects ----------
  // Claims a line and registers its effect. All state needed to draw the effect
  // is kept here and drawn from elapsed time, so any re-render continues the
  // animation instead of restarting it (the real game re-renders on every snapshot).
  function claimWithFx(g, type, i, who, origin) {
    const cells = lineCells(g.n, type, i);
    const fresh = new Set(cells.filter((c) => !g.revealed[c]));
    const prior = new Set(cells.filter((c) => g.owner[c] !== undefined));
    claim(g, type, i, who);
    const style = who === 'neutral' ? 'neutral' : 'balloon';
    const t = FX[style];
    const originK = cells.indexOf(origin);
    const reach = Math.max(originK, g.n - 1 - originK);
    S.fxItems.push({
      g, type, i, who, style, cells, fresh, prior, originK, start: now(),
      total: Math.max(t.lead + reach * t.step + t.cell + t.tail, t.nameDelay + t.nameDur),
    });
  }
  const ownerColor = (who) => (who === 'neutral' ? NEUTRAL : PLAYERS[who].color);
  function activeFx(g) {
    const t = now();
    S.fxItems = S.fxItems.filter((f) => t - f.start < f.total);
    return S.fxItems.filter((f) => f.g === g);
  }
  // Stable pseudo-random numbers, so shards do not jump when a re-render happens.
  function seeded(seed) {
    const x = Math.sin(seed * 127.1 + 11.7) * 43758.5453;
    return x - Math.floor(x);
  }
  function fxLayerHtml(g, items) {
    let html = '';
    let names = '';
    for (const f of items) {
      if (f.style === 'neutral') continue;
      const t = FX[f.style];
      const el = now() - f.start;
      const color = PLAYERS[f.who].color;
      const pos = f.type === 'row' ? `top:calc(100% * ${f.i} / ${g.n});height:calc(100% / ${g.n});left:0;width:100%` : `left:calc(100% * ${f.i} / ${g.n});width:calc(100% / ${g.n});top:0;height:100%`;
      const reach = Math.max(f.originK, g.n - 1 - f.originK);
      const glowDelay = t.lead + reach * t.step + t.cell * 0.35 - el;
      html += `<div class="fx-band" style="${pos};--fxc:${color};--d:${glowDelay}ms;--dur:${t.tail + t.cell * 0.65}ms"></div>`;
      f.cells.forEach((c, k) => {
        if (!f.fresh.has(c)) return;
        const row = Math.floor(c / g.n);
        const col = c % g.n;
        const start = Math.abs(k - f.originK) * t.step - el;
        const popAt = start + t.lead;
        const at = `left:calc(100% * ${col + 0.5} / ${g.n});top:calc(100% * ${row + 0.5} / ${g.n});--fxc:${color}`;
        html += `<i class="fx-balloon" style="${at};--size:calc(100% / ${g.n} * 0.84);--d:${start}ms;--dur:${t.lead}ms"></i>`;
        html += `<i class="fx-ring" style="${at};--size:calc(100% / ${g.n});--d:${popAt}ms"></i>`;
        for (let s = 0; s < SHARDS_PER_BALLOON; s++) {
          const angle = ((s + seeded(c * 13 + s)) / SHARDS_PER_BALLOON) * Math.PI * 2;
          const dist = 0.75 + seeded(c * 7 + s * 3) * 0.95;
          const white = s % 3 === 2;
          html += `<i class="fx-shard${white ? ' white' : ''}" style="${at};--dx:${(Math.cos(angle) * dist).toFixed(2)}em;--dy:${(Math.sin(angle) * dist).toFixed(2)}em;--rot:${Math.round(seeded(c + s) * 540 - 270)}deg;--d:${popAt}ms"></i>`;
        }
      });
      // Name in the middle of the line. Across the line it shifts with its position,
      // so a long name on an outer column stays inside the grid.
      const x = f.type === 'row' ? 0.5 : (f.i + 0.5) / g.n;
      const y = f.type === 'row' ? (f.i + 0.5) / g.n : 0.5;
      names += `<i class="fx-name" style="left:${x * 100}%;top:${y * 100}%;--shift:${-x * 100}%;--fxc:${color};--ink:${PLAYERS[f.who].ink};--d:${t.nameDelay - el}ms;--dur:${t.nameDur}ms">${esc(PLAYERS[f.who].name)}</i>`;
    }
    return html ? `<div class="fx-layer">${html}${names}</div>` : '';
  }

  function gridHtml(g, phone) {
    const [br, bc] = boxOf(g.n);
    const selRow = S.sel >= 0 ? Math.floor(S.sel / g.n) : -1;
    const selCol = S.sel >= 0 ? S.sel % g.n : -1;
    const fxItems = activeFx(g);
    const fxByCell = new Map();
    // At a crossing the line that actually uncovers the digit decides the animation.
    fxItems.forEach((f) => f.cells.forEach((c, k) => { if (!fxByCell.has(c) || f.fresh.has(c)) fxByCell.set(c, { f, k }); }));
    let html = `<div class="grid-wrap"><div class="grid" style="--n:${g.n}${phone ? `;--me:${PLAYERS[ME].color}` : ''}">`;
    for (let idx = 0; idx < g.n * g.n; idx++) {
      const r = Math.floor(idx / g.n);
      const c = idx % g.n;
      const cls = ['cell'];
      if ((c + 1) % bc === 0 && c < g.n - 1) cls.push('br');
      if ((r + 1) % br === 0 && r < g.n - 1) cls.push('bb');
      let digit = '';
      let style = '';
      // A line keeps its colour along its full length. Where two solved lines of
      // different owners cross, the cell shows both (row left/right, column top/bottom).
      const rowOwner = g.locks[`row${r}`];
      const colOwner = g.locks[`col${c}`];
      if (rowOwner !== undefined || colOwner !== undefined) {
        digit = g.sol[idx];
        cls.push('rev');
        style = `--line:${ownerColor(rowOwner !== undefined ? rowOwner : colOwner)};`;
        if (rowOwner !== undefined && colOwner !== undefined && rowOwner !== colOwner) {
          cls.push('rev-cross');
          style += `--line2:${ownerColor(colOwner)};`;
        }
      } else if (g.givens[idx]) {
        digit = g.givens[idx];
        cls.push('given');
      } else if (phone && g.entries.has(idx)) {
        digit = g.sol[idx];
        cls.push('own');
      }
      if (phone) {
        if (idx === S.sel) cls.push('sel');
        else if (r === selRow || c === selCol) cls.push('peer');
        if (idx === S.flash) cls.push('flash');
      }
      const fx = fxByCell.get(idx);
      if (fx) {
        const t = FX[fx.f.style];
        const delay = t.lead + Math.abs(fx.k - fx.f.originK) * t.step - (now() - fx.f.start);
        cls.push('fx', `fx-c-${fx.f.style}`);
        if (fx.f.fresh.has(idx)) cls.push('fx-fresh');
        if (fx.f.prior.has(idx)) {
          cls.push('fx-prior');
          // Until the effect arrives, a crossed cell keeps the colour of the older line.
          style += `--prior:${ownerColor(fx.f.type === 'row' ? colOwner : rowOwner)};`;
        }
        style += `--fxc:${ownerColor(fx.f.who)};--d:${delay}ms;--dur:${t.cell}ms;`;
      }
      const attr = style ? ` style="${style}"` : '';
      html += phone
        ? `<button class="${cls.join(' ')}"${attr} data-act="cell" data-arg="${idx}" type="button" aria-label="Zeile ${r + 1}, Spalte ${c + 1}">${digit}</button>`
        : `<div class="${cls.join(' ')}"${attr}>${digit}</div>`;
    }
    return `${html}</div>${fxLayerHtml(g, fxItems)}</div>`;
  }

  // Mock only: lets an opponent (or nobody) reveal a line, to show what a phone sees
  // when somebody else solves. mode: 'one', 'cross', 'steal' or 'neutral'.
  function demoReveal(mode) {
    let g = game();
    S.hunt = null;
    S.lockedUntil = 0;
    S.sub = 'play';
    S.fxItems = [];
    const targetGone = () => g.target >= 0 && (g.owner[g.target] !== undefined || g.entries.has(g.target));
    if (targetGone() || g.target < 0) prepareTarget(g);
    const openLines = () => {
      const targetRow = g.target >= 0 ? Math.floor(g.target / g.n) : -1;
      const targetCol = g.target >= 0 ? g.target % g.n : -1;
      const out = [];
      for (let i = 0; i < g.n; i++) {
        for (const type of ['row', 'col']) {
          if (g.locks[type + i] !== undefined) continue;
          if (type === 'row' ? i === targetRow : i === targetCol) continue;
          const hidden = lineCells(g.n, type, i).filter((c) => !g.revealed[c]);
          if (hidden.length >= 2) out.push({ type, i, hidden });
        }
      }
      return out;
    };
    let open = openLines();
    const need = mode === 'cross' ? 2 : 1;
    if (open.length < need || (mode === 'steal' && g.target < 0)) {
      delete S.games[S.phase];
      g = game();
      open = openLines();
    }
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    const who = mode === 'neutral' ? 'neutral' : others[S.fxNextPlayer++ % others.length];
    const labels = [];
    if (mode === 'steal') {
      const row = Math.floor(g.target / g.n);
      claimWithFx(g, 'row', row, who, g.target);
      labels.push(`Zeile ${row + 1}`);
    }
    if (mode === 'cross') {
      const rows = open.filter((l) => l.type === 'row');
      const cols = open.filter((l) => l.type === 'col');
      if (rows.length && cols.length) {
        const row = pick(rows);
        const col = pick(cols);
        const origin = row.i * g.n + col.i;
        claimWithFx(g, 'row', row.i, who, origin);
        claimWithFx(g, 'col', col.i, who, origin);
        labels.push(`Zeile ${row.i + 1}`, `Spalte ${col.i + 1}`);
      }
    }
    if (!labels.length) {
      const line = pick(open);
      claimWithFx(g, line.type, line.i, who, pick(line.hidden));
      labels.push(`${line.type === 'row' ? 'Zeile' : 'Spalte'} ${line.i + 1}`);
    }
    if (S.sel >= 0 && g.owner[S.sel] !== undefined) S.sel = -1;
    if (targetGone()) prepareTarget(g);
    const label = labels.join(' + ');
    const name = who === 'neutral' ? '' : PLAYERS[who].name;
    S.demoNote = {
      one: `<b>${name} löst ${label}.</b> So sieht es auf deinem Handy und allen anderen aus. Auf dem Handy von ${name} erscheint stattdessen sofort der Jagd-Bildschirm.`,
      cross: `<b>${name} löst ${label}.</b> Zwei Linien, aber nur eine Jagd. Wo sich zwei Linien verschiedener Spieler kreuzen, zeigt die Zelle beide Farben.`,
      steal: `<b>${name} war schneller:</b> ${label} war bei dir fast fertig. Deine Zahlen darin gehen in der Farbe von ${name} auf, du bekommst dafür nichts.`,
      neutral: `<b>${label} neutral.</b> Niemand hat sie gelöst, also kein Name und keine Ballone.`,
    }[mode];
    if (who === 'neutral') {
      S.ticker.unshift(`${label} neutral aufgedeckt`);
    } else {
      S.ticker.unshift(`${PLAYERS[who].name} löst ${label}`);
      if (g.kind === 'main') {
        PLAYERS[who].lines += labels.length;
        S.balloons = Math.max(0, S.balloons - 1);
        const t = now();
        S.hunts = S.hunts.slice(-3);
        S.hunts.push({ p: who, label, start: t, end: t + CFG.hunt_duration_s * 1000 });
      }
    }
    render();
  }

  // ---------- Phone screens ----------
  const PHONE = {
    start() {
      const taken = [0, 1, 3];
      return `<div class="ph-pad">
        <h1 class="ph-title">Mitspielen</h1>
        <div class="field"><label class="label" for="j-code">Spielcode</label><input class="input mono" id="j-code" value="4711" inputmode="numeric"></div>
        <div class="field"><label class="label" for="j-name">Name (max. 16 Zeichen)</label><input class="input" id="j-name" maxlength="16" value="${esc(S.joinName)}"></div>
        <div class="field"><span class="label">Farbe</span><div class="colors">
        ${PLAYERS.map((p, i) => `<button class="color-btn" style="--c:${p.color};--ink:${p.ink}" data-act="color" data-arg="${i}" aria-pressed="${S.joinColor === i}" ${taken.includes(i) ? 'disabled' : ''} type="button">${taken.includes(i) ? p.name : ''}</button>`).join('')}
        <button class="color-btn" style="--c:#D6409F;--ink:#fff" disabled type="button">nur Test</button></div></div>
        <button class="btn btn-primary btn-big btn-block" data-act="phase" data-arg="lobby" type="button" style="margin-top:auto">Beitreten</button>
      </div>`;
    },
    lobby() {
      return `<div class="ph-pad">
        <h1 class="ph-title">${S.sub === 'trialdone' ? 'Proberunde geschafft. Warte auf das Hauptspiel.' : 'Warte auf den Start'}</h1>
        <p class="dim">Tippe einmal auf den Bildschirm, damit er während der Jagd anbleibt.</p>
        <ul class="plist">${PLAYERS.map((p, i) => `<li>${swatch(i)}<strong>${p.name}</strong>${i === ME ? '<span class="faint">du</span>' : ''}</li>`).join('')}</ul>
      </div>`;
    },
    trial() { return playScreen(); },
    round() { return playScreen(); },
    ending() {
      return `<div class="ph-pad ph-center"><h1 class="ph-title">Runde beendet</h1><p class="dim">Warte auf laufende Jagden.</p></div>`;
    },
    distribute() {
      if (S.sub === 'none') return `<div class="ph-pad ph-center"><h1 class="ph-title">Nichts zu verteilen</h1><p class="dim">Warte auf die anderen.</p></div>`;
      const left = sipsLeft();
      if (!left) return `<div class="ph-pad ph-center"><h1 class="ph-title">Alles verteilt</h1><p class="dim">Warte auf die anderen.</p></div>`;
      return `<div class="ph-pad">
        <h1 class="ph-title">Du hast ${left} ${left === 1 ? 'Shot' : 'Shots'} zu verteilen</h1>
        <div class="tiles">${others.map((i) => `<button class="tile" style="--c:${PLAYERS[i].color};--ink:${PLAYERS[i].ink}" data-act="give" data-arg="${i}" type="button">${PLAYERS[i].name}<small>${received(i)} erhalten</small></button>`).join('')}</div>
        <button class="btn btn-block" data-act="randomsips" type="button">Zufall</button>
        <p class="small faint center">Automatisch per Zufall in ${countdown(S.distributeEnd)}</p>
      </div>`;
    },
    drink() {
      const from = others.filter((i) => gave(i, ME) > 0);
      const total = from.reduce((a, i) => a + gave(i, ME), 0);
      if (S.drinkReady) return `<div class="ph-pad ph-center"><div class="ph-big" style="color:var(--accent)">✓</div><h1 class="ph-title">Bereit</h1><p class="dim">Warte auf die anderen.</p></div>`;
      return `<div class="ph-pad ph-center">
        <p class="label">Du musst trinken</p><div class="ph-big" style="font-size:112px">${total}</div><h1 class="ph-title">${total === 1 ? 'Shot' : 'Shots'}</h1>
        <ul class="plist">${from.map((i) => `<li>${swatch(i)}<strong class="grow">${PLAYERS[i].name}</strong><b>${gave(i, ME)}</b></li>`).join('')}</ul>
        <button class="btn btn-primary btn-big btn-block" data-act="ready" type="button" style="margin-top:auto">Getrunken &amp; bereit</button>
      </div>`;
    },
    cashout() {
      const n = PLAYERS[ME].ok;
      if (S.sub === 'reveal') return `<div class="ph-pad ph-center"><h1 class="ph-title">Kassensturz abgeschlossen</h1><p class="dim">Schau auf den TV.</p></div>`;
      return `<div class="ph-pad">
        <p class="label">Kassensturz</p>
        <h1 class="ph-title">Du darfst ${n} ${n === 1 ? 'Ballon' : 'Ballone'} platzen lassen</h1>
        <p class="dim">Zähle dein Geld am Tisch und gib den Gesamtbetrag ein.</p>
        <div class="field"><label class="label" for="cash">Betrag in Euro</label>
        <input class="input amount" id="cash" inputmode="decimal" placeholder="0.00" value="${esc(S.cashInput)}" ${S.cashSent ? 'disabled' : ''}></div>
        ${S.cashSent
          ? `<p class="center" style="color:var(--ok);font-weight:800">✓ Gesendet. Der Betrag bleibt verborgen.</p><button class="btn btn-block" data-act="cashedit" type="button">Ändern</button>`
          : `<button class="btn btn-primary btn-big btn-block" data-act="cashsend" type="button">Senden</button><p class="small faint center" id="cash-err"></p>`}
      </div>`;
    },
    tiebreak() {
      if (S.sub === 'watch') {
        return `<div class="ph-pad ph-center"><h1 class="ph-title">Zuschauen</h1><p class="dim">Auf dem TV läuft das Powersudoku. Noch ${countdown(S.tbEnd)}.</p></div>`;
      }
      return playScreen();
    },
    results() {
      return `<div class="ph-pad">
        <p class="label">Dein Resultat</p>
        <div class="ph-big" style="color:var(--accent)">1. Rang</div>
        <h1 class="ph-title">${money(PLAYERS[ME].cents)}</h1>
        <div>
          ${[['Beanspruchte Linien', '3'], ['Schnellste Linie', '1:12 ab Rundenstart'], ['Jagden', '2 von 3 erfolgreich (67 %)'], ['Fehler', '6'], ['Ausgelöste Sperren', '1'], ['Shots verteilt', '3'], ['Shots erhalten', '4'], ['Lieblingsopfer', 'Ben, 2 Shots']].map(([k, v]) => `<div class="statline"><span class="dim">${k}</span><b>${v}</b></div>`).join('')}
        </div>
      </div>`;
    },
  };

  function playScreen() {
    const g = game();
    const isTie = g.kind === 'tie';
    const locked = S.lockedUntil > now();
    const fs = g.n === 9 ? 25 : g.n === 6 ? 34 : 48;
    const counts = {};
    for (let c = 0; c < g.n * g.n; c++) {
      const v = g.owner[c] !== undefined || g.givens[c] || g.entries.has(c) ? g.sol[c] : 0;
      counts[v] = (counts[v] || 0) + 1;
    }
    const keys = [];
    for (let d = 1; d <= g.n; d++) keys.push(`<button data-act="digit" data-arg="${d}" class="${counts[d] >= g.n ? 'done' : ''}" type="button">${d}</button>`);
    const stats = isTie
      ? stat(countdown(S.tbEnd), 'Limit') + stat(`${g.entries.size}`, 'Korrekt') + stat(`${g.givens.filter((v) => !v).length}`, 'Offen')
      : stat(countdown(S.roundEnd), g.kind === 'trial' ? 'Probe' : 'Runde') + (g.kind === 'trial' ? stat('–', 'Ballone') + stat(trialLines(g), 'Linien') : stat(S.balloons, 'Ballone') + stat(PLAYERS[ME].lines, 'Linien'));
    let html = `<div class="ph-head">${stats}</div>
      <div class="ph-sub"><span>${g.kind === 'trial' ? 'Proberunde, zählt nicht' : isTie ? 'Powersudoku, zuerst fertig gewinnt' : 'Runde 2'}</span>
      <span class="err-dots" aria-label="${S.errCount} Fehler">${[0, 1, 2].map((k) => `<i class="${k < S.errCount ? 'on' : ''}"></i>`).join('')}</span></div>
      <div class="ph-grid" style="--fs:${fs}px">${gridHtml(g, true)}</div>
      <div class="keypad" style="grid-template-columns:repeat(${g.n === 9 ? 5 : g.n === 6 ? 3 : 4},1fr)">${keys.join('')}</div>`;
    if (locked) {
      html += `<div class="overlay ov-lock"><p class="label">Gesperrt</p><div class="ph-big" style="font-size:112px">${countdown(S.lockedUntil, 's')}</div><h1 class="ph-title">3 Fehler in 30 Sekunden</h1><p class="dim">Danach geht es normal weiter.</p></div>`;
    }
    if (S.hunt) html += huntOverlay();
    return html;
  }

  function trialLines(g) { return Object.values(g.locks).filter((w) => w === ME).length; }

  function huntOverlay() {
    const h = S.hunt;
    if (h.status === 'success') return `<div class="overlay ov-hunt"><div class="ov-mark">✔</div><h1 class="ph-title">Ballon zählt!</h1><p class="rule">Du darfst beim Kassensturz einen Ballon mehr platzen lassen.</p></div>`;
    if (h.status === 'failed') return `<div class="overlay ov-fail"><div class="ov-mark">✗</div><h1 class="ph-title">Zeit abgelaufen</h1><p class="rule">Ein mitgebrachter Ballon darf ins Depot, zählt aber nicht.</p></div>`;
    const span = h.min - h.start;
    return `<div class="overlay ov-hunt">
      <h1 class="ph-title">${esc(h.label)} gelöst!</h1>
      <div class="cd">${countdown(h.end, 's')}</div>
      <p class="rule">Handy liegen lassen. Ballon holen. Ab ins Depot.</p>
      <button class="hunt-btn" id="hunt-btn" data-act="press" type="button" disabled data-min="${h.min}" data-start="${h.start}" data-span="${span}">
        <i class="fill"></i><span>BALLON IM DEPOT</span>
      </button>
    </div>`;
  }

  // ---------- TV screens ----------
  const TV = {
    start() {
      return `<div class="tv-center">
        <h1 class="brand" style="font-size:140px">Badoku<span class="brand-accent">-Extreme</span></h1>
        <p class="dim">Ein Sudoku, sieben Handys, 35 Ballone.</p>
        <div style="display:flex;gap:40px;width:1400px">
          <div class="tv-panel" style="flex:1;display:flex;flex-direction:column;gap:20px;text-align:left">
            <h2 class="tv-title" style="font-size:48px">Neues Spiel</h2>
            <label class="tv-label">Host-PIN (4 bis 6 Ziffern)</label>
            <div class="mono" style="font-size:52px;letter-spacing:.3em">••••</div>
            <label class="tv-label">Schwierigkeit</label>
            <div style="display:flex;gap:16px"><span class="btn btn-primary">leicht</span><span class="btn">mittel</span></div>
            <button class="btn btn-primary" data-act="phase" data-arg="lobby" type="button">Spiel erstellen</button>
          </div>
          <div class="tv-panel" style="flex:1;display:flex;flex-direction:column;gap:20px;text-align:left">
            <h2 class="tv-title" style="font-size:48px">Verbinden</h2>
            <label class="tv-label">Spielcode</label><div class="mono" style="font-size:52px">4711</div>
            <label class="tv-label">Host-PIN</label><div class="mono" style="font-size:52px;letter-spacing:.3em">••••</div>
            <button class="btn" data-act="phase" data-arg="lobby" type="button" style="margin-top:auto">Verbinden</button>
          </div>
        </div>
      </div>`;
    },
    lobby() {
      const { size, path } = window.MOCK_DATA.qr;
      const count = S.sub === 'wait' ? 5 : 7;
      return `<div class="tv-lobby">
        <div style="display:flex;flex-direction:column;gap:24px;align-items:center">
          <div class="qr" style="width:640px"><svg viewBox="0 0 ${size} ${size}" role="img" aria-label="QR-Code zum Beitritt"><path d="${path}" fill="#000"/></svg></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:28px">
          <div><span class="tv-label">Spielcode</span><div class="code">4711</div></div>
          <div class="tv-players">
            ${PLAYERS.map((p, i) => (i < count ? `<div class="tv-player" style="--c:${p.color};--ink:${p.ink}">${p.name}</div>` : `<div class="tv-player empty">wartet …</div>`)).join('')}
          </div>
          <div style="display:flex;gap:20px">
            <button class="btn" data-act="phase" data-arg="trial" type="button">Proberunde</button>
            <button class="btn btn-primary" data-act="phase" data-arg="round" type="button">Hauptspiel starten</button>
          </div>
        </div>
      </div>`;
    },
    trial() { return roundTv(true); },
    round() { return roundTv(false); },
    ending() {
      return `<div class="tv-center">
        <h1 class="tv-title">Runde 2 beendet</h1>
        <p class="dim">Laufende Jagden werden noch abgeschlossen.</p>
        <div style="width:1000px">${huntsHtml()}</div>
        <button class="btn" data-act="phase" data-arg="distribute" type="button">Weiter zur Pause (nur Attrappe)</button>
      </div>`;
    },
    distribute() {
      const head = PLAYERS.map((p, i) => `<th>${swatch(i)} ${p.name}</th>`).join('');
      const rows = PLAYERS.map((p, i) => {
        const cells = PLAYERS.map((_, j) => {
          if (i === j) return '<td class="self"></td>';
          const v = gave(i, j);
          return `<td class="${v ? 'hit' : ''}" style="--c:${p.color}">${v || ''}</td>`;
        }).join('');
        const left = i === ME ? (S.sub === 'none' ? 0 : sipsLeft()) : (i === 4 ? 2 : 0);
        return `<tr><th class="from">${swatch(i)}${p.name}</th>${cells}<td class="state ${left ? '' : 'ok'}">${left ? `noch ${left}` : '✓ verteilt'}</td></tr>`;
      }).join('');
      return `<div style="display:flex;flex-direction:column;gap:24px;height:100%">
        <div style="display:flex;justify-content:space-between;align-items:baseline"><h1 class="tv-title">Pause: Wer gibt wem?</h1><span class="tv-label">Automatisch in <b style="color:var(--accent);font-size:40px">${countdown(S.distributeEnd)}</b></span></div>
        <table class="matrix"><thead><tr><th></th>${head}<th>Status</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
    },
    drink() {
      const list = PLAYERS.map((p, i) => {
        const total = PLAYERS.reduce((a, _, j) => a + gave(j, i), 0);
        const ready = i === ME ? S.drinkReady : i !== 2 && i !== 5;
        return `<div class="cash-row">${swatch(i)}<div>${p.name}<small>trinkt ${total} ${total === 1 ? 'Shot' : 'Shots'}</small></div><span class="tick ${ready ? '' : 'no'}">${ready ? '✓' : '…'}</span></div>`;
      }).join('');
      return `<div style="display:flex;flex-direction:column;gap:28px;height:100%">
        <h1 class="tv-title">Pause: Trinken &amp; bereit machen</h1>
        <div class="cash-grid">${list}</div>
        <div style="margin-top:auto;display:flex;justify-content:space-between;align-items:center">
          <span class="dim">Nächstes Sudoku startet, sobald alle bereit sind.</span>
          ${S.sub === 'force' ? `<button class="btn btn-primary" data-act="phase" data-arg="cashout" type="button">Weiter erzwingen</button>` : ''}
        </div>
      </div>`;
    },
    cashout() {
      const reveal = S.sub === 'reveal';
      const sentAll = S.cashSent;
      const rows = PLAYERS.map((p, i) => {
        const done = i !== ME || S.cashSent;
        const right = reveal
          ? `<span class="val" data-count="${p.cents}">0.00 €</span>`
          : `<span class="tick ${done ? '' : 'no'}">${done ? '✓' : '…'}</span>`;
        return `<div class="cash-row">${swatch(i)}<div>${p.name}<small>darf ${p.ok} ${p.ok === 1 ? 'Ballon' : 'Ballone'} platzen lassen</small></div>${right}</div>`;
      }).join('');
      const total = PLAYERS.reduce((a, p) => a + p.cents, 0);
      return `<div style="display:flex;flex-direction:column;gap:28px;height:100%">
        <h1 class="tv-title">Kassensturz</h1>
        <div class="cash-grid">${rows}</div>
        <div style="margin-top:auto;display:flex;justify-content:space-between;align-items:center;gap:24px">
          ${reveal
            ? `<span>Summe aller Eingaben: <b style="color:var(--accent)">${money(total)}</b> von max. ${money(CFG.coins_total_cents)}</span><button class="btn btn-primary" data-act="phase" data-arg="tiebreak" type="button">Weiter</button>`
            : `<span class="dim">${sentAll ? 'Alle haben eingegeben. Beträge bleiben verborgen.' : 'Beträge bleiben verborgen, bis der Host abschliesst.'}</span><button class="btn btn-primary" data-act="closecash" type="button" ${sentAll ? '' : 'disabled'}>Kassensturz abschliessen</button>`}
        </div>
      </div>`;
    },
    tiebreak() {
      const groups = [[{ i: 6, v: game().entries.size }, { i: 1, v: 9 }], [{ i: 0, v: 14 }, { i: 3, v: 11 }], [{ i: 2, v: 6 }, { i: 5, v: 8 }]];
      const open = game().givens.filter((v) => !v).length;
      return `<div style="display:flex;flex-direction:column;gap:32px;height:100%">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h1 class="tv-title">Powersudoku</h1>
          <div class="tv-stat" style="text-align:right"><span class="tv-label">Limit</span><b style="color:var(--accent)">${countdown(S.tbEnd)}</b></div>
        </div>
        <p class="dim">Gleicher Betrag, gleiches Rätsel. Wer in seiner Gruppe zuerst fertig ist, beendet das Powersudoku für die Gruppe.</p>
        <div class="tb-groups">
          ${groups.map((gr, k) => `<div class="tv-panel"><h2 class="tv-label">Gruppe ${k + 1} · ${money(PLAYERS[gr[0].i].cents)}</h2>
            ${gr.map(({ i, v }) => `<div style="margin-top:28px;font-size:40px;font-weight:800;display:flex;justify-content:space-between"><span>${PLAYERS[i].name}</span><span class="mono">${v}/${open}</span></div><div class="prog" style="--c:${PLAYERS[i].color}"><i style="width:${(100 * v) / open}%"></i></div>`).join('')}
          </div>`).join('')}
        </div>
        <div style="margin-top:auto"><button class="btn" data-act="phase" data-arg="results" type="button">Zur Rangliste (nur Attrappe)</button></div>
      </div>`;
    },
    results() {
      const order = [6, 1, 4, 0, 3, 2, 5];
      const pod = (rank, i, h) => `<div class="pod" style="--c:${PLAYERS[i].color};--ink:${PLAYERS[i].ink};height:${h}px"><b>${rank}</b>${PLAYERS[i].name}<span style="font-size:26px">${money(PLAYERS[i].cents)}</span></div>`;
      return `<div class="res">
        <div style="display:flex;flex-direction:column;gap:24px;justify-content:flex-end">
          <h1 class="tv-title">Rangliste</h1>
          <div class="podium">${pod(2, 1, 340)}${pod(1, 6, 460)}${pod(3, 4, 260)}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:24px;min-width:0">
          <table class="rtable"><thead><tr><th class="l">Rang</th><th class="l">Name</th><th>Betrag</th><th>Linien</th><th>Jagden</th><th>Fehler</th><th>Erhalten</th></tr></thead><tbody>
          ${order.map((i, k) => `<tr><td class="l">${k + 1}</td><td class="l">${swatch(i)}${PLAYERS[i].name}${i === 5 || i === 2 ? '<span class="lot">Los</span>' : ''}</td><td>${money(PLAYERS[i].cents)}</td><td>${PLAYERS[i].lines}</td><td>${PLAYERS[i].ok}/${PLAYERS[i].hunts}</td><td>${[4, 7, 11, 5, 3, 8, 6][i]}</td><td>${[9, 6, 8, 4, 5, 19, 4][i]}</td></tr>`).join('')}
          </tbody></table>
          <div class="awards" style="margin-top:auto">
            ${[['Linien-König', 'Ben', '7 Linien'], ['Jagd-Profi', 'Elin', '3 von 3'], ['Fehlerteufel', 'Cara', '11 Fehler'], ['Shot-Magnet', 'Fabio', '19 erhalten'], ['Grosszügigster', 'Anna', '12 verteilt']].map(([a, n, d]) => `<div class="award"><span>${a}</span>${n}<small>${d}</small></div>`).join('')}
          </div>
        </div>
      </div>`;
    },
  };

  function huntsHtml() {
    const all = S.phase === 'trial' ? [] : S.hunts.slice();
    if (S.hunt && S.hunt.status === 'active') all.unshift({ p: ME, label: S.hunt.label, start: S.hunt.start, end: S.hunt.end });
    if (!all.length) return '<p class="dim" style="font-size:24px">Gerade keine Jagd.</p>';
    return `<div class="hunts ${all.length <= 3 ? 'few' : ''}">${all.map((h) => `<div class="hunt-row" style="--c:${PLAYERS[h.p].color}"><i class="fill" data-bar-start="${h.start}" data-bar-end="${h.end}"></i><span class="hl">${PLAYERS[h.p].name} · ${esc(h.label)}</span><span>${countdown(h.end, 's')} s</span></div>`).join('')}</div>`;
  }

  function roundTv(isTrial) {
    const g = game();
    return `<div class="tv-round">
      <div class="tv-grid">${gridHtml(g, false)}</div>
      <div class="tv-side">
        ${isTrial ? '<div><span class="tv-tag">PROBERUNDE · zählt nicht</span></div>' : ''}
        <div class="tv-stats" ${isTrial ? 'style="grid-template-columns:1fr"' : ''}>
          ${isTrial ? '' : `<div class="tv-panel tv-stat"><span class="tv-label">Spiel</span><b>${countdown(S.gameEnd)}</b></div>`}
          <div class="tv-panel tv-stat"><span class="tv-label">${isTrial ? 'Probe' : 'Runde 2'}</span><b>${countdown(S.roundEnd)}</b></div>
          ${isTrial ? '' : `<div class="tv-panel tv-stat hot"><span class="tv-label">Ballone</span><b>${S.balloons}</b></div>`}
        </div>
        <div class="tv-panel"><h2 class="tv-label" style="margin-bottom:10px">Jagden</h2>${huntsHtml()}</div>
        <div class="tv-panel"><div class="score">
          <span></span><span class="h" style="text-align:left">Spieler</span><span class="h">Linien</span><span class="h">Jagden ✓</span>
          ${PLAYERS.map((p, i) => `${swatch(i)}<span>${p.name}</span><span class="n">${isTrial ? (i === ME ? trialLines(g) : 0) : p.lines}</span><span class="n">${isTrial ? 0 : p.ok}</span>`).join('')}
        </div></div>
        <div class="tv-panel" style="flex:1"><div class="ticker">${(isTrial ? S.ticker.filter((t) => t.includes(PLAYERS[ME].name)) : S.ticker).slice(0, 5).map((t) => `<div>${esc(t)}</div>`).join('')}</div></div>
      </div>
    </div>`;
  }

  // ---------- Sips ----------
  function gave(a, b) { return (S.gave[a] && S.gave[a][b]) || 0; }
  function addSip(a, b) { S.gave[a] = S.gave[a] || {}; S.gave[a][b] = gave(a, b) + 1; }
  function received(i) { return PLAYERS.reduce((sum, _, j) => sum + gave(j, i), 0); }
  function sipsLeft() { return S.sipsTotal - others.reduce((a, i) => a + gave(ME, i), 0); }
  function resetSips() {
    S.gave = { 0: { 6: 2, 1: 1 }, 1: { 0: 1, 5: 3 }, 2: { 6: 1 }, 3: { 5: 2 }, 4: { 6: 1 } };
    S.sipsTotal = 3;
  }

  // ---------- Actions ----------
  function startHunt(label, elapsedMs) {
    const trial = S.phase === 'trial';
    const dur = (trial ? CFG.trial_hunt_duration_s : CFG.hunt_duration_s) * 1000;
    const min = (trial ? CFG.trial_hunt_min_press_s : CFG.hunt_min_press_s) * 1000;
    const start = now() - elapsedMs;
    S.hunt = { label, start, min: start + min, end: start + dur, status: 'active', held: false };
  }

  function enterDigit(d) {
    const g = game();
    if (S.sel < 0 || S.hunt || S.lockedUntil > now()) return;
    S.demoNote = '';
    const cell = S.sel;
    if (g.sol[cell] !== d) {
      if (!S.errCount || now() - S.errStart > CFG.error_window_s * 1000) { S.errCount = 1; S.errStart = now(); }
      else S.errCount++;
      S.flash = cell;
      if (navigator.vibrate) navigator.vibrate(120);
      setTimeout(() => { S.flash = -1; }, 520);
      if (S.errCount >= CFG.error_max) {
        S.lockedUntil = now() + CFG.lock_s * 1000;
        S.errCount = 0;
        S.ticker.unshift(`${PLAYERS[ME].name} ist ${CFG.lock_s} s gesperrt`);
      }
      render();
      return;
    }
    g.entries.add(cell);
    S.sel = -1;
    if (g.kind === 'tie') { render(); return; }
    const r = Math.floor(cell / g.n);
    const c = cell % g.n;
    const complete = (type, i) => g.locks[type + i] === undefined && lineCells(g.n, type, i).every((x) => g.revealed[x] || g.entries.has(x));
    const parts = [];
    const rowDone = complete('row', r);
    const colDone = complete('col', c);
    if (rowDone) { claimWithFx(g, 'row', r, ME, cell); parts.push(`Zeile ${r + 1}`); }
    if (colDone) { claimWithFx(g, 'col', c, ME, cell); parts.push(`Spalte ${c + 1}`); }
    if (parts.length) {
      const label = parts.join(' + ');
      S.ticker.unshift(`${PLAYERS[ME].name} löst ${label}`);
      if (g.kind === 'main') { PLAYERS[ME].lines += parts.length; S.balloons = Math.max(0, S.balloons - 1); }
      startHunt(label, 0);
      S.sub = 'hunt';
    }
    render();
  }

  function setPhase(id) {
    S.phase = id;
    S.demoNote = '';
    const p = PHASES.find((x) => x.id === id);
    S.sub = p.subs.length ? p.subs[0][0] : '';
    S.sel = -1; S.hunt = null; S.lockedUntil = 0; S.errCount = 0;
    S.reveal = 0;
    if (id === 'distribute') { resetSips(); S.distributeEnd = now() + CFG.distribute_timeout_s * 1000; }
    if (id === 'drink') { if (!S.sipsTotal) resetSips(); S.drinkReady = false; }
    if (id === 'cashout') { S.cashSent = false; S.cashInput = ''; }
    if (id === 'tiebreak') S.tbEnd = now() + CFG.tiebreak_limit_s * 1000;
    if (id === 'trial' || id === 'round') { S.roundEnd = now() + (id === 'trial' ? 150 : 332) * 1000; }
    render();
  }

  function setSub(id) {
    S.sub = id;
    S.demoNote = '';
    S.hunt = null;
    S.lockedUntil = 0;
    if (S.phase === 'round' || S.phase === 'trial') {
      const trial = S.phase === 'trial';
      const ready = (trial ? CFG.trial_hunt_min_press_s : CFG.hunt_min_press_s) * 1000;
      if (id === 'lock') S.lockedUntil = now() + CFG.lock_s * 1000;
      if (id === 'hunt') startHunt(trial ? 'Zeile 2' : 'Zeile 4', 0);
      if (id === 'huntready') startHunt(trial ? 'Zeile 2' : 'Zeile 4 + Spalte 7', ready + 500);
      if (id === 'success' || id === 'failed') { startHunt('Zeile 4', 0); S.hunt.status = id; S.hunt.held = true; }
      S.hunts = S.hunts.slice(0, 2);
      if (id === 'many') {
        const t = now();
        [[1, 'Zeile 4 + Spalte 7'], [2, 'Spalte 9'], [3, 'Zeile 8'], [5, 'Spalte 2']].forEach(([p, label], k) => S.hunts.push({ p, label, start: t - 4000 * k, end: t + 50000 - 4000 * k }));
        startHunt('Zeile 6', 0);
      }
    }
    if (S.phase === 'cashout' && id === 'input') S.cashSent = false;
    if (S.phase === 'cashout' && id === 'reveal') { S.cashSent = true; S.revealStart = now(); }
    if (S.phase === 'distribute') resetSips();
    render();
  }

  const ACTIONS = {
    phase: (a) => setPhase(a),
    sub: (a) => setSub(a),
    view: (a) => { S.view = a; render(); },
    togglebar() { S.barClosed = !S.barClosed; render(); },
    fxdemo: (a) => demoReveal(a),
    color: (a) => { S.joinColor = Number(a); render(); },
    cell(a) {
      const g = game();
      const idx = Number(a);
      if (g.owner[idx] !== undefined || g.givens[idx] || g.entries.has(idx)) return;
      S.sel = idx;
      render();
    },
    digit: (a) => enterDigit(Number(a)),
    press() {
      if (!S.hunt || S.hunt.status !== 'active' || now() < S.hunt.min) return;
      S.hunt.status = 'success';
      PLAYERS[ME].ok++;
      S.ticker.unshift(`Jagd von ${PLAYERS[ME].name} erfolgreich`);
      S.sub = 'success';
      render();
      setTimeout(endHuntScreen, 2000);
    },
    give(a) { if (sipsLeft() > 0) { addSip(ME, Number(a)); render(); } },
    randomsips() {
      while (sipsLeft() > 0) addSip(ME, others[Math.floor(Math.random() * others.length)]);
      render();
    },
    ready() { S.drinkReady = true; render(); },
    cashsend() {
      const raw = ($('cash').value || '').trim().replace(',', '.');
      const val = Number(raw);
      if (raw === '' || !Number.isFinite(val) || val < 0 || val > 10 || !/^\d+(\.\d{1,2})?$/.test(raw)) {
        $('cash-err').textContent = 'Bitte einen Betrag wie 1.37 eingeben, höchstens 10.00.';
        return;
      }
      S.cashInput = val.toFixed(2);
      PLAYERS[ME].cents = Math.round(val * 100);
      S.cashSent = true;
      render();
    },
    cashedit() { S.cashSent = false; render(); },
    closecash() { S.sub = 'reveal'; S.revealStart = now(); render(); },
  };

  function endHuntScreen() {
    if (!S.hunt || S.hunt.held) return;
    S.hunt = null;
    S.sub = 'play';
    render();
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACTIONS[el.dataset.act];
    if (fn) fn(el.dataset.arg);
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'j-name') S.joinName = e.target.value;
    if (e.target.id === 'cash') S.cashInput = e.target.value;
  });

  // ---------- Rendering ----------
  function noteText() {
    if (S.demoNote) return S.demoNote;
    const g = S.phase === 'round' || S.phase === 'trial' ? game() : null;
    if (g && S.sub === 'play' && g.target >= 0 && g.owner[g.target] === undefined && !g.entries.has(g.target)) {
      const r = Math.floor(g.target / g.n) + 1;
      const c = (g.target % g.n) + 1;
      return `Probier es auf dem Handy: <b>Zeile ${r}, Spalte ${c}</b> antippen, dann <b>${g.sol[g.target]}</b> tippen. Das löst die Zeile und startet die Jagd. Drei falsche Ziffern in 30 s lösen die Sperre aus.`;
    }
    const notes = {
      start: 'Links erstellt der Host das Spiel, rechts tritt ein Spieler bei. Belegte Farben sind ausgegraut.',
      lobby: 'Der QR-Code ist echt und führt auf die spätere Beitrittsseite. Die Seite gibt es erst ab M2.',
      ending: 'Erscheint, solange noch Jagden laufen. Danach geht es automatisch weiter.',
      distribute: 'Tippe auf dem Handy auf die Kacheln oder auf Zufall. Die Tabelle auf dem TV zählt mit.',
      drink: 'Die Variante «Weiter erzwingen» zeigt den Knopf, der nach 120 s auf dem TV erscheint.',
      cashout: 'Gib auf dem Handy einen Betrag ein und sende ihn. Danach wird der Knopf auf dem TV aktiv.',
      tiebreak: 'Drei Gruppen spielen parallel dasselbe 6×6-Rätsel.',
      results: 'Rang 6 und 7 zeigen, wie ein Losentscheid gekennzeichnet ist.',
    };
    return notes[S.phase] || 'Die Knöpfe oben schalten jeden Zustand direkt frei.';
  }

  function render() {
    const scrollTop = $('phone').querySelector('.ph-pad')?.scrollTop || 0;
    $('view').innerHTML = [['both', 'Beide'], ['tv', 'TV'], ['phone', 'Handy']].map(([id, l]) => `<button data-act="view" data-arg="${id}" aria-pressed="${S.view === id}" type="button">${l}</button>`).join('');
    $('bar').classList.toggle('closed', !!S.barClosed);
    $('bar-toggle').textContent = S.barClosed ? 'Knöpfe zeigen' : 'Knöpfe ausblenden';
    $('phases').innerHTML = PHASES.map((p) => `<button class="pill" data-act="phase" data-arg="${p.id}" aria-pressed="${S.phase === p.id}" type="button">${p.label}</button>`).join('');
    const subs = PHASES.find((p) => p.id === S.phase).subs;
    $('subs').hidden = !subs.length;
    $('subs').innerHTML = subs.map(([id, l]) => `<button class="pill" data-act="sub" data-arg="${id}" aria-pressed="${S.sub === id}" type="button">${l}</button>`).join('');
    const fxOn = S.phase === 'round' || S.phase === 'trial';
    $('fx').hidden = !fxOn;
    $('fx').innerHTML = !fxOn ? '' : `<span class="pills-label">Gegner</span>${[['one', 'löst eine Linie'], ['cross', 'löst Zeile + Spalte'], ['steal', 'schnappt dir die Zeile weg'], ['neutral', 'Neutral (niemand)']].map(([id, l]) => `<button class="pill" data-act="fxdemo" data-arg="${id}" type="button">${l}</button>`).join('')}`;
    $('note').innerHTML = noteText();
    $('stage').dataset.view = S.view;
    $('tv').innerHTML = TV[S.phase]();
    $('phone').innerHTML = PHONE[S.phase]();
    const pad = $('phone').querySelector('.ph-pad');
    if (pad) pad.scrollTop = scrollTop;
    fitTv();
    tick();
  }

  function fitTv() {
    const wrap = $('tv-wrap');
    const barH = $('bar').offsetHeight;
    document.documentElement.style.setProperty('--bar-h', `${barH}px`);
    const w = wrap.parentElement.clientWidth;
    if (!w) return;
    // Fit the whole TV into the window on desktop; on phones width alone decides.
    const free = window.innerWidth > 900 ? window.innerHeight - barH - 96 : Infinity;
    const scale = Math.min(w / 1920, Math.max(280, free) / 1080);
    $('tv').style.transform = `scale(${scale})`;
    wrap.style.width = `${1920 * scale}px`;
    wrap.style.height = `${1080 * scale}px`;
  }

  function tick() {
    const t = now();
    document.querySelectorAll('[data-cd]').forEach((el) => {
      el.textContent = fmtTime(Number(el.dataset.cd) - t, el.dataset.fmt);
    });
    document.querySelectorAll('[data-bar-start]').forEach((el) => {
      const a = Number(el.dataset.barStart);
      const b = Number(el.dataset.barEnd);
      el.style.width = `${Math.max(0, Math.min(100, (100 * (b - t)) / (b - a)))}%`;
    });
    const btn = $('hunt-btn');
    if (btn) {
      const ready = t >= Number(btn.dataset.min);
      btn.disabled = !ready;
      btn.classList.toggle('ready', ready);
      const fill = btn.querySelector('.fill');
      fill.style.width = ready ? '0' : `${(100 * (t - Number(btn.dataset.start))) / Number(btn.dataset.span)}%`;
    }
    document.querySelectorAll('[data-count]').forEach((el) => {
      const target = Number(el.dataset.count);
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const p = reduce ? 1 : Math.min(1, (t - S.revealStart) / 2500);
      el.textContent = money(Math.round(target * p));
    });
    // Keep other players' hunts alive so the TV never looks empty in the mock.
    let dirty = false;
    S.hunts.forEach((h) => { if (h.end <= t) { h.start = t; h.end = t + CFG.hunt_duration_s * 1000; dirty = true; } });
    if (S.hunt && S.hunt.status === 'active' && S.hunt.end <= t) {
      S.hunt.status = 'failed';
      S.sub = 'failed';
      S.ticker.unshift(`Jagd von ${PLAYERS[ME].name}: Zeit abgelaufen`);
      setTimeout(endHuntScreen, 2000);
      dirty = true;
    }
    if (S.lockedUntil && S.lockedUntil <= t) { S.lockedUntil = 0; if (S.sub === 'lock') S.sub = 'play'; dirty = true; }
    if (S.errCount && t - S.errStart > CFG.error_window_s * 1000) { S.errCount = 0; dirty = true; }
    if (dirty) render();
  }

  // ---------- Boot ----------
  function boot() {
    const t = now();
    S.roundEnd = t + 332 * 1000;
    S.gameEnd = t + 761 * 1000;
    S.distributeEnd = t + CFG.distribute_timeout_s * 1000;
    S.tbEnd = t + CFG.tiebreak_limit_s * 1000;
    S.hunts = [
      { p: 0, label: 'Zeile 2', start: t - 12000, end: t + 38000 },
      { p: 4, label: 'Spalte 4', start: t - 37000, end: t + 13000 },
    ];
    S.ticker = ['Elin löst Spalte 4', 'Anna löst Zeile 2', 'Jagd von Ben erfolgreich', 'Cara ist 20 s gesperrt', 'Dario löst Spalte 1'];
    resetSips();
    render();
    setInterval(tick, 250);
    window.addEventListener('resize', fitTv);
    if (window.ResizeObserver) new ResizeObserver(fitTv).observe($('tv-wrap'));
  }
  boot();
})();
