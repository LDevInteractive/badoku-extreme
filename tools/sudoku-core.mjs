// Badoku-Extreme - Sudoku core (Node, no dependencies).
// Supports N = 4 (2x2 boxes), 6 (2 rows x 3 cols boxes) and 9 (3x3 boxes).
// Grids are Uint8Array of length N*N, 0 = empty, cell index = row * N + col.
// Text form: string of length N*N with digits, '0' = empty (CLAUDE.md section 6).

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Box dimensions for a grid size. */
export function boxDims(n) {
  switch (n) {
    case 4:
      return { rows: 2, cols: 2 };
    case 6:
      return { rows: 2, cols: 3 };
    case 9:
      return { rows: 3, cols: 3 };
    default:
      throw new Error(`unsupported grid size ${n}`);
  }
}

const geometryCache = new Map();

/**
 * Precomputed units and peers for a size.
 * units: array of 3N arrays of cell indices (rows, cols, boxes)
 * peers: per cell, array of the other cells sharing a unit
 * boxOf: per cell, box index
 */
export function geometry(n) {
  if (geometryCache.has(n)) return geometryCache.get(n);
  const { rows: br, cols: bc } = boxDims(n);
  const cells = n * n;
  const rows = [];
  const cols = [];
  const boxes = [];
  const boxOf = new Array(cells);
  for (let r = 0; r < n; r++) {
    rows.push([]);
    cols.push([]);
    boxes.push([]);
  }
  for (let idx = 0; idx < cells; idx++) {
    const r = Math.floor(idx / n);
    const c = idx % n;
    const b = Math.floor(r / br) * (n / bc) + Math.floor(c / bc);
    rows[r].push(idx);
    cols[c].push(idx);
    boxes[b].push(idx);
    boxOf[idx] = b;
  }
  const units = [...rows, ...cols, ...boxes];
  const peers = new Array(cells);
  for (let idx = 0; idx < cells; idx++) {
    const set = new Set();
    const r = Math.floor(idx / n);
    const c = idx % n;
    for (const p of rows[r]) set.add(p);
    for (const p of cols[c]) set.add(p);
    for (const p of boxes[boxOf[idx]]) set.add(p);
    set.delete(idx);
    peers[idx] = [...set];
  }
  const geo = { n, cells, rows, cols, boxes, units, peers, boxOf };
  geometryCache.set(n, geo);
  return geo;
}

// ---------------------------------------------------------------------------
// Random
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). Returns a function giving [0, 1). */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place Fisher-Yates shuffle. */
export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Text form
// ---------------------------------------------------------------------------

export function parseGrid(text) {
  const grid = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const d = text.charCodeAt(i) - 48;
    if (d < 0 || d > 9) throw new Error(`invalid grid character at ${i}`);
    grid[i] = d;
  }
  return grid;
}

export function gridToString(grid) {
  let s = '';
  for (let i = 0; i < grid.length; i++) s += grid[i];
  return s;
}

export function sizeOf(grid) {
  const n = Math.round(Math.sqrt(grid.length));
  if (n * n !== grid.length) throw new Error('grid length is not a square');
  return n;
}

export function countGivens(grid) {
  let k = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] !== 0) k++;
  return k;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

const popcountCache = new Map();

function popcount(mask) {
  let c = popcountCache.get(mask);
  if (c !== undefined) return c;
  let m = mask;
  c = 0;
  while (m) {
    m &= m - 1;
    c++;
  }
  popcountCache.set(mask, c);
  return c;
}

function singleDigit(mask) {
  // mask has exactly one bit set; return its digit (bit d-1 => digit d)
  return 31 - Math.clz32(mask) + 1;
}

/** Bitmask of digits allowed at idx given the current grid (bit d-1 = digit d). */
export function candidateMask(grid, geo, idx) {
  let used = 0;
  for (const p of geo.peers[idx]) {
    const v = grid[p];
    if (v) used |= 1 << (v - 1);
  }
  const all = (1 << geo.n) - 1;
  return all & ~used;
}

// ---------------------------------------------------------------------------
// Solvers
// ---------------------------------------------------------------------------

/**
 * Counts solutions by backtracking (MRV), stopping at `limit`.
 * Does not modify the input grid.
 */
export function countSolutions(input, n = sizeOf(input), limit = 2) {
  const geo = geometry(n);
  const grid = Uint8Array.from(input);
  let count = 0;

  function search() {
    // pick the empty cell with the fewest candidates
    let best = -1;
    let bestMask = 0;
    let bestCount = n + 1;
    for (let idx = 0; idx < geo.cells; idx++) {
      if (grid[idx]) continue;
      const mask = candidateMask(grid, geo, idx);
      const pc = popcount(mask);
      if (pc === 0) return;
      if (pc < bestCount) {
        best = idx;
        bestMask = mask;
        bestCount = pc;
        if (pc === 1) break;
      }
    }
    if (best === -1) {
      count++;
      return;
    }
    for (let d = 1; d <= n; d++) {
      if (!(bestMask & (1 << (d - 1)))) continue;
      grid[best] = d;
      search();
      if (count >= limit) {
        grid[best] = 0;
        return;
      }
    }
    grid[best] = 0;
  }

  search();
  return count;
}

/**
 * Solves using only Naked Singles and Hidden Singles (rows, cols, boxes).
 * One deduction per pass, so no two deductions can ever conflict.
 * Returns { solved, grid } with the (partially) solved copy.
 */
export function solveWithSingles(input, n = sizeOf(input)) {
  const geo = geometry(n);
  const grid = Uint8Array.from(input);
  const masks = new Int32Array(geo.cells);

  for (;;) {
    // candidate masks for all empty cells
    let empties = 0;
    let placedIdx = -1;
    let placedDigit = 0;
    for (let idx = 0; idx < geo.cells; idx++) {
      if (grid[idx]) {
        masks[idx] = 0;
        continue;
      }
      empties++;
      const m = candidateMask(grid, geo, idx);
      if (m === 0) return { solved: false, grid };
      masks[idx] = m;
      if (placedIdx === -1 && popcount(m) === 1) {
        placedIdx = idx;
        placedDigit = singleDigit(m);
      }
    }
    if (empties === 0) return { solved: true, grid };

    if (placedIdx === -1) {
      // hidden single: a digit with exactly one possible cell in a unit
      outer: for (const unit of geo.units) {
        let present = 0;
        for (const idx of unit) if (grid[idx]) present |= 1 << (grid[idx] - 1);
        for (let d = 1; d <= n; d++) {
          const bit = 1 << (d - 1);
          if (present & bit) continue;
          let where = -1;
          let hits = 0;
          for (const idx of unit) {
            if (!grid[idx] && masks[idx] & bit) {
              hits++;
              where = idx;
              if (hits > 1) break;
            }
          }
          if (hits === 0) return { solved: false, grid };
          if (hits === 1) {
            placedIdx = where;
            placedDigit = d;
            break outer;
          }
        }
      }
    }

    if (placedIdx === -1) return { solved: false, grid }; // stuck: needs more than singles
    grid[placedIdx] = placedDigit;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** True when every cell is filled and every unit holds 1..N exactly once. */
export function isValidSolution(grid, n = sizeOf(grid)) {
  const geo = geometry(n);
  const all = (1 << n) - 1;
  for (const unit of geo.units) {
    let seen = 0;
    for (const idx of unit) {
      const v = grid[idx];
      if (v < 1 || v > n) return false;
      const bit = 1 << (v - 1);
      if (seen & bit) return false;
      seen |= bit;
    }
    if (seen !== all) return false;
  }
  return true;
}

/** True when every given of `puzzle` matches `solution`. */
export function isConsistent(puzzle, solution) {
  if (puzzle.length !== solution.length) return false;
  for (let i = 0; i < puzzle.length; i++) {
    if (puzzle[i] && puzzle[i] !== solution[i]) return false;
  }
  return true;
}

/** Smallest number of empty cells over all rows and columns. */
export function minEmptyPerLine(grid, n = sizeOf(grid)) {
  const geo = geometry(n);
  let min = Infinity;
  for (const line of [...geo.rows, ...geo.cols]) {
    let empty = 0;
    for (const idx of line) if (!grid[idx]) empty++;
    if (empty < min) min = empty;
  }
  return min;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Random complete, valid grid via randomized backtracking. */
export function generateSolution(n, rng) {
  const geo = geometry(n);
  const grid = new Uint8Array(geo.cells);
  const digits = [];
  for (let d = 1; d <= n; d++) digits.push(d);

  function fill(idx) {
    if (idx === geo.cells) return true;
    const mask = candidateMask(grid, geo, idx);
    if (mask === 0) return false;
    const order = shuffle(digits.slice(), rng);
    for (const d of order) {
      if (!(mask & (1 << (d - 1)))) continue;
      grid[idx] = d;
      if (fill(idx + 1)) return true;
    }
    grid[idx] = 0;
    return false;
  }

  if (!fill(0)) throw new Error('could not generate a solution');
  return grid;
}

/**
 * Builds a puzzle from a fresh random solution by removing cells in random
 * order. A removal is kept only if the puzzle stays solvable with singles
 * only (which implies a unique solution; uniqueness is verified anyway).
 * Stops when `targetGivens` is reached.
 * Returns { puzzle, solution } or null when the target could not be reached
 * or a row/column ended up with fewer than `minEmpty` empty cells.
 */
export function makePuzzle(n, targetGivens, rng, { minEmpty = 2 } = {}) {
  const geo = geometry(n);
  const solution = generateSolution(n, rng);
  const puzzle = Uint8Array.from(solution);
  const order = shuffle([...Array(geo.cells).keys()], rng);
  let givens = geo.cells;

  for (const idx of order) {
    if (givens <= targetGivens) break;
    const saved = puzzle[idx];
    puzzle[idx] = 0;
    const ok = solveWithSingles(puzzle, n).solved && countSolutions(puzzle, n, 2) === 1;
    if (ok) givens--;
    else puzzle[idx] = saved;
  }

  if (givens !== targetGivens) return null;
  if (minEmptyPerLine(puzzle, n) < minEmpty) return null;
  return { puzzle, solution };
}

/**
 * Like makePuzzle but retries with new solutions until it succeeds.
 * `targetGivens` may be a number or [min, max] (inclusive), picked per attempt.
 */
export function makePuzzleRetry(n, targetGivens, rng, { maxAttempts = 200, minEmpty = 2 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const target = Array.isArray(targetGivens)
      ? targetGivens[0] + Math.floor(rng() * (targetGivens[1] - targetGivens[0] + 1))
      : targetGivens;
    const result = makePuzzle(n, target, rng, { minEmpty });
    if (result) return { ...result, attempts: attempt };
  }
  throw new Error(`no ${n}x${n} puzzle with ${targetGivens} givens after ${maxAttempts} attempts`);
}

/** Full check of a puzzle/solution pair against the pool rules (CLAUDE.md section 7). */
export function checkPuzzle(puzzle, solution, n = sizeOf(puzzle), { minEmpty = 2 } = {}) {
  const problems = [];
  if (!isValidSolution(solution, n)) problems.push('solution invalid');
  if (!isConsistent(puzzle, solution)) problems.push('givens differ from solution');
  if (countSolutions(puzzle, n, 2) !== 1) problems.push('not exactly one solution');
  const singles = solveWithSingles(puzzle, n);
  if (!singles.solved) problems.push('not solvable with singles only');
  else if (gridToString(singles.grid) !== gridToString(solution)) problems.push('singles solution differs');
  if (minEmptyPerLine(puzzle, n) < minEmpty) problems.push(`a row or column has fewer than ${minEmpty} empty cells`);
  return problems;
}
