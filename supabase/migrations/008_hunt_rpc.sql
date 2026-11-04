-- Badoku-Extreme - Migration 008: hunts (CLAUDE.md sections 2.7, 2.8, 8.2 step 9)
-- Run after 007_round_rpc.sql. Replaces apply_time, enter_digit and get_state,
-- adds hunt_press.

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
    end if;
  end if;
  return v_changed;
end;
$$;

-- Exactly the sequence of CLAUDE.md 8.2. The tiebreak (steps 2, 7) follows with its milestone.
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

-- "BALLON IM DEPOT": the server decides by its own clock (CLAUDE.md 2.7).
create or replace function public.hunt_press(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  g public.games;
  h public.hunts;
  v_player uuid;
  v_name text;
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
  end if;

  select h2.* into h
  from public.players p
  join public.hunts h2 on h2.id = p.active_hunt_id
  where p.id = v_player and h2.status = 'active';
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_hunt');
  end if;
  if now() < h.min_press_at then
    return jsonb_build_object('ok', false, 'reason', 'too_early', 'min_press_at', h.min_press_at);
  end if;

  update public.hunts set status = 'success', pressed_at = now() where id = h.id;
  update public.players
  set active_hunt_id = null,
      hunts_success = hunts_success + case when h.kind = 'main' then 1 else 0 end
  where id = v_player
  returning name into v_name;
  if h.kind = 'main' then
    perform public.add_event(g.id, 'hunt_success', jsonb_build_object('player_id', v_player, 'name', v_name));
  end if;
  perform public.bump_version(g.id);
  return jsonb_build_object('ok', true, 'result', 'success');
end;
$$;

-- As before, plus the outcome of the player's last hunt, so that a phone can show it
-- after a reload as well.
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
             'status', h.status, 'started_at', h.started_at,
             'ended_at', coalesce(h.pressed_at, h.deadline))
    into v_last
    from public.hunts h
    where h.player_id = v_player and h.status <> 'active'
    order by h.started_at desc
    limit 1;
    v_state := jsonb_set(v_state, '{me,last_hunt}', coalesce(v_last, 'null'::jsonb));
  end if;
  return v_state;
end;
$$;

revoke all on function public.apply_time(uuid) from public, anon, authenticated;
revoke all on function public.hunt_press(text, text) from public;
grant execute on function public.hunt_press(text, text) to anon, authenticated;
