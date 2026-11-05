-- Badoku-Extreme - Migration 012: cashout, tiebreak, ranking, statistics
-- (CLAUDE.md sections 2.10-2.12, 5.3, 5.4, 8.2 steps 2 and 7, 8.4)
-- Run after 011_trial_rpc.sql. Adds cash_reveal_s and award_min_hunts to the config, replaces
-- start_round, apply_time, enter_digit and get_state, adds submit_cash and host_close_cashout.

-- All game numbers live here and in games.config, nowhere else (CLAUDE.md 6.2).
create or replace function public.default_config()
returns jsonb
language sql
immutable
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'max_players', 7,
    'balloons_total', 35,
    'hunt_duration_s', 50,
    'hunt_min_press_s', 10,
    'trial_hunt_duration_s', 15,
    'trial_hunt_min_press_s', 5,
    'error_window_s', 30,
    'error_max', 3,
    'lock_s', 20,
    'round_limit_s', 480,
    'round_end_hold_s', 5,
    'game_limit_s', 1500,
    'sips_per_line', 1,
    'distribute_timeout_s', 60,
    'force_continue_after_s', 120,
    'tiebreak_limit_s', 90,
    'cash_reveal_s', 10,
    'award_min_hunts', 2,
    'difficulty', 'leicht',
    'cash_max_cents', 1000,
    'coins_total_cents', 940
  );
$$;

-- Games that already exist get the new values too, otherwise they could not reach the end.
update public.games
set config = public.default_config() || config
where not (config ? 'cash_reveal_s' and config ? 'award_min_hunts');

-- Creates a round with a random unused puzzle. Returns null when the pool has none left.
-- A tiebreak starts only after the amounts have been revealed: until then phase_deadline
-- marks the end of the reveal and started_at lies in the future.
create or replace function public.start_round(p_game public.games, p_kind text, p_size int)
returns uuid
language plpgsql
set search_path = public, extensions
as $$
declare
  v_puzzle public.puzzles;
  v_round uuid;
  v_tie boolean := p_kind = 'tiebreak';
  v_start timestamptz := now() + case when p_kind = 'tiebreak'
    then make_interval(secs => (p_game.config ->> 'cash_reveal_s')::int)
    else interval '0' end;
  v_deadline timestamptz := v_start + make_interval(secs => (p_game.config ->> case when p_kind = 'tiebreak' then 'tiebreak_limit_s' else 'round_limit_s' end)::int);
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

  insert into public.rounds (game_id, kind, round_no, puzzle_id, size, givens, revealed, started_at, deadline)
  values (p_game.id, p_kind, v_round_no, v_puzzle.id, v_puzzle.size, v_puzzle.givens, v_puzzle.givens, v_start, v_deadline)
  returning id into v_round;

  update public.games
  set phase = case p_kind when 'trial' then 'trial_running' when 'tiebreak' then 'tiebreak' else 'round_running' end,
      round_no = v_round_no,
      current_round_id = v_round,
      main_started_at = case when p_kind = 'main' then coalesce(main_started_at, now()) else main_started_at end,
      phase_started_at = now(),
      phase_deadline = case when v_tie then v_start else v_deadline end
  where id = p_game.id;

  return v_round;
end;
$$;

-- The end. phase_deadline is only set when the amounts are still being revealed.
create or replace function public.begin_results(p_game_id uuid, p_reveal boolean)
returns void
language sql
set search_path = public, extensions
as $$
  update public.rounds r
  set ended_at = now()
  from public.games g
  where g.id = p_game_id and r.id = g.current_round_id and r.kind = 'tiebreak';
  update public.games
  set phase = 'results',
      current_round_id = null,
      phase_started_at = now(),
      phase_deadline = case when p_reveal then now() + make_interval(secs => (config ->> 'cash_reveal_s')::int) end
  where id = p_game_id;
$$;

-- Ranks inside the tied groups (CLAUDE.md 2.11): whoever finished first, then the number of
-- correct digits, then the earlier last correct digit. What is still equal is decided by lot.
create or replace function public.finish_tiebreak(p_game_id uuid, p_reveal boolean default false)
returns void
language plpgsql
set search_path = public, extensions
as $$
begin
  with ordered as (
    select p.id,
           (select count(*) from public.players o
            where o.game_id = p.game_id and o.cash_cents > p.cash_cents) + 1 as base_rank,
           row_number() over (
             partition by p.tiebreak_group
             order by p.tiebreak_finished_at asc nulls last,
                      p.tiebreak_correct desc,
                      p.tiebreak_last_correct_at asc nulls last,
                      random()) - 1 as pos,
           count(*) over (
             partition by p.tiebreak_group, p.tiebreak_finished_at, p.tiebreak_correct, p.tiebreak_last_correct_at) as same
    from public.players p
    where p.game_id = p_game_id and p.tiebreak_group is not null
  )
  update public.players p
  set final_rank = o.base_rank + o.pos,
      rank_by_lot = o.same > 1
  from ordered o
  where p.id = o.id;
  perform public.begin_results(p_game_id, p_reveal);
end;
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
  h public.hunts;
  v_player uuid;
  v_changed boolean := false;
begin
  -- Hunts past their deadline have failed, whatever phase the game is in.
  for h in
    update public.hunts
    set status = 'failed'
    where game_id = p_game_id and status = 'active' and deadline <= now()
    returning *
  loop
    update public.players set active_hunt_id = null where id = h.player_id;
    if h.kind = 'main' then
      perform public.add_event(p_game_id, 'hunt_failed', jsonb_build_object(
        'player_id', h.player_id,
        'name', (select name from public.players where id = h.player_id)));
    end if;
    v_changed := true;
  end loop;

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
      v_changed := true;
      select * into g from public.games where id = p_game_id;
    end if;
  end if;

  -- The next phase starts once every running hunt is over and the grid has been visible long enough.
  if g.phase in ('round_ending', 'trial_ending')
    and now() >= g.phase_started_at + make_interval(secs => (g.config ->> 'round_end_hold_s')::int)
    and not exists (select 1 from public.hunts where game_id = p_game_id and status = 'active') then
    if g.phase = 'trial_ending' then
      perform public.finish_trial(g.id);
    else
      perform public.begin_break(g.id);
    end if;
    v_changed := true;
    select * into g from public.games where id = p_game_id;
  end if;

  -- Time is up for handing out: the rest goes to random players.
  if g.phase = 'break_distribute' and now() >= g.phase_deadline then
    for v_player in
      select id from public.players where game_id = p_game_id and sips_to_distribute > 0
    loop
      perform public.give_rest_randomly(p_game_id, v_player);
    end loop;
    perform public.begin_drink(g.id);
    v_changed := true;
    select * into g from public.games where id = p_game_id;
  end if;

  -- The tiebreak limit ends all groups that are still playing.
  if g.phase = 'tiebreak' and now() >= (select deadline from public.rounds where id = g.current_round_id) then
    perform public.finish_tiebreak(g.id);
    v_changed := true;
  end if;

  return v_changed;
end;
$$;

-- Exactly the sequence of CLAUDE.md 8.2.
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
  v_label text;
  v_balloons int;
  v_hunt public.hunts;
  v_hunt_json jsonb := null;
  v_ended boolean := false;
  v_finished boolean;
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
  if g.phase not in ('round_running', 'trial_running', 'tiebreak') then
    return jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  end if;

  select * into p from public.players where id = v_player;
  select * into r from public.rounds where id = g.current_round_id;
  cfg := g.config;
  if g.phase = 'tiebreak' then
    if p.tiebreak_group is null then
      return jsonb_build_object('ok', false, 'reason', 'wrong_phase');
    end if;
    if now() < r.started_at then
      return jsonb_build_object('ok', false, 'reason', 'not_started', 'started_at', r.started_at);
    end if;
    if exists (
      select 1 from public.players o
      where o.game_id = g.id and o.tiebreak_group = p.tiebreak_group and o.tiebreak_finished_at is not null) then
      return jsonb_build_object('ok', false, 'reason', 'group_finished');
    end if;
  end if;
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

  if r.kind = 'tiebreak' then
    -- No lines and no hunts here. A full grid ends the group; the last group ends the tiebreak.
    v_finished := p.tiebreak_correct + 1 >= length(r.givens) - length(replace(r.givens, '0', ''));
    update public.players
    set tiebreak_correct = tiebreak_correct + 1,
        tiebreak_last_correct_at = now(),
        tiebreak_finished_at = case when v_finished then now() end
    where id = v_player;
    if v_finished and not exists (
      select 1 from public.players o
      where o.game_id = g.id and o.tiebreak_group is not null
        and not exists (
          select 1 from public.players f
          where f.game_id = g.id and f.tiebreak_group = o.tiebreak_group and f.tiebreak_finished_at is not null)) then
      perform public.finish_tiebreak(g.id);
    end if;
    perform public.bump_version(g.id);
    return jsonb_build_object('ok', true, 'result', 'correct', 'claimed', '[]'::jsonb, 'hunt', null, 'finished', v_finished);
  end if;

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

  -- 9. Claim, reveal, hunt.
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
    v_label := array_to_string(v_labels, ' + ');
    update public.rounds set revealed = r.revealed where id = r.id;
    perform public.add_event(g.id, 'line_claimed', jsonb_build_object(
      'player_id', v_player, 'name', p.name, 'label', v_label));
    if r.kind = 'main' then
      update public.players
      set lines_claimed = lines_claimed + cardinality(v_claim),
          sips_to_distribute = sips_to_distribute + cardinality(v_claim) * (cfg ->> 'sips_per_line')::int
      where id = v_player;
    end if;

    -- One hunt per entry, even for two lines (CLAUDE.md 2.6). Balloons limit main hunts only.
    v_balloons := (cfg ->> 'balloons_total')::int;
    if r.kind = 'trial' or g.hunts_started < v_balloons then
      insert into public.hunts (game_id, round_id, player_id, kind, lines_label, min_press_at, deadline)
      values (
        g.id, r.id, v_player,
        case when r.kind = 'trial' then 'trial' else 'main' end,
        v_label,
        now() + make_interval(secs => (cfg ->> case when r.kind = 'trial' then 'trial_hunt_min_press_s' else 'hunt_min_press_s' end)::int),
        now() + make_interval(secs => (cfg ->> case when r.kind = 'trial' then 'trial_hunt_duration_s' else 'hunt_duration_s' end)::int))
      returning * into v_hunt;
      update public.players set active_hunt_id = v_hunt.id where id = v_player;
      v_hunt_json := jsonb_build_object(
        'lines_label', v_hunt.lines_label, 'kind', v_hunt.kind, 'started_at', v_hunt.started_at,
        'min_press_at', v_hunt.min_press_at, 'deadline', v_hunt.deadline);
      if r.kind = 'main' then
        update public.games set hunts_started = hunts_started + 1 where id = g.id;
        update public.players set hunts_started = hunts_started + 1 where id = v_player;
        -- The last balloon ends the game at once: no more input, running hunts finish.
        if g.hunts_started + 1 >= v_balloons then
          perform public.add_event(g.id, 'balloons_empty');
          perform public.end_round(g.id, r.id);
          v_ended := true;
        end if;
      end if;
    end if;
  end if;

  -- 10. Neutral check.
  perform public.lock_neutral_lines(g.id, r.id);

  -- 11. All lines locked.
  if not v_ended and (select count(*) from public.lines l where l.round_id = r.id) >= 2 * r.size then
    perform public.end_round(g.id, r.id);
  end if;

  -- 12. Done.
  perform public.bump_version(g.id);
  return jsonb_build_object('ok', true, 'result', 'correct', 'claimed', v_claimed, 'hunt', v_hunt_json);
end;
$$;

-- The player's total in cents; can be corrected until the host closes the cashout.
create or replace function public.submit_cash(p_code text, p_token text, p_cents int)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  g public.games;
  v_player uuid;
begin
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
  if g.phase <> 'cashout' then
    return jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  end if;
  if p_cents is null or p_cents not between 0 and (g.config ->> 'cash_max_cents')::int then
    return jsonb_build_object('ok', false, 'reason', 'bad_amount');
  end if;

  update public.players
  set cash_cents = p_cents,
      cash_submitted_at = now()
  where id = v_player;
  perform public.bump_version(g.id);
  return jsonb_build_object('ok', true, 'cash_cents', p_cents);
end;
$$;

-- Ranking (CLAUDE.md 8.4): a unique amount has its rank now, equal amounts play for theirs.
create or replace function public.host_close_cashout(p_code text, p_pin text)
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
  if public.apply_time(g.id) then
    perform public.bump_version(g.id);
    select * into g from public.games where id = g.id;
  end if;
  if g.phase <> 'cashout' then
    return jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  end if;
  if exists (select 1 from public.players where game_id = g.id and cash_submitted_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'cash_missing');
  end if;

  with tied as (
    select cash_cents, row_number() over (order by cash_cents desc) as grp
    from public.players
    where game_id = g.id
    group by cash_cents
    having count(*) >= 2
  )
  update public.players p
  set tiebreak_group = t.grp,
      locked_until = null,
      err_window_started_at = null,
      err_window_count = 0
  from tied t
  where p.game_id = g.id and p.cash_cents = t.cash_cents;

  update public.players p
  set final_rank = 1 + (select count(*) from public.players o where o.game_id = g.id and o.cash_cents > p.cash_cents)
  where p.game_id = g.id and p.tiebreak_group is null;

  if not exists (select 1 from public.players where game_id = g.id and tiebreak_group is not null) then
    perform public.begin_results(g.id, true);
  elsif public.start_round(g, 'tiebreak', 6) is null then
    -- An empty puzzle pool must not hold up the end of the game: the lot decides at once.
    perform public.finish_tiebreak(g.id, true);
  end if;
  perform public.bump_version(g.id);
  return jsonb_build_object('ok', true);
end;
$$;

-- End screen (CLAUDE.md 2.12). Only main rounds count: the trial leaves its rounds, lines
-- and hunts in the tables.
create or replace function public.game_stats(p_game public.games)
returns jsonb
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  v_players jsonb;
  v_awards jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'player_id', p.id,
           'lines_total', p.lines_claimed,
           'lines_by_round', (
             select coalesce(jsonb_agg((
               select count(*) from public.lines l
               where l.round_id = r.id and l.player_id = p.id and l.status = 'claimed') order by r.round_no), '[]'::jsonb)
             from public.rounds r
             where r.game_id = p_game.id and r.kind = 'main'),
           'fastest_line_s', (
             select floor(extract(epoch from min(l.claimed_at - r.started_at)))::int
             from public.lines l
             join public.rounds r on r.id = l.round_id
             where l.player_id = p.id and l.status = 'claimed' and r.kind = 'main'),
           'hunts_started', p.hunts_started,
           'hunts_success', p.hunts_success,
           'hunts_quote', case when p.hunts_started > 0 then round(100.0 * p.hunts_success / p.hunts_started)::int end,
           'errors_total', p.errors_total,
           'locks_total', p.locks_total,
           'sips_given', p.sips_given_total,
           'sips_received', p.sips_received_total,
           'favourite_victim', (
             select jsonb_build_object('player_id', t.to_player, 'amount', sum(t.amount)::int)
             from public.sip_transfers t
             join public.players v on v.id = t.to_player
             where t.from_player = p.id
             group by t.to_player, v.seat_no
             order by sum(t.amount) desc, v.seat_no
             limit 1)
         ) order by p.final_rank), '[]'::jsonb)
  into v_players
  from public.players p
  where p.game_id = p_game.id;

  with candidates as (
    select 'lines' as key, id, lines_claimed::numeric as score, lines_claimed as value, null::int as total
    from public.players where game_id = p_game.id and lines_claimed > 0
    union all
    select 'hunter', id, hunts_success::numeric / hunts_started, hunts_success, hunts_started
    from public.players
    where game_id = p_game.id and hunts_success > 0
      and hunts_started >= (p_game.config ->> 'award_min_hunts')::int
    union all
    select 'errors', id, errors_total::numeric, errors_total, null
    from public.players where game_id = p_game.id and errors_total > 0
    union all
    select 'magnet', id, sips_received_total::numeric, sips_received_total, null
    from public.players where game_id = p_game.id and sips_received_total > 0
    union all
    select 'generous', id, sips_given_total::numeric, sips_given_total, null
    from public.players where game_id = p_game.id and sips_given_total > 0
  ),
  best as (
    select c.key, max(c.score) as score from candidates c group by c.key
  )
  select coalesce(jsonb_object_agg(w.key, w.winners), '{}'::jsonb)
  into v_awards
  from (
    select c.key, jsonb_agg(jsonb_build_object('player_id', c.id, 'value', c.value, 'total', c.total)) as winners
    from candidates c
    join best b on b.key = c.key and b.score = c.score
    group by c.key
  ) w;

  return jsonb_build_object('players', v_players, 'awards', v_awards);
end;
$$;

-- As before, plus the statistics of the finished game.
create or replace function public.get_state(p_code text, p_token text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  g public.games;
  v_player uuid := null;
  v_state jsonb;
  v_last jsonb;
begin
  select * into g from public.games where id = public.game_id_by_code(p_code);
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if p_token is not null then
    v_player := public.player_by_token(g.id, p_token);
  end if;
  v_state := public.build_state(g, v_player);
  if v_player is not null then
    select jsonb_build_object(
             'status', h.status, 'kind', h.kind, 'started_at', h.started_at,
             'ended_at', coalesce(h.pressed_at, h.deadline))
    into v_last
    from public.hunts h
    where h.player_id = v_player and h.status <> 'active'
    order by h.started_at desc
    limit 1;
    v_state := jsonb_set(v_state, '{me,last_hunt}', coalesce(v_last, 'null'::jsonb));
  end if;
  if g.phase in ('trial_running', 'trial_ending') then
    v_state := v_state || jsonb_build_object('trial_success', (
      select coalesce(jsonb_object_agg(s.player_id, s.n), '{}'::jsonb)
      from (
        select h.player_id, count(*) as n
        from public.hunts h
        where h.round_id = g.current_round_id and h.status = 'success'
        group by h.player_id
      ) s));
  end if;
  if g.phase = 'results' then
    v_state := v_state || jsonb_build_object('stats', public.game_stats(g));
  end if;
  return v_state;
end;
$$;

revoke all on function public.default_config() from public, anon, authenticated;
revoke all on function public.start_round(public.games, text, int) from public, anon, authenticated;
revoke all on function public.begin_results(uuid, boolean) from public, anon, authenticated;
revoke all on function public.finish_tiebreak(uuid, boolean) from public, anon, authenticated;
revoke all on function public.apply_time(uuid) from public, anon, authenticated;
revoke all on function public.game_stats(public.games) from public, anon, authenticated;
revoke all on function public.submit_cash(text, text, int) from public;
revoke all on function public.host_close_cashout(text, text) from public;
grant execute on function public.submit_cash(text, text, int) to anon, authenticated;
grant execute on function public.host_close_cashout(text, text) to anon, authenticated;
