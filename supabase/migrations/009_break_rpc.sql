-- Badoku-Extreme - Migration 009: breaks between Sudokus (CLAUDE.md sections 2.8, 2.9, 5.3, 8.3)
-- Run after 008_hunt_rpc.sql. Replaces apply_time, adds give_sip, give_sips_random,
-- confirm_ready and host_force_continue. Shots are called "sips" in code and database.

-- One shot from one player to another. The caller has checked sender and target.
create or replace function public.transfer_sip(p_game_id uuid, p_from uuid, p_to uuid, p_random boolean)
returns void
language sql
set search_path = public, extensions
as $$
  insert into public.sip_transfers (game_id, round_no, from_player, to_player, amount, is_random)
  select p_game_id, g.round_no, p_from, p_to, 1, p_random
  from public.games g
  where g.id = p_game_id;
  update public.players
  set sips_to_distribute = sips_to_distribute - 1,
      sips_given_total = sips_given_total + 1
  where id = p_from;
  update public.players
  set sips_to_drink = sips_to_drink + 1,
      sips_received_total = sips_received_total + 1
  where id = p_to;
$$;

-- Hands out everything the player still has, each shot to a random other player.
create or replace function public.give_rest_randomly(p_game_id uuid, p_player uuid)
returns void
language plpgsql
set search_path = public, extensions
as $$
declare
  v_left int;
  v_target uuid;
begin
  select sips_to_distribute into v_left from public.players where id = p_player;
  for k in 1 .. coalesce(v_left, 0) loop
    select id into v_target
    from public.players
    where game_id = p_game_id and id <> p_player
    order by random()
    limit 1;
    perform public.transfer_sip(p_game_id, p_player, v_target, true);
  end loop;
end;
$$;

-- break_drink has no automatic end; phase_deadline says from when the host may force it.
create or replace function public.begin_drink(p_game_id uuid)
returns void
language sql
set search_path = public, extensions
as $$
  update public.players set ready = false where game_id = p_game_id;
  update public.games
  set phase = 'break_drink',
      phase_started_at = now(),
      phase_deadline = now() + make_interval(secs => (config ->> 'force_continue_after_s')::int)
  where id = p_game_id;
$$;

-- Nobody has shots to hand out: straight on to drinking (CLAUDE.md 5.3).
create or replace function public.begin_break(p_game_id uuid)
returns void
language plpgsql
set search_path = public, extensions
as $$
begin
  if exists (select 1 from public.players where game_id = p_game_id and sips_to_distribute > 0) then
    update public.games
    set phase = 'break_distribute',
        phase_started_at = now(),
        phase_deadline = now() + make_interval(secs => (config ->> 'distribute_timeout_s')::int)
    where id = p_game_id;
  else
    perform public.begin_drink(p_game_id);
  end if;
end;
$$;

-- Moves on when the last shot has been handed out.
create or replace function public.finish_distribute_if_done(p_game_id uuid)
returns void
language plpgsql
set search_path = public, extensions
as $$
begin
  if not exists (select 1 from public.players where game_id = p_game_id and sips_to_distribute > 0) then
    perform public.begin_drink(p_game_id);
  end if;
end;
$$;

-- End of a break: next Sudoku or cashout (CLAUDE.md 8.3). Locks and error windows do not
-- reach into the next round.
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
  if g.hunts_started < (g.config ->> 'balloons_total')::int
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

  -- The break starts once every running hunt is over.
  if g.phase = 'round_ending'
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

-- One tap on a tile: one shot. To oneself is not allowed (CLAUDE.md 2.9).
create or replace function public.give_sip(p_code text, p_token text, p_target uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  g public.games;
  v_player uuid;
  v_left int;
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
  if g.phase <> 'break_distribute' then
    return jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  end if;
  if p_target is null or p_target = v_player
    or not exists (select 1 from public.players where id = p_target and game_id = g.id) then
    return jsonb_build_object('ok', false, 'reason', 'bad_target');
  end if;
  select sips_to_distribute into v_left from public.players where id = v_player;
  if v_left <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'nothing_left');
  end if;

  perform public.transfer_sip(g.id, v_player, p_target, false);
  perform public.finish_distribute_if_done(g.id);
  perform public.bump_version(g.id);
  return jsonb_build_object('ok', true, 'left', v_left - 1);
end;
$$;

create or replace function public.give_sips_random(p_code text, p_token text)
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
  if g.phase <> 'break_distribute' then
    return jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  end if;
  if (select sips_to_distribute from public.players where id = v_player) <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'nothing_left');
  end if;

  perform public.give_rest_randomly(g.id, v_player);
  perform public.finish_distribute_if_done(g.id);
  perform public.bump_version(g.id);
  return jsonb_build_object('ok', true, 'left', 0);
end;
$$;

-- "Getrunken & bereit", also with 0 shots. The last one starts what comes next.
create or replace function public.confirm_ready(p_code text, p_token text)
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
  if g.phase <> 'break_drink' then
    return jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  end if;

  update public.players set ready = true where id = v_player and not ready;
  if not found then
    return jsonb_build_object('ok', true);
  end if;
  if not exists (select 1 from public.players where game_id = g.id and not ready) then
    perform public.leave_break(g.id);
  end if;
  perform public.bump_version(g.id);
  return jsonb_build_object('ok', true);
end;
$$;

-- For when someone hangs: only after force_continue_after_s, only with the PIN.
create or replace function public.host_force_continue(p_code text, p_pin text)
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
  if g.phase <> 'break_drink' then
    return jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  end if;
  if now() < g.phase_deadline then
    return jsonb_build_object('ok', false, 'reason', 'too_early', 'phase_deadline', g.phase_deadline);
  end if;

  perform public.leave_break(g.id);
  perform public.bump_version(g.id);
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.transfer_sip(uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.give_rest_randomly(uuid, uuid) from public, anon, authenticated;
revoke all on function public.begin_drink(uuid) from public, anon, authenticated;
revoke all on function public.begin_break(uuid) from public, anon, authenticated;
revoke all on function public.finish_distribute_if_done(uuid) from public, anon, authenticated;
revoke all on function public.leave_break(uuid) from public, anon, authenticated;
revoke all on function public.apply_time(uuid) from public, anon, authenticated;

revoke all on function public.give_sip(text, text, uuid) from public;
revoke all on function public.give_sips_random(text, text) from public;
revoke all on function public.confirm_ready(text, text) from public;
revoke all on function public.host_force_continue(text, text) from public;
grant execute on function public.give_sip(text, text, uuid) to anon, authenticated;
grant execute on function public.give_sips_random(text, text) to anon, authenticated;
grant execute on function public.confirm_ready(text, text) to anon, authenticated;
grant execute on function public.host_force_continue(text, text) to anon, authenticated;
