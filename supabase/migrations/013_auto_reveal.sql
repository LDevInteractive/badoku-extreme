-- Badoku-Extreme - Migration 013: the last cells fill in by themselves (CLAUDE.md sections 2.4, 2.6, 8.2)
-- Run after 012_cashout_rpc.sql. Adds auto_reveal_open_cells to the config and replaces enter_digit.
-- Near the end of a round a line costs one or two taps but pays like any other. Whoever waited
-- collects them, often while the others are away hunting. So the rest is revealed neutrally.

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
    'auto_reveal_open_cells', 7,
    'cash_reveal_s', 10,
    'award_min_hunts', 2,
    'difficulty', 'leicht',
    'cash_max_cents', 1000,
    'coins_total_cents', 940
  );
$$;

-- Games that already exist get the new value too.
update public.games
set config = public.default_config() || config
where not config ? 'auto_reveal_open_cells';

-- Reveals the rest of a main round once at most auto_reveal_open_cells cells are open; 0 switches
-- it off. Trial and tiebreak have far fewer cells, the rule would end them at once. The neutral
-- lines get a later time than the claim before them, clients draw lines in that order.
create or replace function public.auto_reveal_if_few(p_game_id uuid, p_round_id uuid)
returns void
language plpgsql
set search_path = public, extensions
as $$
declare
  r public.rounds;
  v_limit int;
  v_open int;
begin
  select * into r from public.rounds where id = p_round_id;
  if r.kind <> 'main' then
    return;
  end if;
  select coalesce((g.config ->> 'auto_reveal_open_cells')::int, 0) into v_limit
  from public.games g
  where g.id = p_game_id;
  v_open := length(r.revealed) - length(replace(r.revealed, '0', ''));
  if v_open = 0 or v_open > v_limit then
    return;
  end if;

  update public.rounds
  set revealed = (select s.solution from public.puzzle_solutions s where s.puzzle_id = r.puzzle_id)
  where id = r.id;
  perform public.lock_neutral_lines(p_game_id, r.id, false);
  update public.lines
  set claimed_at = clock_timestamp()
  where round_id = r.id and status = 'neutral' and claimed_at = now();
  perform public.add_event(p_game_id, 'auto_reveal', jsonb_build_object('cells', v_open));
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

  -- Only a claim uncovers cells, so this is the one place where few can be left.
  if cardinality(v_claim) > 0 and not v_ended then
    perform public.auto_reveal_if_few(g.id, r.id);
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

revoke all on function public.default_config() from public, anon, authenticated;
revoke all on function public.auto_reveal_if_few(uuid, uuid) from public, anon, authenticated;
