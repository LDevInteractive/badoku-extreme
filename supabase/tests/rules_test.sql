-- Badoku-Extreme: rule scenarios (CLAUDE.md section 10.2).
--
-- Run the whole file in the Supabase SQL editor after all migrations and the puzzle seed.
-- Every test game is created through the public RPCs and deleted again at the end. All checks run
-- inside one DO block: the first failing check raises «FAIL: ...», and then nothing the test did
-- stays in the database. On success the last statement shows how many checks passed.
--
-- now() stands still inside one statement, so the tests let time pass with pg_temp.t_age(): it
-- moves every timestamp of a test game into the past, as if that many seconds had gone by.
-- Do not run it during a real game: the test games cause Realtime traffic on the games table.

create temp table if not exists t_games (id uuid primary key);
truncate t_games;
select set_config('badoku_test.passed', '0', false);

-- One check. Counts passes, stops everything at the first failure.
create or replace function pg_temp.t_ok(p_cond boolean, p_label text, p_extra text default null)
returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'FAIL: %', p_label || coalesce(' (' || p_extra || ')', '');
  end if;
  perform set_config('badoku_test.passed', (current_setting('badoku_test.passed')::int + 1)::text, false);
end $$;

-- A new game with PIN 1234 and n players A, B, C, ... in the fixed colours.
create or replace function pg_temp.t_game(p_cfg jsonb, p_n int,
  out code text, out gid uuid, out t text[], out pid uuid[])
language plpgsql as $$
declare
  v jsonb;
  j jsonb;
  names text[] := array['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  colors text[] := array['#E5484D', '#F76B15', '#FFC53D', '#30A46C', '#12A594', '#3E63DD', '#8E4EC6', '#D6409F'];
begin
  v := public.create_game('1234', p_cfg);
  if (v ->> 'ok')::boolean is not true then
    raise exception 'create_game failed: %', v;
  end if;
  code := v ->> 'code';
  gid := (v ->> 'game_id')::uuid;
  insert into t_games values (gid);
  t := '{}';
  pid := '{}';
  for i in 1 .. p_n loop
    j := public.join_game(code, names[i], colors[i]);
    if (j ->> 'ok')::boolean is not true then
      raise exception 'join_game failed: %', j;
    end if;
    t := t || (j ->> 'token');
    pid := pid || (j ->> 'player_id')::uuid;
  end loop;
end $$;

-- Solution of the current round.
create or replace function pg_temp.t_sol(p_game uuid) returns text language sql as $$
  select s.solution
  from public.games g
  join public.rounds r on r.id = g.current_round_id
  join public.puzzle_solutions s on s.puzzle_id = r.puzzle_id
  where g.id = p_game
$$;

-- Prepared grid: everything given except the listed cells.
create or replace function pg_temp.t_open(p_game uuid, p_cells int[]) returns void language plpgsql as $$
declare
  v_sol text := pg_temp.t_sol(p_game);
  v_grid text;
begin
  select string_agg(case when i = any (p_cells) then '0' else substr(v_sol, i + 1, 1) end, '' order by i)
  into v_grid
  from generate_series(0, length(v_sol) - 1) i;
  update public.rounds set givens = v_grid, revealed = v_grid
  where id = (select current_round_id from public.games where id = p_game);
end $$;

-- The correct digit into a cell.
create or replace function pg_temp.t_in(p_code text, p_token text, p_cell int) returns jsonb language sql as $$
  select public.enter_digit(p_code, p_token, p_cell,
    substr(pg_temp.t_sol(public.game_id_by_code(p_code)), p_cell + 1, 1)::int)
$$;

-- A wrong digit into a cell.
create or replace function pg_temp.t_bad(p_code text, p_token text, p_cell int) returns jsonb language sql as $$
  select public.enter_digit(p_code, p_token, p_cell,
    substr(pg_temp.t_sol(public.game_id_by_code(p_code)), p_cell + 1, 1)::int
      % (select r.size from public.games g join public.rounds r on r.id = g.current_round_id
         where g.id = public.game_id_by_code(p_code)) + 1)
$$;

-- Both cells of a prepared row (see t_open with the first two cells of rows 0 to 5); the last open
-- row also completes columns 0 and 1, then the first entry claims already.
create or replace function pg_temp.t_row(p_code text, p_token text, p_row int) returns jsonb language plpgsql as $$
declare
  r jsonb;
begin
  r := pg_temp.t_in(p_code, p_token, p_row * 9);
  if jsonb_typeof(r -> 'hunt') = 'object' then
    return r;
  end if;
  return pg_temp.t_in(p_code, p_token, p_row * 9 + 1);
end $$;

-- Time passes: every timestamp of the game moves p_secs seconds into the past.
create or replace function pg_temp.t_age(p_game uuid, p_secs numeric) returns void language plpgsql as $$
declare
  v_iv interval := make_interval(secs => p_secs);
  v_table text;
  v_cols text;
  v_where text;
begin
  foreach v_table in array array['games', 'players', 'rounds', 'lines', 'entries', 'hunts', 'sip_transfers', 'events'] loop
    select string_agg(format('%1$I = %1$I - $2', column_name), ', ')
    into v_cols
    from information_schema.columns
    where table_schema = 'public' and table_name = v_table and data_type = 'timestamp with time zone';
    v_where := case v_table
      when 'games' then 'id = $1'
      when 'entries' then 'round_id in (select id from public.rounds where game_id = $1)'
      else 'game_id = $1' end;
    execute format('update public.%I set %s where %s', v_table, v_cols, v_where) using p_game, v_iv;
  end loop;
end $$;

create or replace function pg_temp.t_st(p_code text, p_token text default null) returns jsonb language sql as $$
  select public.get_state(p_code, p_token)
$$;

-- A player of a snapshot by name.
create or replace function pg_temp.t_p(p_state jsonb, p_name text) returns jsonb language sql as $$
  select p from jsonb_array_elements(p_state -> 'players') p where p ->> 'name' = p_name
$$;

-- A locked line of a snapshot, null if not locked.
create or replace function pg_temp.t_line(p_state jsonb, p_type text, p_idx int) returns jsonb language sql as $$
  select l from jsonb_array_elements(p_state -> 'lines') l
  where l ->> 'line_type' = p_type and (l ->> 'idx')::int = p_idx
$$;

create or replace function pg_temp.t_nlines(p_state jsonb, p_status text default null) returns int language sql as $$
  select count(*)::int from jsonb_array_elements(p_state -> 'lines') l
  where p_status is null or l ->> 'status' = p_status
$$;

create or replace function pg_temp.t_open_cells(p_state jsonb) returns int[] language sql as $$
  select coalesce(array_agg(i - 1 order by i), '{}')
  from generate_series(1, length(p_state -> 'round' ->> 'revealed')) i
  where substr(p_state -> 'round' ->> 'revealed', i, 1) = '0'
$$;

create or replace function pg_temp.t_ts(p_value jsonb) returns timestamptz language sql as $$
  select (p_value #>> '{}')::timestamptz
$$;

do $test$
declare
  code text;
  gid uuid;
  t text[];
  pid uuid[];
  s jsonb;
  r jsonb;
  sol text;
  cells int[];
  c int;
  v bigint;
  x text;
begin
  ---------------------------------------------------------------------------------------------
  -- 1. Joining (2.2)
  ---------------------------------------------------------------------------------------------
  select * into code, gid, t, pid from pg_temp.t_game('{"max_players": 3}', 2);
  perform pg_temp.t_ok(t[1] ~ '^[0-9a-f]{64}$', 'join: token has 32 random bytes');
  perform pg_temp.t_ok((select token_hash from public.player_secrets where player_id = pid[1]) <> t[1], 'join: only the hash of the token is stored');
  perform pg_temp.t_ok((select host_pin_hash from public.game_secrets where game_id = gid) like '$2%', 'create: PIN stored as bcrypt hash');
  perform pg_temp.t_ok(public.join_game(code, 'a', '#30A46C') ->> 'reason' = 'name_taken', 'join: name taken, ignoring case');
  perform pg_temp.t_ok(public.join_game(code, 'Neu', '#E5484D') ->> 'reason' = 'color_taken', 'join: colour taken');
  perform pg_temp.t_ok(public.join_game(code, repeat('x', 17), '#30A46C') ->> 'reason' = 'name_invalid', 'join: name longer than 16');
  perform pg_temp.t_ok(public.join_game(code, '', '#30A46C') ->> 'reason' = 'name_invalid', 'join: empty name');
  perform pg_temp.t_ok(public.join_game(code, 'Neu', '#123456') ->> 'reason' = 'color_invalid', 'join: colour not in the palette');
  perform pg_temp.t_ok(public.join_game(code, 'Neu', '#D6409F') ->> 'reason' = 'color_invalid', 'join: pink only for 8 players');
  perform pg_temp.t_ok(public.join_game('abcd', 'Neu', '#30A46C') ->> 'reason' = 'not_found', 'join: unknown game');
  r := public.join_game(code, 'C', '#30A46C');
  perform pg_temp.t_ok((r ->> 'ok')::boolean, 'join: third player');
  perform pg_temp.t_ok(public.join_game(code, 'D', '#12A594') ->> 'reason' = 'full', 'join: max_players respected');
  perform pg_temp.t_ok((public.host_check(code, '1234') ->> 'ok')::boolean, 'host_check: right PIN');
  perform pg_temp.t_ok(public.host_check(code, '9999') ->> 'reason' = 'bad_pin', 'host_check: wrong PIN');
  s := pg_temp.t_st(code, t[1]);
  perform pg_temp.t_ok(s::text !~ '(token_hash|pin_hash|solution)', 'state: no secrets');
  perform pg_temp.t_ok(jsonb_array_length(s -> 'players') = 3 and s -> 'me' ->> 'name' = 'A', 'state: players and me');
  perform pg_temp.t_ok(public.create_game('12', '{}') ->> 'reason' = 'bad_pin', 'create: PIN too short');
  perform pg_temp.t_ok(public.create_game('1234', '{"round_end_hold_s": -1}') ->> 'reason' = 'bad_config', 'create: bad config value');
  perform pg_temp.t_ok((public.create_game('1234', '{"cash_reveal_s": 5}') ->> 'ok')::boolean is not true, 'create: unknown config key');
  select * into code, gid, t, pid from pg_temp.t_game('{"max_players": 8}', 7);
  perform pg_temp.t_ok((public.join_game(code, 'H', '#D6409F') ->> 'ok')::boolean, 'join: pink with 8 players');

  ---------------------------------------------------------------------------------------------
  -- 2. Errors and lock (2.5)
  ---------------------------------------------------------------------------------------------
  select * into code, gid, t, pid from pg_temp.t_game('{"auto_reveal_open_cells": 0}', 3);
  perform pg_temp.t_ok(public.host_start_main(code, '9999') ->> 'reason' = 'bad_pin', 'start: wrong PIN');
  perform pg_temp.t_ok(pg_temp.t_in(code, t[1], 0) ->> 'reason' = 'wrong_phase', 'input in the lobby refused');
  perform pg_temp.t_ok((public.host_start_main(code, '1234') ->> 'ok')::boolean, 'start: main game');
  s := pg_temp.t_st(code);
  sol := pg_temp.t_sol(gid);
  perform pg_temp.t_ok(s -> 'game' ->> 'phase' = 'round_running' and (s -> 'round' ->> 'size')::int = 9, 'start: 9x9 round running');
  perform pg_temp.t_ok(pg_temp.t_ts(s -> 'round' -> 'deadline') = now() + interval '480 seconds', 'start: round limit 480 s');
  perform pg_temp.t_ok(strpos(s::text, sol) = 0, 'state: no solution');
  perform pg_temp.t_ok(public.join_game(code, 'Spät', '#30A46C') ->> 'reason' = 'wrong_phase', 'join after the start refused');
  c := (pg_temp.t_open_cells(s))[1];
  r := pg_temp.t_bad(code, t[1], c);
  perform pg_temp.t_ok(r ->> 'result' = 'wrong' and (r ->> 'error_count')::int = 1, '1st error', r::text);
  perform pg_temp.t_ok(jsonb_array_length(pg_temp.t_st(code, t[1]) -> 'me' -> 'entries') = 0, 'wrong digit not stored');
  r := pg_temp.t_bad(code, t[1], c);
  perform pg_temp.t_ok((r ->> 'error_count')::int = 2 and r ->> 'locked_until' is null, '2nd error, no lock', r::text);
  perform pg_temp.t_age(gid, 31);
  r := pg_temp.t_bad(code, t[1], c);
  perform pg_temp.t_ok((r ->> 'error_count')::int = 1 and r ->> 'locked_until' is null, 'window over after 30 s: counter starts again', r::text);
  perform pg_temp.t_bad(code, t[1], c);
  r := pg_temp.t_bad(code, t[1], c);
  perform pg_temp.t_ok(r ->> 'locked_until' is not null and (r ->> 'error_count')::int = 0, '3rd error in the window locks', r::text);
  perform pg_temp.t_ok((r ->> 'locked_until')::timestamptz = now() + interval '20 seconds', 'lock lasts 20 s');
  r := pg_temp.t_in(code, t[1], c);
  perform pg_temp.t_ok(r ->> 'reason' = 'locked' and r ->> 'locked_until' is not null, 'locked: even a correct digit refused');
  s := pg_temp.t_st(code, t[2]);
  perform pg_temp.t_ok((pg_temp.t_p(s, 'A') ->> 'errors_total')::int = 5 and (pg_temp.t_p(s, 'A') ->> 'locks_total')::int = 1, 'statistics: 5 errors, 1 lock');
  perform pg_temp.t_ok(s -> 'ticker' -> 0 ->> 'type' = 'player_locked', 'ticker: lock');
  perform pg_temp.t_ok(s -> 'me' -> 'locked_until' = 'null'::jsonb, 'other player not locked');
  perform pg_temp.t_age(gid, 20);
  r := pg_temp.t_bad(code, t[1], c);
  perform pg_temp.t_ok(r ->> 'result' = 'wrong' and (r ->> 'error_count')::int = 1, 'after the lock the counter starts at 0', r::text);
  perform pg_temp.t_ok(public.enter_digit(code, 'x', c, 1) ->> 'reason' = 'bad_token', 'input: bad token');
  perform pg_temp.t_ok(public.enter_digit(code, t[2], 81, 1) ->> 'reason' = 'bad_input', 'input: cell out of range');
  perform pg_temp.t_ok(public.enter_digit(code, t[2], c, 10) ->> 'reason' = 'bad_input', 'input: digit out of range');
  perform pg_temp.t_ok(pg_temp.t_in(code, t[2], strpos(s -> 'round' ->> 'givens', '1') - 1) ->> 'reason' = 'filled', 'input: given cell is filled');
  r := pg_temp.t_in(code, t[2], c);
  perform pg_temp.t_ok(r ->> 'result' = 'correct' and jsonb_array_length(r -> 'claimed') = 0, 'correct digit, nothing claimed');
  perform pg_temp.t_ok(pg_temp.t_st(code, t[2]) -> 'me' -> 'entries' @> jsonb_build_array(jsonb_build_object('cell', c)), 'own entry in the own state');
  perform pg_temp.t_ok(jsonb_array_length(pg_temp.t_st(code, t[3]) -> 'me' -> 'entries') = 0, 'entry not in the state of others');
  perform pg_temp.t_ok(substr(pg_temp.t_st(code) -> 'round' ->> 'revealed', c + 1, 1) = '0', 'entry not revealed');
  perform pg_temp.t_ok(pg_temp.t_in(code, t[2], c) ->> 'reason' = 'filled', 'own cell twice is filled');

  ---------------------------------------------------------------------------------------------
  -- 3. Claim, «Pech gehabt», row and column at once (2.6, 2.7)
  --    Open: row 0 and row 1 in columns 0 to 2.
  ---------------------------------------------------------------------------------------------
  select * into code, gid, t, pid from pg_temp.t_game('{"auto_reveal_open_cells": 0}', 3);
  perform public.host_start_main(code, '1234');
  sol := pg_temp.t_sol(gid);
  perform pg_temp.t_open(gid, array[0, 1, 2, 9, 10, 11]);
  perform pg_temp.t_in(code, t[1], 0);
  r := pg_temp.t_in(code, t[1], 1);
  perform pg_temp.t_ok(jsonb_array_length(r -> 'claimed') = 0, 'row not claimed before its last digit');
  perform pg_temp.t_in(code, t[2], 9);
  r := pg_temp.t_in(code, t[1], 2);
  perform pg_temp.t_ok(r -> 'claimed' = '[{"line_type": "row", "idx": 0}]'::jsonb, 'own last digit claims the row', r::text);
  perform pg_temp.t_ok(r -> 'hunt' ->> 'lines_label' = 'Zeile 1' and r -> 'hunt' ->> 'kind' = 'main', 'claim starts a hunt', r::text);
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok(pg_temp.t_line(s, 'row', 0) ->> 'status' = 'claimed' and (pg_temp.t_line(s, 'row', 0) ->> 'player_id')::uuid = pid[1]
    and (pg_temp.t_line(s, 'row', 0) ->> 'origin_cell')::int = 2, 'line: owner and origin cell');
  perform pg_temp.t_ok(substr(s -> 'round' ->> 'revealed', 1, 9) = substr(sol, 1, 9), 'row revealed for everyone');
  perform pg_temp.t_ok(substr(s -> 'round' ->> 'revealed', 10, 1) = '0', 'private entry of B stays hidden');
  perform pg_temp.t_ok(pg_temp.t_nlines(s, 'neutral') = 13, 'lines complete through givens become neutral', pg_temp.t_nlines(s, 'neutral')::text);
  perform pg_temp.t_ok((pg_temp.t_p(s, 'A') ->> 'lines_claimed')::int = 1 and (pg_temp.t_p(s, 'A') ->> 'sips_to_distribute')::int = 1, 'one line, one shot');
  perform pg_temp.t_ok((s -> 'game' ->> 'hunts_started')::int = 1 and (pg_temp.t_p(s, 'A') ->> 'hunts_started')::int = 1, 'hunt counted');
  perform pg_temp.t_ok(s -> 'ticker' @> '[{"type": "line_claimed", "payload": {"name": "A"}}]', 'ticker: claim with name');
  perform pg_temp.t_ok(pg_temp.t_in(code, t[1], 10) ->> 'reason' = 'hunting', 'no input during the own hunt');
  perform pg_temp.t_ok(pg_temp.t_line(s, 'col', 0) is null and (pg_temp.t_p(s, 'B') ->> 'lines_claimed')::int = 0,
    'Pech gehabt: column 0 complete for B only through the reveal, not claimed');
  perform pg_temp.t_ok(pg_temp.t_in(code, t[2], 1) ->> 'reason' = 'filled', 'revealed cell is filled for others');
  r := pg_temp.t_in(code, t[3], 9);
  perform pg_temp.t_ok(r -> 'claimed' = '[{"line_type": "col", "idx": 0}]'::jsonb, 'another player can still claim it', r::text);
  r := pg_temp.t_in(code, t[2], 10);
  perform pg_temp.t_ok(r -> 'claimed' = '[{"line_type": "col", "idx": 1}]'::jsonb, 'B claims another line', r::text);
  perform pg_temp.t_age(gid, 11);
  perform pg_temp.t_ok(public.hunt_press(code, t[1]) ->> 'result' = 'success', 'hunt confirmed');
  r := pg_temp.t_in(code, t[1], 11);
  perform pg_temp.t_ok(jsonb_array_length(r -> 'claimed') = 2, 'one digit closes row and column', r::text);
  perform pg_temp.t_ok(r -> 'hunt' ->> 'lines_label' like '%Zeile 2 + Spalte 3%' or r -> 'hunt' ->> 'lines_label' like '%Spalte 3 + Zeile 2%',
    'one hunt for both, label joins them', r -> 'hunt' ->> 'lines_label');
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok((s -> 'game' ->> 'hunts_started')::int = 4, 'only one hunt for two lines');
  perform pg_temp.t_ok((pg_temp.t_p(s, 'A') ->> 'lines_claimed')::int = 3 and (pg_temp.t_p(s, 'A') ->> 'sips_to_distribute')::int = 3, 'two lines, two shots');
  perform pg_temp.t_ok((select count(*) from jsonb_array_elements(s -> 'lines') l where (l ->> 'origin_cell')::int = 11 and (l ->> 'player_id')::uuid = pid[1]) = 2, 'both lines belong to A');
  perform pg_temp.t_ok(pg_temp.t_nlines(s) = 18 and s -> 'game' ->> 'phase' = 'round_ending', 'all 18 lines locked: round ends');
  perform pg_temp.t_ok(s -> 'round' ->> 'revealed' = sol, 'grid fully revealed');
  perform pg_temp.t_ok(pg_temp.t_in(code, t[3], 0) ->> 'reason' = 'wrong_phase', 'no input after the end');
  -- Running hunts come first, then the finished grid stays round_end_hold_s.
  perform pg_temp.t_age(gid, 6);
  perform public.tick(code);
  perform pg_temp.t_ok(pg_temp.t_st(code) -> 'game' ->> 'phase' = 'round_ending', 'round_ending waits for running hunts');
  perform pg_temp.t_age(gid, 45);
  perform pg_temp.t_ok((public.tick(code) ->> 'changed')::boolean, 'tick: hunts over by the deadline');
  perform pg_temp.t_ok(pg_temp.t_st(code) -> 'game' ->> 'phase' = 'break_distribute', 'then the break', pg_temp.t_st(code) -> 'game' ->> 'phase');

  ---------------------------------------------------------------------------------------------
  -- 4. Neutral through a reveal (2.6). Open: cells 0, 1, 10.
  ---------------------------------------------------------------------------------------------
  select * into code, gid, t, pid from pg_temp.t_game('{"auto_reveal_open_cells": 0}', 2);
  perform public.host_start_main(code, '1234');
  perform pg_temp.t_open(gid, array[0, 1, 10]);
  perform pg_temp.t_in(code, t[1], 1);
  r := pg_temp.t_in(code, t[2], 0);
  perform pg_temp.t_ok(r -> 'claimed' = '[{"line_type": "col", "idx": 0}]'::jsonb, 'B claims column 1', r::text);
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok(pg_temp.t_line(s, 'row', 0) is null, 'row 1 still open: one cell hidden');
  r := pg_temp.t_in(code, t[1], 10);
  perform pg_temp.t_ok(jsonb_array_length(r -> 'claimed') = 2, 'A claims row 2 and column 2', r::text);
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok(pg_temp.t_line(s, 'row', 0) ->> 'status' = 'neutral', 'row 1 complete only through reveals: neutral');
  perform pg_temp.t_ok(pg_temp.t_line(s, 'row', 0) -> 'player_id' = 'null'::jsonb and pg_temp.t_line(s, 'row', 0) -> 'origin_cell' = 'null'::jsonb, 'neutral: no owner, no origin');
  perform pg_temp.t_ok((pg_temp.t_p(s, 'A') ->> 'lines_claimed')::int = 2 and (pg_temp.t_p(s, 'A') ->> 'sips_to_distribute')::int = 2, 'neutral gives no line and no shot');
  perform pg_temp.t_ok(s -> 'ticker' @> '[{"type": "line_neutral", "payload": {"label": "Zeile 1"}}]', 'ticker: neutral line');
  perform pg_temp.t_ok(pg_temp.t_nlines(s) = 18 and s -> 'game' ->> 'phase' = 'round_ending', 'round over');

  ---------------------------------------------------------------------------------------------
  -- 5. Hunt too early, in time, too late (2.7). Open: cells 0, 1, 9, 10.
  ---------------------------------------------------------------------------------------------
  select * into code, gid, t, pid from pg_temp.t_game('{"auto_reveal_open_cells": 0}', 3);
  perform public.host_start_main(code, '1234');
  perform pg_temp.t_open(gid, array[0, 1, 9, 10]);
  perform pg_temp.t_in(code, t[1], 0);
  r := pg_temp.t_in(code, t[1], 1);
  perform pg_temp.t_ok((r -> 'hunt' ->> 'deadline')::timestamptz = now() + interval '50 seconds', 'hunt: deadline 50 s');
  perform pg_temp.t_ok((r -> 'hunt' ->> 'min_press_at')::timestamptz = now() + interval '10 seconds', 'hunt: button after 10 s');
  s := pg_temp.t_st(code, t[1]);
  perform pg_temp.t_ok((s -> 'game' ->> 'balloons_left')::int = 35, 'running hunt takes no balloon from the hall');
  perform pg_temp.t_ok(jsonb_array_length(s -> 'hunts_active') = 1 and pg_temp.t_p(s, 'A') ->> 'hunt_deadline' is not null, 'TV sees the hunt');
  perform pg_temp.t_ok(s -> 'me' -> 'last_hunt' = 'null'::jsonb, 'no earlier hunt');
  perform pg_temp.t_ok(pg_temp.t_st(code, t[2]) -> 'me' -> 'hunt' = 'null'::jsonb, 'others have no hunt');
  r := public.hunt_press(code, t[1]);
  perform pg_temp.t_ok(r ->> 'reason' = 'too_early' and r ->> 'min_press_at' is not null, 'press too early refused');
  perform pg_temp.t_ok(public.hunt_press(code, t[3]) ->> 'reason' = 'no_hunt', 'press without a hunt');
  perform pg_temp.t_ok(public.hunt_press(code, 'x') ->> 'reason' = 'bad_token', 'press with a bad token');
  r := pg_temp.t_in(code, t[2], 9);
  perform pg_temp.t_ok(r -> 'claimed' = '[{"line_type": "col", "idx": 0}]'::jsonb, 'others keep playing and hunt too', r::text);
  perform pg_temp.t_age(gid, 10);
  v := (pg_temp.t_st(code) -> 'game' ->> 'version')::bigint;
  perform pg_temp.t_ok(public.hunt_press(code, t[1]) ->> 'result' = 'success', 'press in time succeeds');
  s := pg_temp.t_st(code, t[1]);
  perform pg_temp.t_ok((s -> 'game' ->> 'version')::bigint > v, 'press raises the version');
  perform pg_temp.t_ok((pg_temp.t_p(s, 'A') ->> 'hunts_success')::int = 1 and (s -> 'me' ->> 'balloons_allowed')::int = 1, 'success counted');
  perform pg_temp.t_ok((s -> 'game' ->> 'balloons_left')::int = 34, 'confirmed balloon left the hall');
  perform pg_temp.t_ok(s -> 'me' -> 'hunt' = 'null'::jsonb and s -> 'me' -> 'last_hunt' ->> 'status' = 'success', 'hunt over, outcome in the state');
  perform pg_temp.t_ok(s -> 'ticker' -> 0 ->> 'type' = 'hunt_success', 'ticker: success');
  perform pg_temp.t_ok(public.hunt_press(code, t[1]) ->> 'reason' = 'no_hunt', 'second press refused');
  perform pg_temp.t_age(gid, 41);
  perform pg_temp.t_ok((public.tick(code) ->> 'changed')::boolean, 'tick ends the late hunt');
  s := pg_temp.t_st(code, t[2]);
  perform pg_temp.t_ok(s -> 'me' -> 'last_hunt' ->> 'status' = 'failed' and s -> 'me' -> 'last_hunt' ->> 'end_reason' = 'timeout', 'late: failed by timeout');
  perform pg_temp.t_ok(s -> 'me' -> 'hunt_question' ->> 'lines_label' = 'Spalte 1', 'late: question asked');
  perform pg_temp.t_ok((pg_temp.t_p(s, 'B') ->> 'hunts_success')::int = 0 and (s -> 'game' ->> 'balloons_left')::int = 34, 'late: no success, balloon still in the hall');
  perform pg_temp.t_ok(public.hunt_press(code, t[2]) ->> 'reason' = 'no_hunt', 'late press refused');
  perform pg_temp.t_ok(pg_temp.t_in(code, t[2], 10) ->> 'reason' = 'question_open', 'input waits for the answer');
  perform pg_temp.t_ok((public.hunt_answer(code, t[2], false) ->> 'ok')::boolean, 'answer no');
  s := pg_temp.t_st(code, t[2]);
  perform pg_temp.t_ok((s -> 'game' ->> 'balloons_left')::int = 34 and s -> 'me' -> 'hunt_question' = 'null'::jsonb, 'no: balloon stays, question gone');
  perform pg_temp.t_ok(s -> 'ticker' -> 0 ->> 'type' = 'hunt_late_answer' and (s -> 'ticker' -> 0 -> 'payload' ->> 'brought')::boolean = false, 'ticker: answer');
  perform pg_temp.t_ok((public.tick(code) ->> 'changed')::boolean = false, 'tick is idempotent');
  perform pg_temp.t_ok(pg_temp.t_in(code, t[2], 10) ->> 'result' = 'correct', 'input free again');

  ---------------------------------------------------------------------------------------------
  -- 6. «Kein Ballon», answer yes, race for the last balloon, hall empty, cashout (2.7, 2.8, 2.10)
  --    Open: the first two cells of rows 0 to 5.
  ---------------------------------------------------------------------------------------------
  select * into code, gid, t, pid from pg_temp.t_game('{"balloons_total": 3, "hunt_min_press_s": 2, "hunt_duration_s": 10, "round_end_hold_s": 0, "auto_reveal_open_cells": 0}', 3);
  perform public.host_start_main(code, '1234');
  perform pg_temp.t_open(gid, array[0, 1, 9, 10, 18, 19, 27, 28, 36, 37, 45, 46]);
  perform pg_temp.t_ok(jsonb_typeof(pg_temp.t_row(code, t[1], 0) -> 'hunt') = 'object', 'A hunts');
  perform pg_temp.t_ok(public.hunt_no_balloon(code, t[1]) ->> 'reason' = 'too_early', 'kein Ballon: too early refused');
  perform pg_temp.t_ok(public.hunt_no_balloon(code, t[2]) ->> 'reason' = 'no_hunt', 'kein Ballon: without a hunt');
  perform pg_temp.t_ok(public.hunt_no_balloon(code, 'x') ->> 'reason' = 'bad_token', 'kein Ballon: bad token');
  perform pg_temp.t_age(gid, 2);
  r := public.hunt_no_balloon(code, t[1]);
  perform pg_temp.t_ok((r ->> 'ok')::boolean and r ->> 'result' = 'no_balloon', 'kein Ballon accepted', r::text);
  s := pg_temp.t_st(code, t[1]);
  perform pg_temp.t_ok(s -> 'me' -> 'hunt' = 'null'::jsonb and jsonb_array_length(s -> 'hunts_active') = 0, 'kein Ballon: hunt over');
  perform pg_temp.t_ok(s -> 'me' -> 'last_hunt' ->> 'status' = 'failed' and s -> 'me' -> 'last_hunt' ->> 'end_reason' = 'no_balloon', 'kein Ballon: outcome');
  perform pg_temp.t_ok((s -> 'game' ->> 'balloons_left')::int = 3, 'kein Ballon: balloon stays in the hall');
  perform pg_temp.t_ok((pg_temp.t_p(s, 'A') ->> 'hunts_success')::int = 0 and s -> 'me' -> 'hunt_question' = 'null'::jsonb, 'kein Ballon: no success, no question');
  perform pg_temp.t_ok(s -> 'ticker' -> 0 ->> 'type' = 'hunt_no_balloon' and s -> 'ticker' -> 0 -> 'payload' ->> 'name' = 'A', 'ticker: kein Ballon');
  perform pg_temp.t_ok(public.hunt_press(code, t[1]) ->> 'reason' = 'no_hunt', 'depot after giving up refused');
  perform pg_temp.t_age(gid, 1);
  perform pg_temp.t_row(code, t[1], 1);
  perform pg_temp.t_age(gid, 11);
  perform public.tick(code);
  s := pg_temp.t_st(code, t[1]);
  perform pg_temp.t_ok(s -> 'me' -> 'last_hunt' ->> 'end_reason' = 'timeout' and s -> 'me' -> 'last_hunt' -> 'brought' = 'null'::jsonb, 'late: timeout, no answer yet');
  perform pg_temp.t_ok(s -> 'me' -> 'hunt_question' ->> 'lines_label' = 'Zeile 2', 'late: question');
  perform pg_temp.t_ok(pg_temp.t_st(code, t[2]) -> 'me' -> 'hunt_question' = 'null'::jsonb, 'others have no question');
  perform pg_temp.t_ok((s -> 'game' ->> 'balloons_left')::int = 3, 'unanswered: balloon counts as in the hall');
  perform pg_temp.t_ok(pg_temp.t_in(code, t[1], 18) ->> 'reason' = 'question_open', 'input waits for the answer');
  perform pg_temp.t_ok(public.hunt_answer(code, t[1], null) ->> 'reason' = 'bad_input', 'answer needs a value');
  perform pg_temp.t_ok(public.hunt_answer(code, t[2], true) ->> 'reason' = 'no_question', 'others cannot answer');
  r := public.hunt_answer(code, t[1], true);
  perform pg_temp.t_ok((r ->> 'ok')::boolean and (r ->> 'brought')::boolean, 'answer yes');
  s := pg_temp.t_st(code, t[1]);
  perform pg_temp.t_ok((s -> 'game' ->> 'balloons_left')::int = 2, 'yes: balloon left the hall');
  perform pg_temp.t_ok((pg_temp.t_p(s, 'A') ->> 'hunts_success')::int = 0 and (s -> 'me' ->> 'balloons_allowed')::int = 0, 'yes: still no success');
  perform pg_temp.t_ok(s -> 'me' -> 'hunt_question' = 'null'::jsonb and (s -> 'me' -> 'last_hunt' ->> 'brought')::boolean, 'yes: question gone');
  perform pg_temp.t_ok(s -> 'ticker' -> 0 ->> 'type' = 'hunt_late_answer' and (s -> 'ticker' -> 0 -> 'payload' ->> 'brought')::boolean, 'ticker: yes');
  perform pg_temp.t_ok(public.hunt_answer(code, t[1], false) ->> 'reason' = 'no_question', 'second answer refused');
  perform pg_temp.t_age(gid, 1);
  perform pg_temp.t_row(code, t[2], 3);
  perform pg_temp.t_age(gid, 2);
  perform pg_temp.t_ok(public.hunt_press(code, t[2]) ->> 'result' = 'success', 'B confirms');
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok((s -> 'game' ->> 'balloons_left')::int = 1 and s -> 'game' ->> 'phase' = 'round_running', 'one balloon left, round goes on');
  perform pg_temp.t_age(gid, 1);
  perform pg_temp.t_ok(jsonb_typeof(pg_temp.t_row(code, t[3], 4) -> 'hunt') = 'object', 'C hunts the last balloon');
  perform pg_temp.t_age(gid, 1);
  perform pg_temp.t_ok(jsonb_typeof(pg_temp.t_row(code, t[2], 5) -> 'hunt') = 'object', 'B hunts it too: more hunts than balloons allowed');
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok(jsonb_array_length(s -> 'hunts_active') = 2 and (s -> 'game' ->> 'balloons_left')::int = 1, 'race: two hunts, one balloon');
  perform pg_temp.t_age(gid, 2);
  perform pg_temp.t_ok(public.hunt_press(code, t[3]) ->> 'result' = 'success', 'C is first');
  s := pg_temp.t_st(code, t[2]);
  perform pg_temp.t_ok((s -> 'game' ->> 'balloons_left')::int = 0, 'hall empty');
  perform pg_temp.t_ok(s -> 'game' ->> 'phase' in ('round_ending', 'break_distribute'), 'hall empty: round over at once', s -> 'game' ->> 'phase');
  perform pg_temp.t_ok(s -> 'me' -> 'hunt' = 'null'::jsonb and s -> 'me' -> 'last_hunt' ->> 'end_reason' = 'hall_empty', 'B: hunt ends with «Halle leer»');
  perform pg_temp.t_ok((pg_temp.t_p(s, 'B') ->> 'hunts_success')::int = 1, 'hall empty does not count as success');
  perform pg_temp.t_ok((select count(*) from jsonb_array_elements(s -> 'ticker') e where e ->> 'type' = 'hall_empty' and e -> 'payload' ->> 'name' = 'C') = 1, 'ticker: hall empty once, by C');
  perform pg_temp.t_ok(pg_temp.t_in(code, t[1], 18) ->> 'reason' = 'wrong_phase', 'no input after the last balloon');
  perform public.tick(code);
  perform pg_temp.t_ok(pg_temp.t_st(code) -> 'game' ->> 'phase' = 'break_distribute', 'last break');
  foreach x in array t loop
    perform public.give_sips_random(code, x);
  end loop;
  perform pg_temp.t_ok(pg_temp.t_st(code) -> 'game' ->> 'phase' = 'break_drink', 'drinking');
  foreach x in array t loop
    perform public.confirm_ready(code, x);
  end loop;
  s := pg_temp.t_st(code, t[2]);
  perform pg_temp.t_ok(s -> 'game' ->> 'phase' = 'cashout', 'hall empty: cashout instead of another Sudoku', s -> 'game' ->> 'phase');
  perform pg_temp.t_ok((s -> 'me' ->> 'balloons_allowed')::int = 1 and (pg_temp.t_st(code, t[1]) -> 'me' ->> 'balloons_allowed')::int = 0, 'balloons to burst = successful hunts');
  -- Cashout: amounts stay hidden until the host closes it.
  perform pg_temp.t_ok(public.submit_cash(code, t[1], 1001) ->> 'reason' = 'bad_amount', 'cash: above cash_max_cents');
  perform pg_temp.t_ok(public.submit_cash(code, t[1], -1) ->> 'reason' = 'bad_amount', 'cash: negative');
  perform pg_temp.t_ok(public.submit_cash(code, t[1], null) ->> 'reason' = 'bad_amount', 'cash: missing');
  perform pg_temp.t_ok(public.submit_cash(code, 'x', 5) ->> 'reason' = 'bad_token', 'cash: bad token');
  perform pg_temp.t_ok((public.submit_cash(code, t[1], 145) ->> 'ok')::boolean, 'cash: sent');
  perform pg_temp.t_ok((public.submit_cash(code, t[1], 150) ->> 'cash_cents')::int = 150, 'cash: correction');
  perform pg_temp.t_ok(public.host_close_cashout(code, '1234') ->> 'reason' = 'cash_missing', 'close: not everyone sent');
  perform public.submit_cash(code, t[2], 777);
  perform public.submit_cash(code, t[3], 150);
  s := pg_temp.t_st(code, t[1]);
  perform pg_temp.t_ok((s -> 'me' ->> 'cash_cents')::int = 150, 'cash: own amount visible');
  perform pg_temp.t_ok((select bool_and(p -> 'cash_cents' = 'null'::jsonb and (p ->> 'has_submitted_cash')::boolean) from jsonb_array_elements(s -> 'players') p), 'cash: others see only the tick');
  perform pg_temp.t_ok((select bool_and(p -> 'cash_cents' = 'null'::jsonb) from jsonb_array_elements(pg_temp.t_st(code) -> 'players') p), 'cash: TV sees no amount');
  perform pg_temp.t_ok(public.host_close_cashout(code, '9999') ->> 'reason' = 'bad_pin', 'close: wrong PIN');
  perform pg_temp.t_ok((public.host_close_cashout(code, '1234') ->> 'ok')::boolean, 'close');
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok(s -> 'game' ->> 'phase' = 'tiebreak' and (s -> 'round' ->> 'size')::int = 6, 'tie: Powersudoku 6x6');
  perform pg_temp.t_ok(pg_temp.t_ts(s -> 'game' -> 'phase_deadline') - pg_temp.t_ts(s -> 'game' -> 'phase_started_at') = interval '18 seconds', 'reveal: 8 s + 2 places x 5 s');
  perform pg_temp.t_ok(pg_temp.t_ts(s -> 'round' -> 'started_at') = pg_temp.t_ts(s -> 'game' -> 'phase_deadline'), 'Powersudoku starts after the reveal');
  perform pg_temp.t_ok((pg_temp.t_p(s, 'B') ->> 'cash_cents')::int = 777 and (pg_temp.t_p(s, 'B') ->> 'final_rank')::int = 1, 'amounts visible now, single ranked');
  perform pg_temp.t_ok((pg_temp.t_p(s, 'A') ->> 'tiebreak_group')::int = 1 and (pg_temp.t_p(s, 'C') ->> 'tiebreak_group')::int = 1 and pg_temp.t_p(s, 'B') -> 'tiebreak_group' = 'null'::jsonb, 'tie group');
  perform pg_temp.t_ok(public.submit_cash(code, t[1], 1) ->> 'reason' = 'wrong_phase', 'no correction after closing');
  perform pg_temp.t_ok(public.host_close_cashout(code, '1234') ->> 'reason' = 'wrong_phase', 'second close refused');
  perform pg_temp.t_ok(pg_temp.t_in(code, t[1], (pg_temp.t_open_cells(s))[1]) ->> 'reason' = 'not_started', 'no input during the reveal');
  perform pg_temp.t_ok(strpos(s::text, pg_temp.t_sol(gid)) = 0, 'state: no tiebreak solution');

  ---------------------------------------------------------------------------------------------
  -- 7. Powersudoku ranking, including the lot (2.11)
  ---------------------------------------------------------------------------------------------
  select * into code, gid, t, pid from pg_temp.t_game('{}', 6);
  perform public.host_start_main(code, '1234');
  update public.games set phase = 'cashout', phase_deadline = null where id = gid;
  perform public.submit_cash(code, t[1], 500);
  perform public.submit_cash(code, t[2], 300);
  perform public.submit_cash(code, t[3], 300);
  perform public.submit_cash(code, t[4], 200);
  perform public.submit_cash(code, t[5], 200);
  perform public.submit_cash(code, t[6], 200);
  perform public.host_close_cashout(code, '1234');
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok(pg_temp.t_ts(s -> 'round' -> 'deadline') - pg_temp.t_ts(s -> 'round' -> 'started_at') = interval '90 seconds', 'tiebreak limit 90 s');
  perform pg_temp.t_ok((pg_temp.t_p(s, 'A') ->> 'final_rank')::int = 1 and pg_temp.t_p(s, 'B') -> 'final_rank' = 'null'::jsonb, 'single ranked at once, tied not yet');
  perform pg_temp.t_ok((pg_temp.t_p(s, 'B') ->> 'tiebreak_group')::int = 1 and (pg_temp.t_p(s, 'D') ->> 'tiebreak_group')::int = 2 and (pg_temp.t_p(s, 'F') ->> 'tiebreak_group')::int = 2, 'groups by amount');
  perform pg_temp.t_age(gid, 24);
  cells := pg_temp.t_open_cells(s);
  perform pg_temp.t_ok(pg_temp.t_in(code, t[1], cells[1]) ->> 'reason' = 'wrong_phase', 'spectator cannot play');
  for i in 1 .. 3 loop
    perform pg_temp.t_bad(code, t[4], cells[1]);
  end loop;
  s := pg_temp.t_st(code, t[4]);
  perform pg_temp.t_ok(s -> 'me' ->> 'locked_until' is not null, 'tiebreak: three errors lock');
  perform pg_temp.t_ok((pg_temp.t_p(s, 'D') ->> 'errors_total')::int = 0, 'tiebreak errors do not count for the statistics');
  r := pg_temp.t_in(code, t[2], cells[1]);
  perform pg_temp.t_ok(r ->> 'result' = 'correct' and jsonb_array_length(r -> 'claimed') = 0 and r -> 'hunt' = 'null'::jsonb, 'tiebreak: no lines, no hunt');
  foreach c in array cells[2 : array_length(cells, 1) - 1] loop
    perform pg_temp.t_in(code, t[2], c);
  end loop;
  foreach c in array cells[1 : 3] loop
    perform pg_temp.t_in(code, t[3], c);
  end loop;
  r := pg_temp.t_in(code, t[2], cells[array_length(cells, 1)]);
  perform pg_temp.t_ok((r ->> 'finished')::boolean, 'B finishes the grid');
  perform pg_temp.t_ok(pg_temp.t_in(code, t[3], cells[4]) ->> 'reason' = 'group_finished', 'group over for C');
  perform pg_temp.t_ok(pg_temp.t_st(code) -> 'game' ->> 'phase' = 'tiebreak', 'other group plays on');
  perform pg_temp.t_in(code, t[6], cells[1]);
  perform pg_temp.t_in(code, t[6], cells[2]);
  perform pg_temp.t_age(gid, 1);
  perform pg_temp.t_in(code, t[5], cells[1]);
  perform pg_temp.t_in(code, t[5], cells[2]);
  perform pg_temp.t_age(gid, 91);
  perform pg_temp.t_ok((public.tick(code) ->> 'changed')::boolean, 'tick ends the group at the limit');
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok(s -> 'game' ->> 'phase' = 'results' and s -> 'game' -> 'phase_deadline' = 'null'::jsonb, 'results, no second reveal');
  perform pg_temp.t_ok((select string_agg(p ->> 'name', '' order by (p ->> 'final_rank')::int) from jsonb_array_elements(s -> 'players') p) = 'ABCFED',
    'ranks: finisher first, then more correct, then earlier last digit',
    (select string_agg(p ->> 'name', '' order by (p ->> 'final_rank')::int) from jsonb_array_elements(s -> 'players') p));
  perform pg_temp.t_ok((select bool_and(not (p ->> 'rank_by_lot')::boolean) from jsonb_array_elements(s -> 'players') p), 'no lot needed');
  perform pg_temp.t_ok(jsonb_typeof(s -> 'stats') = 'object', 'statistics at the end');
  -- Lot: equal after the Powersudoku.
  select * into code, gid, t, pid from pg_temp.t_game('{}', 4);
  perform public.host_start_main(code, '1234');
  update public.games set phase = 'cashout', phase_deadline = null where id = gid;
  perform public.submit_cash(code, t[1], 300);
  perform public.submit_cash(code, t[2], 300);
  perform public.submit_cash(code, t[3], 300);
  perform public.submit_cash(code, t[4], 100);
  perform public.host_close_cashout(code, '1234');
  perform pg_temp.t_age(gid, 24);
  perform pg_temp.t_in(code, t[1], (pg_temp.t_open_cells(pg_temp.t_st(code)))[1]);
  perform pg_temp.t_age(gid, 91);
  perform public.tick(code);
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok((pg_temp.t_p(s, 'A') ->> 'final_rank')::int = 1 and not (pg_temp.t_p(s, 'A') ->> 'rank_by_lot')::boolean, 'lot: more correct digits stay ahead');
  perform pg_temp.t_ok((pg_temp.t_p(s, 'B') ->> 'rank_by_lot')::boolean and (pg_temp.t_p(s, 'C') ->> 'rank_by_lot')::boolean, 'lot: the equal rest by lot');
  perform pg_temp.t_ok(least((pg_temp.t_p(s, 'B') ->> 'final_rank')::int, (pg_temp.t_p(s, 'C') ->> 'final_rank')::int) = 2
    and greatest((pg_temp.t_p(s, 'B') ->> 'final_rank')::int, (pg_temp.t_p(s, 'C') ->> 'final_rank')::int) = 3, 'lot: ranks 2 and 3');
  perform pg_temp.t_ok((pg_temp.t_p(s, 'D') ->> 'final_rank')::int = 4 and not (pg_temp.t_p(s, 'D') ->> 'rank_by_lot')::boolean, 'lot: single stays');

  ---------------------------------------------------------------------------------------------
  -- 8. Shots (2.9)
  ---------------------------------------------------------------------------------------------
  select * into code, gid, t, pid from pg_temp.t_game('{"round_end_hold_s": 0}', 3);
  perform public.host_start_main(code, '1234');
  update public.players set sips_to_distribute = 5 where id = pid[1];
  update public.players set sips_to_distribute = 1 where id = pid[2];
  update public.rounds set deadline = now() - interval '1 second' where game_id = gid;
  perform public.tick(code);
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok(s -> 'game' ->> 'phase' = 'break_distribute', 'break: hand out', s -> 'game' ->> 'phase');
  perform pg_temp.t_ok(pg_temp.t_ts(s -> 'game' -> 'phase_deadline') = now() + interval '60 seconds', 'hand out: 60 s');
  perform pg_temp.t_ok(public.give_sip(code, t[1], pid[1]) ->> 'reason' = 'bad_target', 'shot to oneself refused');
  perform pg_temp.t_ok(public.give_sip(code, t[1], null) ->> 'reason' = 'bad_target', 'shot without target refused');
  perform pg_temp.t_ok(public.give_sip(code, t[3], pid[1]) ->> 'reason' = 'nothing_left', 'nothing to hand out');
  perform pg_temp.t_ok(public.give_sips_random(code, t[3]) ->> 'reason' = 'nothing_left', 'random with nothing to hand out');
  perform pg_temp.t_ok(public.confirm_ready(code, t[1]) ->> 'reason' = 'wrong_phase', 'ready while handing out refused');
  r := public.give_sip(code, t[1], pid[2]);
  perform pg_temp.t_ok((r ->> 'ok')::boolean and (r ->> 'left')::int = 4, 'one shot to B', r::text);
  s := pg_temp.t_st(code, t[2]);
  perform pg_temp.t_ok((s -> 'me' ->> 'sips_to_drink')::int = 1 and s -> 'me' -> 'sip_senders' = jsonb_build_array(jsonb_build_object('from_player', pid[1], 'amount', 1)), 'B sees it and from whom');
  perform pg_temp.t_ok(s -> 'sip_transfers' = jsonb_build_array(jsonb_build_object('from_player', pid[1], 'to_player', pid[2], 'amount', 1, 'is_random', false)), 'TV sees who gives whom');
  r := public.give_sips_random(code, t[1]);
  perform pg_temp.t_ok((r ->> 'left')::int = 0, 'random hands out the rest');
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok((select count(*) from jsonb_array_elements(s -> 'sip_transfers') e where (e ->> 'is_random')::boolean and (e ->> 'amount')::int = 1 and (e ->> 'from_player')::uuid = pid[1]) = 4, 'random: each shot single');
  perform pg_temp.t_ok(not (s -> 'sip_transfers' @> jsonb_build_array(jsonb_build_object('to_player', pid[1]))), 'random: never to oneself');
  perform pg_temp.t_ok(s -> 'game' ->> 'phase' = 'break_distribute', 'B has not handed out yet');
  perform pg_temp.t_age(gid, 61);
  perform public.tick(code);
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok(s -> 'game' ->> 'phase' = 'break_drink', 'timeout: on to drinking');
  perform pg_temp.t_ok((select bool_and((p ->> 'sips_to_distribute')::int = 0) from jsonb_array_elements(s -> 'players') p), 'timeout: the rest is handed out');
  perform pg_temp.t_ok((select sum((p ->> 'sips_to_drink')::int) from jsonb_array_elements(s -> 'players') p) = 6, 'no shot lost');
  perform pg_temp.t_ok(not (s -> 'sip_transfers' @> jsonb_build_array(jsonb_build_object('from_player', pid[2], 'to_player', pid[2]))), 'timeout: not to oneself');
  perform pg_temp.t_ok(public.host_force_continue(code, '1234') ->> 'reason' = 'too_early', 'force too early');
  perform pg_temp.t_ok((public.confirm_ready(code, t[1]) ->> 'ok')::boolean and pg_temp.t_st(code) -> 'game' ->> 'phase' = 'break_drink', 'ready, waiting for the others');
  perform public.confirm_ready(code, t[2]);
  perform public.confirm_ready(code, t[3]);
  s := pg_temp.t_st(code, t[1]);
  perform pg_temp.t_ok(s -> 'game' ->> 'phase' = 'round_running' and (s -> 'game' ->> 'round_no')::int = 2, 'all ready: next Sudoku');
  perform pg_temp.t_ok((select count(distinct puzzle_id) from public.rounds where game_id = gid) = 2, 'another puzzle');
  perform pg_temp.t_ok((select bool_and((p ->> 'sips_to_drink')::int = 0 and not (p ->> 'ready')::boolean) from jsonb_array_elements(s -> 'players') p), 'break counters reset');
  update public.rounds set deadline = now() - interval '1 second' where id = (select current_round_id from public.games where id = gid);
  perform public.tick(code);
  perform pg_temp.t_ok(pg_temp.t_st(code) -> 'game' ->> 'phase' = 'break_drink', 'nobody has shots: straight to drinking');
  perform pg_temp.t_age(gid, 121);
  perform pg_temp.t_ok(public.host_force_continue(code, '9999') ->> 'reason' = 'bad_pin', 'force with a wrong PIN');
  perform pg_temp.t_ok((public.host_force_continue(code, '1234') ->> 'ok')::boolean, 'force after 120 s');
  perform pg_temp.t_ok((pg_temp.t_st(code) -> 'game' ->> 'round_no')::int = 3, 'forced: next Sudoku');

  ---------------------------------------------------------------------------------------------
  -- 9. Round limit, hold, game limit of 25 minutes (2.4, 2.8)
  ---------------------------------------------------------------------------------------------
  select * into code, gid, t, pid from pg_temp.t_game('{}', 2);
  perform public.host_start_main(code, '1234');
  perform pg_temp.t_ok((public.tick(code) ->> 'changed')::boolean = false, 'tick before the limit changes nothing');
  perform pg_temp.t_age(gid, 480);
  perform pg_temp.t_ok((public.tick(code) ->> 'changed')::boolean, 'tick at the round limit');
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok(s -> 'game' ->> 'phase' = 'round_ending' and pg_temp.t_nlines(s, 'neutral') = 18, 'limit: all lines neutral');
  perform pg_temp.t_ok(s -> 'round' ->> 'revealed' = pg_temp.t_sol(gid), 'limit: grid revealed');
  perform pg_temp.t_ok(s -> 'ticker' -> 0 ->> 'type' = 'round_limit' and not (s -> 'ticker' @> '[{"type": "line_neutral"}]'), 'limit: one ticker line');
  perform pg_temp.t_age(gid, 4);
  perform public.tick(code);
  perform pg_temp.t_ok(pg_temp.t_st(code) -> 'game' ->> 'phase' = 'round_ending', 'finished grid stays 5 s');
  perform pg_temp.t_age(gid, 1);
  perform public.tick(code);
  perform pg_temp.t_ok(pg_temp.t_st(code) -> 'game' ->> 'phase' = 'break_drink', 'then the break');
  update public.games set main_started_at = now() - interval '1499 seconds' where id = gid;
  foreach x in array t loop
    perform public.confirm_ready(code, x);
  end loop;
  perform pg_temp.t_ok(pg_temp.t_st(code) -> 'game' ->> 'phase' = 'round_running', 'at 24:59 another Sudoku starts');
  update public.games set main_started_at = now() - interval '2000 seconds' where id = gid;
  perform public.tick(code);
  perform pg_temp.t_ok(pg_temp.t_st(code) -> 'game' ->> 'phase' = 'round_running', 'a running Sudoku is played to the end');
  select * into code, gid, t, pid from pg_temp.t_game('{"round_end_hold_s": 0}', 2);
  perform public.host_start_main(code, '1234');
  update public.rounds set deadline = now() - interval '1 second' where game_id = gid;
  perform public.tick(code);
  update public.games set main_started_at = now() - interval '1500 seconds' where id = gid;
  foreach x in array t loop
    perform public.confirm_ready(code, x);
  end loop;
  perform pg_temp.t_ok(pg_temp.t_st(code) -> 'game' ->> 'phase' = 'cashout', 'at 25:00 cashout');

  ---------------------------------------------------------------------------------------------
  -- 10. Last cells reveal themselves (2.4)
  ---------------------------------------------------------------------------------------------
  select * into code, gid, t, pid from pg_temp.t_game('{}', 2);
  perform public.host_start_main(code, '1234');
  perform pg_temp.t_open(gid, array[0, 1, 2, 27, 28, 29, 48, 57, 66, 49]);
  perform pg_temp.t_in(code, t[1], 0);
  perform pg_temp.t_in(code, t[1], 1);
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok(array_length(pg_temp.t_open_cells(s), 1) = 10 and pg_temp.t_nlines(s, 'claimed') = 0, 'no claim yet: nothing revealed');
  r := pg_temp.t_in(code, t[1], 2);
  perform pg_temp.t_ok(jsonb_array_length(r -> 'claimed') = 1 and jsonb_typeof(r -> 'hunt') = 'object', 'claim with hunt');
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok(s -> 'round' ->> 'revealed' = pg_temp.t_sol(gid), '7 cells left: the rest is revealed');
  perform pg_temp.t_ok(pg_temp.t_nlines(s, 'claimed') = 1 and pg_temp.t_nlines(s, 'neutral') = 17, 'one claimed, the rest neutral');
  perform pg_temp.t_ok(s -> 'game' ->> 'phase' = 'round_ending', 'round ends');
  perform pg_temp.t_ok(s -> 'ticker' @> '[{"type": "auto_reveal", "payload": {"cells": 7}}]', 'ticker: auto reveal');
  select * into code, gid, t, pid from pg_temp.t_game('{}', 2);
  perform public.host_start_main(code, '1234');
  perform pg_temp.t_open(gid, array[0, 1, 2, 27, 28, 29, 48, 57, 66, 49, 58]);
  perform pg_temp.t_in(code, t[1], 0);
  perform pg_temp.t_in(code, t[1], 1);
  perform pg_temp.t_in(code, t[1], 2);
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok(array_length(pg_temp.t_open_cells(s), 1) = 8 and s -> 'game' ->> 'phase' = 'round_running', '8 cells left: they stay open');

  ---------------------------------------------------------------------------------------------
  -- 11. Trial round 4x4: does not count (2.3)
  ---------------------------------------------------------------------------------------------
  select * into code, gid, t, pid from pg_temp.t_game('{}', 1);
  perform pg_temp.t_ok(public.host_start_trial(code, '1234') ->> 'reason' = 'too_few_players', 'trial: needs 2 players');
  select * into code, gid, t, pid from pg_temp.t_game('{}', 3);
  perform pg_temp.t_ok((public.host_start_trial(code, '1234') ->> 'ok')::boolean, 'trial starts');
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok(s -> 'game' ->> 'phase' = 'trial_running' and (s -> 'round' ->> 'size')::int = 4 and s -> 'round' ->> 'kind' = 'trial', 'trial: 4x4');
  perform pg_temp.t_ok(s -> 'game' -> 'main_started_at' = 'null'::jsonb and (s -> 'game' ->> 'round_no')::int = 0, 'trial: 25-minute clock not started');
  perform pg_temp.t_open(gid, array[0, 1]);
  r := pg_temp.t_in(code, t[1], 0);
  perform pg_temp.t_ok(r -> 'hunt' ->> 'kind' = 'trial', 'trial hunt');
  perform pg_temp.t_ok((r -> 'hunt' ->> 'deadline')::timestamptz = now() + interval '15 seconds' and (r -> 'hunt' ->> 'min_press_at')::timestamptz = now() + interval '5 seconds', 'trial hunt: 15 s, button after 5 s');
  for i in 1 .. 3 loop
    perform pg_temp.t_bad(code, t[2], 1);
  end loop;
  s := pg_temp.t_st(code, t[2]);
  perform pg_temp.t_ok(s -> 'me' ->> 'locked_until' is not null and (pg_temp.t_p(s, 'B') ->> 'errors_total')::int = 0, 'trial: lock works, errors do not count');
  perform pg_temp.t_ok((s -> 'game' ->> 'hunts_started')::int = 0 and (s -> 'game' ->> 'balloons_left')::int = 35, 'trial: no balloon used');
  perform pg_temp.t_ok((pg_temp.t_p(s, 'A') ->> 'lines_claimed')::int = 0 and (pg_temp.t_p(s, 'A') ->> 'sips_to_distribute')::int = 0, 'trial: no line counted, no shot');
  perform pg_temp.t_in(code, t[3], 1);
  perform pg_temp.t_ok(pg_temp.t_st(code) -> 'game' ->> 'phase' = 'trial_ending', 'trial: all lines done');
  perform pg_temp.t_age(gid, 5);
  perform pg_temp.t_ok(public.hunt_press(code, t[1]) ->> 'result' = 'success', 'trial: press');
  s := pg_temp.t_st(code, t[1]);
  perform pg_temp.t_ok((s -> 'me' ->> 'balloons_allowed')::int = 0 and (s -> 'trial_success' ->> pid[1]::text)::int = 1, 'trial: success shown, not counted');
  perform pg_temp.t_age(gid, 11);
  perform public.tick(code);
  perform public.tick(code);
  s := pg_temp.t_st(code, t[3]);
  perform pg_temp.t_ok(s -> 'game' ->> 'phase' = 'lobby' and (s -> 'game' ->> 'trial_done')::boolean, 'trial over: back in the lobby', s -> 'game' ->> 'phase');
  perform pg_temp.t_ok(s -> 'round' = 'null'::jsonb and s -> 'me' -> 'hunt_question' = 'null'::jsonb, 'lobby: no round, no question after the trial');
  perform pg_temp.t_ok((select bool_and((p ->> 'lines_claimed')::int = 0 and (p ->> 'hunts_started')::int = 0 and (p ->> 'hunts_success')::int = 0
    and (p ->> 'errors_total')::int = 0 and (p ->> 'locks_total')::int = 0) from jsonb_array_elements(s -> 'players') p), 'trial: nothing counted');
  v := (s -> 'game' ->> 'version')::bigint;
  perform public.tick(code);
  perform pg_temp.t_ok((pg_temp.t_st(code) -> 'game' ->> 'version')::bigint = v, 'tick in the lobby changes nothing');
  perform pg_temp.t_ok((public.host_start_main(code, '1234') ->> 'ok')::boolean, 'main game after the trial');
  s := pg_temp.t_st(code);
  perform pg_temp.t_ok((s -> 'game' ->> 'round_no')::int = 1 and (s -> 'game' ->> 'hunts_started')::int = 0, 'main game starts clean');

  ---------------------------------------------------------------------------------------------
  -- 12. Access rights (5.2)
  ---------------------------------------------------------------------------------------------
  foreach x in array array['game_secrets', 'players', 'player_secrets', 'puzzles', 'puzzle_solutions', 'rounds', 'lines', 'entries', 'hunts', 'sip_transfers', 'events'] loop
    perform pg_temp.t_ok(not has_table_privilege('anon', 'public.' || x, 'select'), 'anon cannot read ' || x);
    perform pg_temp.t_ok((select relrowsecurity from pg_class where oid = ('public.' || x)::regclass), 'RLS on ' || x);
  end loop;
  perform pg_temp.t_ok(has_table_privilege('anon', 'public.games', 'select') and not has_table_privilege('anon', 'public.games', 'update'), 'anon may only read games');
  foreach x in array array['public.apply_time(uuid)', 'public.build_state(public.games, uuid)', 'public.balloons_left(uuid)', 'public.start_round(public.games, text, int)', 'public.game_id_by_code(text)', 'public.hash_token(text)'] loop
    perform pg_temp.t_ok(not has_function_privilege('anon', x, 'execute'), 'anon cannot call ' || x);
  end loop;
  foreach x in array array['public.get_state(text, text)', 'public.tick(text)', 'public.enter_digit(text, text, int, int)', 'public.hunt_answer(text, text, boolean)', 'public.submit_cash(text, text, int)'] loop
    perform pg_temp.t_ok(has_function_privilege('anon', x, 'execute'), 'anon can call ' || x);
  end loop;

  -- Clean up.
  delete from public.games where id in (select id from t_games);
  perform pg_temp.t_ok(not exists (select 1 from public.games where id in (select id from t_games)), 'test games deleted');
end
$test$;

select 'Alle Regeltests bestanden: ' || current_setting('badoku_test.passed') || ' Prüfungen' as ergebnis;
