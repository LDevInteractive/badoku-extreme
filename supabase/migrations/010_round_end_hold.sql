-- Badoku-Extreme - Migration 010: the finished grid stays visible (CLAUDE.md sections 2.4, 5.3, 5.4)
-- Run after 009_break_rpc.sql. Adds round_end_hold_s to the config and replaces apply_time:
-- round_ending now lasts at least that long, even when no hunt is running.

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
    'difficulty', 'leicht',
    'cash_max_cents', 1000,
    'coins_total_cents', 940
  );
$$;

-- Games that already exist get the new value too, otherwise they could never leave round_ending.
update public.games
set config = public.default_config() || config
where not config ? 'round_end_hold_s';

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

  -- The break starts once every running hunt is over and the grid has been visible long enough.
  if g.phase = 'round_ending'
    and now() >= g.phase_started_at + make_interval(secs => (g.config ->> 'round_end_hold_s')::int)
    and not exists (select 1 from public.hunts where game_id = p_game_id and status = 'active') then
    perform public.begin_break(g.id);
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
  end if;

  return v_changed;
end;
$$;

revoke all on function public.default_config() from public, anon, authenticated;
revoke all on function public.apply_time(uuid) from public, anon, authenticated;
