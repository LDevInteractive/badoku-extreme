// Run with: node --test tools/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  geometry,
  makeRng,
  parseGrid,
  gridToString,
  countGivens,
  countSolutions,
  solveWithSingles,
  isValidSolution,
  isConsistent,
  minEmptyPerLine,
  generateSolution,
  makePuzzleRetry,
  checkPuzzle,
} from './sudoku-core.mjs';

const SIZES = [4, 6, 9];

test('geometry: every cell belongs to exactly one row, column and box', () => {
  for (const n of SIZES) {
    const geo = geometry(n);
    assert.equal(geo.units.length, 3 * n);
    for (const unit of geo.units) assert.equal(unit.length, n);
    const seen = new Array(n * n).fill(0);
    for (const box of geo.boxes) for (const idx of box) seen[idx]++;
    assert.ok(seen.every((k) => k === 1), `boxes cover each cell once for n=${n}`);
    const peerCount = n === 9 ? 20 : n === 6 ? 2 * (n - 1) + 2 : 7;
    assert.equal(geo.peers[0].length, peerCount, `peer count for n=${n}`);
  }
});

test('generateSolution produces valid grids for all sizes', () => {
  const rng = makeRng(1);
  for (const n of SIZES) {
    for (let i = 0; i < 5; i++) {
      const g = generateSolution(n, rng);
      assert.ok(isValidSolution(g, n), `valid ${n}x${n} solution`);
    }
  }
});

test('countSolutions: full grid has 1, empty 4x4 has >= 2, contradiction has 0', () => {
  const rng = makeRng(2);
  const full = generateSolution(9, rng);
  assert.equal(countSolutions(full, 9, 2), 1);
  assert.equal(countSolutions(new Uint8Array(16), 4, 2), 2);
  const bad = parseGrid('1100000000000000');
  assert.equal(countSolutions(bad, 4, 2), 0);
});

test('solveWithSingles solves a known easy 9x9 and refuses a hard one', () => {
  // Classic easy puzzle (singles only)
  const easy = parseGrid(
    '530070000600195000098000060800060003400803001700020006060000280000419005000080079'
  );
  const r = solveWithSingles(easy, 9);
  assert.ok(r.solved);
  assert.ok(isValidSolution(r.grid, 9));
  assert.ok(isConsistent(easy, r.grid));
  // Arto Inkala's "hardest sudoku": unique but far beyond singles
  const hard = parseGrid(
    '800000000003600000070090200050007000000045700000100030001000068008500010090000400'
  );
  assert.equal(countSolutions(hard, 9, 2), 1);
  assert.equal(solveWithSingles(hard, 9).solved, false);
});

test('generated puzzles satisfy all pool rules', () => {
  const rng = makeRng(2026);
  const plan = [
    [4, [6, 7], 6],
    [6, [14, 16], 6],
    [9, [38, 42], 6],
    [9, [32, 36], 6],
  ];
  for (const [n, range, count] of plan) {
    for (let i = 0; i < count; i++) {
      const { puzzle, solution } = makePuzzleRetry(n, range, rng);
      const givens = countGivens(puzzle);
      assert.ok(givens >= range[0] && givens <= range[1], `${n}x${n} givens ${givens} in ${range}`);
      assert.equal(countSolutions(puzzle, n, 2), 1, 'exactly one solution');
      const s = solveWithSingles(puzzle, n);
      assert.ok(s.solved, 'solvable with singles');
      assert.equal(gridToString(s.grid), gridToString(solution), 'singles reach the solution');
      assert.ok(isValidSolution(solution, n), 'solution valid');
      assert.ok(isConsistent(puzzle, solution), 'givens match solution');
      assert.ok(minEmptyPerLine(puzzle, n) >= 2, 'every row and column has >= 2 empty cells');
      assert.deepEqual(checkPuzzle(puzzle, solution, n), []);
    }
  }
});

test('checkPuzzle reports violations', () => {
  const rng = makeRng(7);
  const { puzzle, solution } = makePuzzleRetry(4, [6, 7], rng);
  const wrongSolution = Uint8Array.from(solution);
  wrongSolution[0] = wrongSolution[0] === 1 ? 2 : 1;
  const problems = checkPuzzle(puzzle, wrongSolution, 4);
  assert.ok(problems.includes('solution invalid'));
  const fullLine = Uint8Array.from(puzzle);
  for (let c = 0; c < 4; c++) fullLine[c] = solution[c]; // fill row 0 completely
  assert.ok(checkPuzzle(fullLine, solution, 4).some((p) => p.includes('empty cells')));
});

test('text round trip', () => {
  const s = '0123401234012340';
  assert.equal(gridToString(parseGrid(s)), s);
});
