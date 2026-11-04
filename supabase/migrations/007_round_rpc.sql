-- Badoku-Extreme - Migration 007: Sudoku rounds (CLAUDE.md sections 2.4-2.6, 5.4, 8.2)
-- Run after 006_realtime.sql. Hunts follow with the next migration, so a claimed line
-- locks and reveals here without starting one yet.

-- Cell numbers of one row or column.
create or replace function public.line_cells(p_size int, p_type text, p_idx int)
returns int[]
language sql
immutable
set search_path = public, extensions
as $$
  select array_agg(case when p_type = 'row' then p_idx * p_size + k else k * p_size + p_idx end order by k)
  from generate_series(0, p_size - 1) k;
$$;

create or replace function public.line_label(p_type text, p_idx int)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select case when p_type = 'row' then 'Zeile ' else 'Spalte ' end || (p_idx + 1);
$$;

-- Digits of the given cells, read from a grid string.
create or replace function public.cells_digits(p_grid text, p_cells int[])
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select string_agg(substr(p_grid, c + 1, 1), '' order by o)
  from unnest(p_cells) with ordinality as u(c, o);
$$;

-- Creates a round with a random unused puzzle. Returns null when the pool has none left.
create or replace function public.start_round(p_game public.games, p_kind text, p_size int)
returns uuid
language plpgsql
set search_path = public, extensions
as $$
declare
  v_puzzle public.puzzles;
  v_round uuid;
  v_deadline timestamptz := now() + make_interval(secs => (p_game.config ->> 'round_limit_s')::int);
  v_round_no int := p_game.round_no + case when p_kind = 'main' then 1 else 0 end;
begin
  select * into v_puzzle
  from public.puzzles z
  where z.size = p_size
    and z.difficulty = case when p_size = 9 then p_game.config ->> 'difficulty' else z.difficulty end
    and not exists (select 1 from public.rounds r where r.game_id = p_game.id and r.puzzle_id = z.id)
  order by random()
  limit 1;
  if not found then
    return null;
  end if;

  insert into public.rounds (game_id, kind, round_no, puzzle_id, size, givens, revealed, deadline)
  values (p_game.id, p_kind, v_round_no, v_puzzle.id, v_puzzle.size, v_puzzle.givens, v_puzzle.givens, v_deadline)
  returning id into v_round;

  update public.games
  set phase = case when p_kind = 'trial' then 'trial_running' else 'round_running' end,
      round_no = v_round_no,
      current_round_id = v_round,
      main_started_at = case when p_kind = 'main' then coalesce(main_started_at, now()) else main_started_at end,
      phase_started_at = now(),
      phase_deadline = v_deadline
  where id = p_game.id;

  return v_round;
end;
$$;

-- Locks every open line that is fully visible as neutral (CLAUDE.md 2.6).
-- p_announce = false when the caller reports them as one event (round limit).
create or replace function public.lock_neutral_lines(p_game_id uuid, p_round_id uuid, p_announce boolean default true)
returns void
language plpgsql
set search_path = public, extensions
as $$
declare
  r public.rounds;
  v_type text;
  v_idx int;
  v_cells int[];
  v_digits text;
begin
  select * into r from public.rounds where id = p_round_id;
  foreach v_type in array array['row', 'col'] loop
    for v_idx in 0 .. r.size - 1 loop
      continue when exists (
        select 1 from public.lines l
        where l.round_id = r.id and l.line_type = v_type and l.idx = v_idx);
      v_cells := public.line_cells(r.size, v_type, v_idx);
      v_digits := public.cells_digits(r.revealed, v_cells);
      continue when position('0' in v_digits) > 0;
      insert into public.lines (round_id, game_id, line_type, idx, status, digits)
      values (r.id, p_game_id, v_type, v_idx, 'neutral', v_digits);
      if p_announce then
        perform public.add_event(p_game_id, 'line_neutral', jsonb_build_object('label', public.line_label(v_type, v_idx)));
      end if;
    end loop;
  end loop;
end;
$$;

create or replace function public.end_round(p_game_id uuid, p_round_id uuid)
returns void
language sql
set search_path = public, extensions
as $$
  update public.rounds set ended_at = now() where id = p_round_id;
  update public.games
  set phase = case when phase = 'trial_running' then 'trial_ending' else 'round_ending' end,
      phase_started_at = now(),
      phase_deadline = null
  where id = p_game_id;
$$;

-- All time-driven transitions (CLAUDE.md 5.4). The caller holds the games row lock.
-- Returns true when something changed.
create or replace function public.apply_time(p_game_id uuid)
returns boolean
language plpgsql
set search_path = public, extensions
as $$
declare
  g public.games;
  r public.rounds;
begin
  select * into g from public.games where id = p_game_id;
  if g.phase in ('round_running', 'trial_running') then
    select * into r from public.rounds where id = g.current_round_id;
    if now() >= r.deadline then
      -- Round limit: everything still open is revealed neutrally.
      update public.rounds
      set revealed = (select s.solution from public.puzzle_solutions s where s.puzzle_id = r.puzzle_id)
      where id = r.id;
      perform public.lock_neutral_lines(g.id, r.id, false);
      perform public.add_event(g.id, 'round_limit');
      perform public.end_round(g.id, r.id);
      return true;
    end if;
  end if;
  return false;
end;
$$;

create or replace function public.tick(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  g public.games;
  v_changed boolean;
begin
  select * into g from public.games where id = public.game_id_by_code(p_code) for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  v_changed := public.apply_time(g.id);
  if v_changed then
    perform public.bump_version(g.id);
  end if;
  return jsonb_build_object('ok', true, 'changed', v_changed);
end;
$$;

create or replace function public.host_start_main(p_code text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  g public.games;
begin
  select * into g from public.games where id = public.game_id_by_code(p_code) for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if not public.pin_is_valid(g.id, p_pin) then
    return jsonb_build_object('ok', false, 'reason', 'bad_pin');
  end if;
  if g.phase <> 'lobby' then
    return jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  end if;
  if (select count(*) from public.players where game_id = g.id) < 2 then
    return jsonb_build_object('ok', false, 'reason', 'too_few_players');
  end if;
  if public.start_round(g, 'main', 9) is null then
    return jsonb_build_object('ok', false, 'reason', 'no_puzzle');
  end if;
  perform public.bump_version(g.id);
  return jsonb_build_object('ok', true);
end;
$$;

-- Exactly the sequence of CLAUDE.md 8.2. Hunts (step 9) and the tiebreak (steps 2, 7)
-- are added by their own milestones.
create or replace function public.enter_digit(p_code text, p_token text, p_cell int, p_digit int)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  g public.games;
  r public.rounds;
  p public.players;
  v_player uuid;
  cfg jsonb;
  v_solution text;
  v_row int;
  v_col int;
  v_count int;
  v_locked timestamptz;
  v_type text;
  v_idx int;
  v_cells int[];
  v_claim text[] := '{}';
  v_labels text[] := '{}';
  v_claimed jsonb := '[]'::jsonb;
  v_digits text;
  v_c int;
begin
  -- 1. Serialise, identify, clear what has expired.
  select * into g from public.games where id = public.game_id_by_code(p_code) for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  v_player := public.player_by_token(g.id, p_token);
  if v_player is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_token');
  end if;
  if public.apply_time(g.id) then
    perform public.bump_version(g.id);
    select * into g from public.games where id = g.id;
  end if;
  update public.players set locked_until = null
  where id = v_player and locked_until is not null and locked_until <= now();

  -- 2. Phase.
  if g.phase not in ('round_running', 'trial_running') then
    return jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  end if;

  select * into p from public.players where id = v_player;
  select * into r from public.rounds where id = g.current_round_id;
  cfg := g.config;
  if p_cell is null or p_digit is null
    or p_cell not between 0 and r.size * r.size - 1
    or p_digit not between 1 and r.size then
    return jsonb_build_object('ok', false, 'reason', 'bad_input');
  end if;

  -- 3. Locked.
  if p.locked_until is not null then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'locked_until', p.locked_until);
  end if;

  -- 4. Hunting.
  if p.active_hunt_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'hunting');
  end if;

  -- 5. Already filled.
  if substr(r.revealed, p_cell + 1, 1) <> '0'
    or exists (select 1 from public.entries e where e.round_id = r.id and e.player_id = v_player and e.cell = p_cell) then
    return jsonb_build_object('ok', false, 'reason', 'filled');
  end if;

  select s.solution into v_solution from public.puzzle_solutions s where s.puzzle_id = r.puzzle_id;

  -- 6. Wrong.
  if substr(v_solution, p_cell + 1, 1)::int <> p_digit then
    if p.err_window_started_at is null
      or now() - p.err_window_started_at > make_interval(secs => (cfg ->> 'error_window_s')::int) then
      p.err_window_started_at := now();
      v_count := 1;
    else
      v_count := p.err_window_count + 1;
    end if;
    v_locked := null;
    if v_count >= (cfg ->> 'error_max')::int then
      v_locked := now() + make_interval(secs => (cfg ->> 'lock_s')::int);
      v_count := 0;
      p.err_window_started_at := null;
      perform public.add_event(g.id, 'player_locked', jsonb_build_object(
        'player_id', v_player, 'name', p.name, 'seconds', (cfg ->> 'lock_s')::int));
    end if;
    update public.players
    set err_window_started_at = p.err_window_started_at,
        err_window_count = v_count,
        locked_until = v_locked,
        errors_total = errors_total + case when r.kind = 'main' then 1 else 0 end,
        locks_total = locks_total + case when r.kind = 'main' and v_locked is not null then 1 else 0 end
    where id = v_player;
    perform public.bump_version(g.id);
    return jsonb_build_object('ok', true, 'result', 'wrong', 'error_count', v_count, 'locked_until', v_locked);
  end if;

  -- 7. Right.
  insert into public.entries (round_id, player_id, cell, digit) values (r.id, v_player, p_cell, p_digit);

  -- 8. Which of the two lines of this cell did this entry complete?
  v_row := p_cell / r.size;
  v_col := p_cell % r.size;
  foreach v_type in array array['row', 'col'] loop
    v_idx := case when v_type = 'row' then v_row else v_col end;
    continue when exists (
      select 1 from public.lines l
      where l.round_id = r.id and l.line_type = v_type and l.idx = v_idx);
    continue when exists (
      select 1 from unnest(public.line_cells(r.size, v_type, v_idx)) c
      where substr(r.revealed, c + 1, 1) = '0'
        and not exists (select 1 from public.entries e where e.round_id = r.id and e.player_id = v_player and e.cell = c));
    v_claim := v_claim || v_type;
  end loop;

  -- 9. Claim and reveal.
  if cardinality(v_claim) > 0 then
    foreach v_type in array v_claim loop
      v_idx := case when v_type = 'row' then v_row else v_col end;
      v_cells := public.line_cells(r.size, v_type, v_idx);
      v_digits := public.cells_digits(v_solution, v_cells);
      insert into public.lines (round_id, game_id, line_type, idx, status, player_id, origin_cell, digits)
      values (r.id, g.id, v_type, v_idx, 'claimed', v_player, p_cell, v_digits);
      foreach v_c in array v_cells loop
        r.revealed := overlay(r.revealed placing substr(v_solution, v_c + 1, 1) from v_c + 1 for 1);
      end loop;
      v_labels := v_labels || public.line_label(v_type, v_idx);
      v_claimed := v_claimed || jsonb_build_object('line_type', v_type, 'idx', v_idx);
    end loop;
    update public.rounds set revealed = r.revealed where id = r.id;
    perform public.add_event(g.id, 'line_claimed', jsonb_build_object(
      'player_id', v_player, 'name', p.name, 'label', array_to_string(v_labels, ' + ')));
    if r.kind = 'main' then
      update public.players
      set lines_claimed = lines_claimed + cardinality(v_claim),
          sips_to_distribute = sips_to_distribute + cardinality(v_claim) * (cfg ->> 'sips_per_line')::int
      where id = v_player;
    end if;
  end if;

  -- 10. Neutral check.
  perform public.lock_neutral_lines(g.id, r.id);

  -- 11. All lines locked.
  if (select count(*) from public.lines l where l.round_id = r.id) >= 2 * r.size then
    perform public.end_round(g.id, r.id);
  end if;

  -- 12. Done.
  perform public.bump_version(g.id);
  return jsonb_build_object('ok', true, 'result', 'correct', 'claimed', v_claimed, 'hunt', null);
end;
$$;

revoke all on function public.line_cells(int, text, int) from public, anon, authenticated;
revoke all on function public.line_label(text, int) from public, anon, authenticated;
revoke all on function public.cells_digits(text, int[]) from public, anon, authenticated;
revoke all on function public.start_round(public.games, text, int) from public, anon, authenticated;
revoke all on function public.lock_neutral_lines(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.end_round(uuid, uuid) from public, anon, authenticated;
revoke all on function public.apply_time(uuid) from public, anon, authenticated;

revoke all on function public.host_start_main(text, text) from public;
revoke all on function public.enter_digit(text, text, int, int) from public;
grant execute on function public.host_start_main(text, text) to anon, authenticated;
grant execute on function public.enter_digit(text, text, int, int) to anon, authenticated;
