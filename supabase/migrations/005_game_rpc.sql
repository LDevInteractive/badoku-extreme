-- Badoku-Extreme - Migration 005: public RPCs of the lobby (CLAUDE.md section 8)
-- Expected refusals come back as {ok:false, reason}, raise is for programming errors only.

create or replace function public.create_game(p_pin text, p_config jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  cfg jsonb;
  v_id uuid;
  v_code text;
begin
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_pin');
  end if;
  cfg := public.merge_config(p_config);
  if cfg is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_config');
  end if;

  -- The unique index on open games decides; on a collision simply draw again.
  for attempt in 1 .. 50 loop
    v_code := lpad(floor(random() * 10000)::int::text, 4, '0');
    begin
      insert into public.games (code, config) values (v_code, cfg) returning id into v_id;
      exit;
    exception when unique_violation then
      v_id := null;
    end;
  end loop;
  if v_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_free_code');
  end if;

  insert into public.game_secrets (game_id, host_pin_hash)
  values (v_id, extensions.crypt(p_pin, extensions.gen_salt('bf')));

  return jsonb_build_object('ok', true, 'game_id', v_id, 'code', v_code);
end;
$$;

create or replace function public.host_check(p_code text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid := public.game_id_by_code(p_code);
begin
  if v_id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if not public.pin_is_valid(v_id, p_pin) then
    return jsonb_build_object('ok', false, 'reason', 'bad_pin');
  end if;
  return jsonb_build_object('ok', true, 'game_id', v_id);
end;
$$;

create or replace function public.join_game(p_code text, p_name text, p_color text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  g public.games;
  v_name text := btrim(coalesce(p_name, ''));
  v_color text := upper(coalesce(p_color, ''));
  v_max int;
  v_count int;
  v_entry jsonb;
  v_player uuid;
  v_token text;
begin
  select * into g from public.games where id = public.game_id_by_code(p_code) for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if g.phase <> 'lobby' then
    return jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  end if;
  if length(v_name) not between 1 and 16 then
    return jsonb_build_object('ok', false, 'reason', 'name_invalid');
  end if;

  v_max := (g.config ->> 'max_players')::int;
  select count(*) into v_count from public.players where game_id = g.id;
  if v_count >= v_max then
    return jsonb_build_object('ok', false, 'reason', 'full');
  end if;

  select e into v_entry from jsonb_array_elements(public.palette()) e where e ->> 'color' = v_color;
  if v_entry is null or ((v_entry ->> 'test_only')::boolean and v_max < 8) then
    return jsonb_build_object('ok', false, 'reason', 'color_invalid');
  end if;
  if exists (select 1 from public.players where game_id = g.id and lower(name) = lower(v_name)) then
    return jsonb_build_object('ok', false, 'reason', 'name_taken');
  end if;
  if exists (select 1 from public.players where game_id = g.id and color = v_color) then
    return jsonb_build_object('ok', false, 'reason', 'color_taken');
  end if;

  insert into public.players (game_id, name, color, seat_no)
  values (g.id, v_name, v_color, v_count + 1)
  returning id into v_player;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.player_secrets (player_id, token_hash)
  values (v_player, public.hash_token(v_token));

  perform public.add_event(g.id, 'player_joined', jsonb_build_object('player_id', v_player, 'name', v_name));
  perform public.bump_version(g.id);

  return jsonb_build_object('ok', true, 'player_id', v_player, 'token', v_token);
end;
$$;

create or replace function public.get_state(p_code text, p_token text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  g public.games;
  v_player uuid := null;
begin
  select * into g from public.games where id = public.game_id_by_code(p_code);
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if p_token is not null then
    v_player := public.player_by_token(g.id, p_token);
  end if;
  return public.build_state(g, v_player);
end;
$$;

-- Time-driven transitions (CLAUDE.md 5.4). The lobby has none; rounds, hunts and
-- breaks add theirs in the following milestones. Idempotent, only a real change
-- may raise the version.
create or replace function public.tick(p_code text)
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
  return jsonb_build_object('ok', true, 'changed', false, 'version', g.version);
end;
$$;

revoke all on function public.create_game(text, jsonb) from public;
revoke all on function public.host_check(text, text) from public;
revoke all on function public.join_game(text, text, text) from public;
revoke all on function public.get_state(text, text) from public;
revoke all on function public.tick(text) from public;

grant execute on function public.create_game(text, jsonb) to anon, authenticated;
grant execute on function public.host_check(text, text) to anon, authenticated;
grant execute on function public.join_game(text, text, text) to anon, authenticated;
grant execute on function public.get_state(text, text) to anon, authenticated;
grant execute on function public.tick(text) to anon, authenticated;
