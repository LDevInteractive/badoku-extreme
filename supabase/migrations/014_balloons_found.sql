-- Badoku-Extreme - Migration 014: only balloons that really left the hall count (CLAUDE.md 2.7, 2.8, 2.10)
-- Run after 013_auto_reveal.sql.
-- Until now every started hunt took a balloon out of the hall, found or not. Now the hall loses a
-- balloon when a hunt is confirmed, or when a late hunter says they brought one anyway. A hunter
-- who finds nothing says so and plays on. The game ends when the hall is empty, so several
-- players may race for the last balloon. The cashout reveal gets its own timing: all amounts
-- count up anonymously, then the places are revealed one by one from the last to the first.

-- How a hunt ended, and whether a late hunter brought a balloon all the same.
-- end_reason: pressed (confirmed), no_balloon (gave up), timeout, hall_empty (someone else took the last one).
-- Hunts that ended before this migration keep null and count as before.
alter table public.hunts add column if not exists end_reason text
  check (end_reason in ('pressed', 'no_balloon', 'timeout', 'hall_empty'));
alter table public.hunts add column if not exists brought boolean;
alter table public.hunts add column if not exists ended_at timestamptz;

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
    'cash_count_s', 8,
    'cash_step_s', 5,
    'award_min_hunts', 2,
    'difficulty', 'leicht',
    'cash_max_cents', 1000,
    'coins_total_cents', 940
  );
$$;

-- Games that already exist get the new values too; cash_reveal_s is no longer used.
update public.games
set config = (public.default_config() || config) - 'cash_reveal_s'
where not (config ? 'cash_count_s' and config ? 'cash_step_s') or config ? 'cash_reveal_s';

-- Balloons still hidden in the hall. Hunts from before this migration have no end_reason; a
-- failed one of those counts as taken, as it did then. Never below 0, even if someone said
-- they brought one after the hall was already empty.
create or replace function public.balloons_left(p_game_id uuid)
returns int
language sql
stable
set search_path = public, extensions
as $$
  select greatest(0, (g.config ->> 'balloons_total')::int - (
    select count(*)::int
    from public.hunts h
    where h.game_id = g.id and h.kind = 'main'
      and (h.status = 'success'
           or (h.status = 'failed' and (h.brought or h.end_reason is null)))))
  from public.games g
  where g.id = p_game_id;
$$;

-- The last balloon has left the hall: whoever still hunts cannot find one any more, and a
-- running round ends at once (no more input, CLAUDE.md 2.8). The caller holds the games row lock.
create or replace function public.empty_hall_if_done(p_game_id uuid, p_name text)
returns void
language plpgsql
set search_path = public, extensions
as $$
declare
  g public.games;
  h public.hunts;
begin
  if public.balloons_left(p_game_id) > 0 then
    return;
  end if;
  if not exists (select 1 from public.events e where e.game_id = p_game_id and e.type = 'hall_empty') then
    perform public.add_event(p_game_id, 'hall_empty', jsonb_build_object('name', p_name));
  end if;
  for h in
    update public.hunts
    set status = 'failed', end_reason = 'hall_empty', ended_at = now()
    where game_id = p_game_id and status = 'active' and kind = 'main'
    returning *
  loop
    update public.players set active_hunt_id = null where id = h.player_id;
  end loop;
  select * into g from public.games where id = p_game_id;
  if g.phase = 'round_running' then
    perform public.end_round(g.id, g.current_round_id);
  end if;
end;
$$;

-- The cashout reveal (CLAUDE.md 2.10): everything counts up for cash_count_s, then one step of
-- cash_step_s per distinct amount, from the last place to the first. Players with the same
-- amount are revealed together. The last step stays on screen for one more step.
create or replace function public.cash_reveal_span(p_game_id uuid)
returns interval
language sql
stable
set search_path = public, extensions
as $$
  select make_interval(secs =>
    (g.config ->> 'cash_count_s')::int
    + (g.config ->> 'cash_step_s')::int
      * (select count(distinct p.cash_cents)::int from public.players p where p.game_id = g.id))
  from public.games g
  where g.id = p_game_id;
$$;

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
    then public.cash_reveal_span(p_game.id)
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
      phase_deadline = case when p_reveal then now() + public.cash_reveal_span(p_game_id) end
  where id = p_game_id;
$$;

-- After the break: a new round while balloons are left and there is time (CLAUDE.md 8.3).
create or replace function public.leave_break(p_game_id uuid)
returns void
language plpgsql
set search_path = public, extensions
as $$
declare
  g public.games;
begin
  update public.players
  set sips_to_drink = 0,
      ready = false,
      locked_until = null,
      err_window_started_at = null,
      err_window_count = 0
  where game_id = p_game_id;

  select * into g from public.games where id = p_game_id;
  if public.balloons_left(g.id) > 0
    and now() - g.main_started_at < make_interval(secs => (g.config ->> 'game_limit_s')::int)
    and public.start_round(g, 'main', 9) is not null then
    perform public.add_event(g.id, 'round_started', jsonb_build_object('round_no', g.round_no + 1));
    return;
  end if;

  update public.games
  set phase = 'cashout',
      phase_started_at = now(),
      phase_deadline = null
  where id = p_game_id;
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
  -- Hunts past their deadline have failed, whatever phase the game is in. A late hunter of the
  -- main game is asked whether they brought a balloon anyway; in the trial nobody runs.
  for h in
    update public.hunts
    set status = 'failed',
        end_reason = 'timeout',
        ended_at = deadline,
        brought = case when kind = 'trial' then false end
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

-- «Ballon im Depot». A confirmed balloon has left the hall; the last one empties it.
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

  update public.hunts set status = 'success', end_reason = 'pressed', pressed_at = now(), ended_at = now() where id = h.id;
  update public.players
  set active_hunt_id = null,
      hunts_success = hunts_success + case when h.kind = 'main' then 1 else 0 end
  where id = v_player
  returning name into v_name;
  if h.kind = 'main' then
    perform public.add_event(g.id, 'hunt_success', jsonb_build_object('player_id', v_player, 'name', v_name));
    perform public.empty_hall_if_done(g.id, v_name);
  end if;
  perform public.bump_version(g.id);
  return jsonb_build_object('ok', true, 'result', 'success');
end;
$$;

-- «Kein Ballon gefunden»: the hunt ends without a balloon, which stays in the hall. Like the
-- depot button only after the minimum time, so it is not hit while running off.
create or replace function public.hunt_no_balloon(p_code text, p_token text)
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

  update public.hunts set status = 'failed', end_reason = 'no_balloon', ended_at = now() where id = h.id;
  update public.players set active_hunt_id = null where id = v_player returning name into v_name;
  if h.kind = 'main' then
    perform public.add_event(g.id, 'hunt_no_balloon', jsonb_build_object('player_id', v_player, 'name', v_name));
  end if;
  perform public.bump_version(g.id);
  return jsonb_build_object('ok', true, 'result', 'no_balloon');
end;
$$;

-- The answer of a late hunter: did they bring a balloon anyway? It goes into the depot but does
-- not count; the answer only keeps the hall right. Open until the break is over.
create or replace function public.hunt_answer(p_code text, p_token text, p_brought boolean)
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
  if p_brought is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_input');
  end if;
  if public.apply_time(g.id) then
    perform public.bump_version(g.id);
    select * into g from public.games where id = g.id;
  end if;
  if g.phase not in ('round_running', 'round_ending', 'break_distribute', 'break_drink') then
    return jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  end if;

  select * into h
  from public.hunts
  where player_id = v_player and round_id = g.current_round_id and kind = 'main'
    and end_reason = 'timeout' and brought is null
  order by started_at desc
  limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_question');
  end if;

  update public.hunts set brought = p_brought where id = h.id;
  select name into v_name from public.players where id = v_player;
  perform public.add_event(g.id, 'hunt_late_answer', jsonb_build_object(
    'player_id', v_player, 'name', v_name, 'brought', p_brought));
  if p_brought then
    perform public.empty_hall_if_done(g.id, v_name);
  end if;
  perform public.bump_version(g.id);
  return jsonb_build_object('ok', true, 'brought', p_brought);
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
  v_hunt public.hunts;
  v_hunt_json jsonb := null;
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

  -- 4. Hunting, or a late hunt that still waits for its answer.
  if p.active_hunt_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'hunting');
  end if;
  if exists (
    select 1 from public.hunts h
    where h.player_id = v_player and h.round_id = r.id and h.kind = 'main'
      and h.end_reason = 'timeout' and h.brought is null) then
    return jsonb_build_object('ok', false, 'reason', 'question_open');
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

    -- One hunt per entry, even for two lines (CLAUDE.md 2.6). A main hunt needs a balloon in
    -- the hall; several players may hunt for the last one, whoever confirms first gets it.
    if r.kind = 'trial' or public.balloons_left(g.id) > 0 then
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
      end if;
    end if;

    -- 10. Only a claim uncovers cells, so this is the one place where few can be left.
    perform public.auto_reveal_if_few(g.id, r.id);
  end if;

  -- 10. Neutral check.
  perform public.lock_neutral_lines(g.id, r.id);

  -- 11. All lines locked.
  if (select count(*) from public.lines l where l.round_id = r.id) >= 2 * r.size then
    perform public.end_round(g.id, r.id);
  end if;

  -- 12. Done.
  perform public.bump_version(g.id);
  return jsonb_build_object('ok', true, 'result', 'correct', 'claimed', v_claimed, 'hunt', v_hunt_json);
end;
$$;

-- As before, with the balloons really left in the hall, how the own last hunt ended and an
-- open question after a late hunt.
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
  v_question jsonb;
begin
  select * into g from public.games where id = public.game_id_by_code(p_code);
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if p_token is not null then
    v_player := public.player_by_token(g.id, p_token);
  end if;
  v_state := public.build_state(g, v_player);
  v_state := jsonb_set(v_state, '{game,balloons_left}', to_jsonb(public.balloons_left(g.id)));
  if v_player is not null then
    select jsonb_build_object(
             'status', h.status, 'kind', h.kind, 'started_at', h.started_at,
             'end_reason', h.end_reason, 'brought', h.brought,
             'ended_at', coalesce(h.ended_at, h.pressed_at, h.deadline))
    into v_last
    from public.hunts h
    where h.player_id = v_player and h.status <> 'active'
    order by h.started_at desc
    limit 1;
    v_state := jsonb_set(v_state, '{me,last_hunt}', coalesce(v_last, 'null'::jsonb));
    select jsonb_build_object('started_at', h.started_at, 'lines_label', h.lines_label)
    into v_question
    from public.hunts h
    where h.player_id = v_player and h.round_id = g.current_round_id and h.kind = 'main'
      and h.end_reason = 'timeout' and h.brought is null
      and g.phase in ('round_running', 'round_ending', 'break_distribute', 'break_drink')
    order by h.started_at desc
    limit 1;
    v_state := jsonb_set(v_state, '{me,hunt_question}', coalesce(v_question, 'null'::jsonb));
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
revoke all on function public.balloons_left(uuid) from public, anon, authenticated;
revoke all on function public.empty_hall_if_done(uuid, text) from public, anon, authenticated;
revoke all on function public.cash_reveal_span(uuid) from public, anon, authenticated;
revoke all on function public.start_round(public.games, text, int) from public, anon, authenticated;
revoke all on function public.begin_results(uuid, boolean) from public, anon, authenticated;
revoke all on function public.leave_break(uuid) from public, anon, authenticated;
revoke all on function public.apply_time(uuid) from public, anon, authenticated;
revoke all on function public.hunt_press(text, text) from public;
revoke all on function public.hunt_no_balloon(text, text) from public;
revoke all on function public.hunt_answer(text, text, boolean) from public;
revoke all on function public.enter_digit(text, text, int, int) from public;
revoke all on function public.get_state(text, text) from public;
grant execute on function public.hunt_press(text, text) to anon, authenticated;
grant execute on function public.hunt_no_balloon(text, text) to anon, authenticated;
grant execute on function public.hunt_answer(text, text, boolean) to anon, authenticated;
grant execute on function public.enter_digit(text, text, int, int) to anon, authenticated;
grant execute on function public.get_state(text, text) to anon, authenticated;
