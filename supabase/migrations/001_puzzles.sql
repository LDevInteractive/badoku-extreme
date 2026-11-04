-- Badoku-Extreme - Migration 001: puzzle pool
-- Run after 000_server_time.sql. Then load supabase/seed/puzzles.sql
-- (generated locally by tools/generate-puzzles.mjs).
--
-- puzzles:          givens only, read by the server when a round starts.
-- puzzle_solutions: solutions, never readable by clients (CLAUDE.md 5.1 / 6.1).

create table public.puzzles (
  id          uuid primary key default gen_random_uuid(),
  size        int  not null check (size in (4, 6, 9)),
  difficulty  text not null check (difficulty in ('leicht', 'mittel')),
  givens      text not null unique,
  created_at  timestamptz not null default now(),
  constraint puzzles_givens_length check (length(givens) = size * size),
  constraint puzzles_givens_digits check (givens ~ '^[0-9]+$')
);

create table public.puzzle_solutions (
  puzzle_id   uuid primary key references public.puzzles (id) on delete cascade,
  solution    text not null,
  constraint puzzle_solutions_digits check (solution ~ '^[1-9]+$')
);

create index puzzles_size_difficulty_idx on public.puzzles (size, difficulty);

-- No client access at all: RLS on, no policies, privileges revoked.
alter table public.puzzles enable row level security;
alter table public.puzzle_solutions enable row level security;
revoke all on table public.puzzles from anon, authenticated;
revoke all on table public.puzzle_solutions from anon, authenticated;
