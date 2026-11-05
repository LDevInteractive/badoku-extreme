-- Badoku-Extreme - Migration 011: trial round 4x4 (CLAUDE.md sections 2.3, 5.3, 5.4)
-- Run after 010_round_end_hold.sql. Adds host_start_trial and the way back to the lobby,
-- replaces apply_time and get_state.

-- Back to the lobby. Nothing of the trial may reach the main game: a counter of errors or
-- a lock would punish the first round, its events would stand in the ticker. Its rounds,
-- lines and hunts stay, marked by their kind, so a repeat gets another puzzle.
create or replace function public.finish_trial(p_game_id uuid)
returns void
language plpgsql
set search_path = public, extensions
as $$
declare
  v_started timestamptz;
begin
  select r.started_at into v_started
  from public.games g
  join public.rounds r on r.id = g.current_round_id
  where g.id = p_game_id;

  delete from public.events where game_id = p_game_id and created_at >= v_started;

  update public.players
  set locked_until = null,
      err_window_started_at = null,
      err_window_count = 0,
      ready = false
  where game_id = p_game_id;

  update public.games
  set phase = 'lobby',
      trial_done = true,
      current_round_id = null,
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
  end if;

  return v_changed;
end;
$$;

-- Can be repeated: the lobby keeps the button, each trial takes a new puzzle.
create or replace function public.host_start_trial(p_code text, p_pin text)
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
  if public.start_round(g, 'trial', 4) is null then
    return jsonb_build_object('ok', false, 'reason', 'no_puzzle');
  end if;
  perform public.bump_version(g.id);
  return jsonb_build_object('ok', true);
end;
$$;

-- As before, plus two things for the trial: the last hunt says what kind it was, so a phone
-- does not promise a balloon, and pressed hunts are counted here, because the trial leaves
-- the players' counters alone.
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
  return v_state;
end;
$$;

revoke all on function public.finish_trial(uuid) from public, anon, authenticated;
revoke all on function public.apply_time(uuid) from public, anon, authenticated;
revoke all on function public.host_start_trial(text, text) from public;
grant execute on function public.host_start_trial(text, text) to anon, authenticated;
