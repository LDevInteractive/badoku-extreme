-- Badoku-Extreme - Migration 004: internal helpers (CLAUDE.md sections 5.2, 6.2, 6.3, 8.1)
-- None of these are callable by clients; execute rights are revoked at the end.

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

-- Fixed player colours (CLAUDE.md 6.3). test_only colours need max_players = 8.
create or replace function public.palette()
returns jsonb
language sql
immutable
set search_path = public, extensions
as $$
  select jsonb_build_array(
    jsonb_build_object('name', 'Rot',     'color', '#E5484D', 'ink', '#FFFFFF', 'test_only', false),
    jsonb_build_object('name', 'Orange',  'color', '#F76B15', 'ink', '#000000', 'test_only', false),
    jsonb_build_object('name', 'Gelb',    'color', '#FFC53D', 'ink', '#000000', 'test_only', false),
    jsonb_build_object('name', 'Grün',    'color', '#30A46C', 'ink', '#000000', 'test_only', false),
    jsonb_build_object('name', 'Türkis',  'color', '#12A594', 'ink', '#000000', 'test_only', false),
    jsonb_build_object('name', 'Blau',    'color', '#3E63DD', 'ink', '#FFFFFF', 'test_only', false),
    jsonb_build_object('name', 'Violett', 'color', '#8E4EC6', 'ink', '#FFFFFF', 'test_only', false),
    jsonb_build_object('name', 'Pink',    'color', '#D6409F', 'ink', '#FFFFFF', 'test_only', true)
  );
$$;

-- Merges overrides into the defaults. Returns null when an override is not allowed.
create or replace function public.merge_config(p_config jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, extensions
as $$
declare
  defaults jsonb := public.default_config();
  k text;
  v jsonb;
begin
  if p_config is null then
    return defaults;
  end if;
  if jsonb_typeof(p_config) <> 'object' then
    return null;
  end if;
  for k, v in select * from jsonb_each(p_config) loop
    if not defaults ? k then
      return null;
    end if;
    if k = 'difficulty' then
      if v not in ('"leicht"'::jsonb, '"mittel"'::jsonb) then
        return null;
      end if;
    elsif jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric < 0
      or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) then
      return null;
    end if;
  end loop;
  defaults := defaults || p_config;
  if (defaults ->> 'max_players')::int not between 2 and 8 then
    return null;
  end if;
  return defaults;
end;
$$;

-- The game a code currently stands for: the open one, otherwise the latest finished one.
create or replace function public.game_id_by_code(p_code text)
returns uuid
language sql
stable
set search_path = public, extensions
as $$
  select id
  from public.games
  where code = p_code
  order by (phase <> 'results') desc, created_at desc
  limit 1;
$$;

create or replace function public.hash_token(p_token text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

-- Null unless the token belongs to a player of this game.
create or replace function public.player_by_token(p_game_id uuid, p_token text)
returns uuid
language sql
stable
set search_path = public, extensions
as $$
  select p.id
  from public.player_secrets s
  join public.players p on p.id = s.player_id
  where s.token_hash = public.hash_token(p_token)
    and p.game_id = p_game_id;
$$;

create or replace function public.pin_is_valid(p_game_id uuid, p_pin text)
returns boolean
language sql
stable
set search_path = public, extensions
as $$
  select coalesce(
    (select host_pin_hash = extensions.crypt(p_pin, host_pin_hash)
     from public.game_secrets
     where game_id = p_game_id),
    false
  );
$$;

-- Every state change ends here, clients reload on a version change (CLAUDE.md 5.1).
create or replace function public.bump_version(p_game_id uuid)
returns void
language sql
set search_path = public, extensions
as $$
  update public.games set version = version + 1 where id = p_game_id;
$$;

create or replace function public.add_event(p_game_id uuid, p_type text, p_payload jsonb default '{}'::jsonb)
returns void
language sql
set search_path = public, extensions
as $$
  insert into public.events (game_id, type, payload) values (p_game_id, p_type, p_payload);
$$;

-- Complete snapshot for one viewer (CLAUDE.md 8.1). Never contains solutions, hashes
-- or other players' entries. p_player is null for the TV and for anonymous viewers.
create or replace function public.build_state(p_game public.games, p_player uuid)
returns jsonb
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  cfg jsonb := p_game.config;
  show_cash boolean := p_game.phase in ('tiebreak', 'results');
  v_round jsonb;
  v_lines jsonb;
  v_players jsonb;
  v_hunts jsonb;
  v_transfers jsonb;
  v_ticker jsonb;
  v_me jsonb := null;
begin
  select jsonb_build_object(
           'id', r.id, 'kind', r.kind, 'round_no', r.round_no, 'size', r.size,
           'givens', r.givens, 'revealed', r.revealed,
           'started_at', r.started_at, 'deadline', r.deadline)
  into v_round
  from public.rounds r
  where r.id = p_game.current_round_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'line_type', l.line_type, 'idx', l.idx, 'status', l.status,
           'player_id', l.player_id, 'claimed_at', l.claimed_at,
           'origin_cell', l.origin_cell) order by l.claimed_at), '[]'::jsonb)
  into v_lines
  from public.lines l
  where l.round_id = p_game.current_round_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'name', p.name, 'color', p.color, 'seat_no', p.seat_no,
           'lines_claimed', p.lines_claimed,
           'hunts_started', p.hunts_started, 'hunts_success', p.hunts_success,
           'errors_total', p.errors_total, 'locks_total', p.locks_total,
           'sips_to_distribute', p.sips_to_distribute, 'sips_to_drink', p.sips_to_drink,
           'ready', p.ready,
           'has_submitted_cash', p.cash_submitted_at is not null,
           'cash_cents', case when show_cash then p.cash_cents end,
           'locked_until', p.locked_until,
           'hunt_deadline', h.deadline,
           'final_rank', p.final_rank, 'rank_by_lot', p.rank_by_lot,
           'tiebreak_group', p.tiebreak_group, 'tiebreak_correct', p.tiebreak_correct,
           'tiebreak_finished_at', p.tiebreak_finished_at) order by p.seat_no), '[]'::jsonb)
  into v_players
  from public.players p
  left join public.hunts h on h.id = p.active_hunt_id and h.status = 'active'
  where p.game_id = p_game.id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'player_id', h.player_id, 'kind', h.kind, 'lines_label', h.lines_label,
           'started_at', h.started_at, 'min_press_at', h.min_press_at,
           'deadline', h.deadline) order by h.started_at), '[]'::jsonb)
  into v_hunts
  from public.hunts h
  where h.game_id = p_game.id and h.status = 'active';

  select coalesce(jsonb_agg(jsonb_build_object(
           'from_player', t.from_player, 'to_player', t.to_player,
           'amount', t.amount, 'is_random', t.is_random) order by t.created_at), '[]'::jsonb)
  into v_transfers
  from public.sip_transfers t
  where t.game_id = p_game.id and t.round_no = p_game.round_no;

  select coalesce(jsonb_agg(jsonb_build_object(
           'type', e.type, 'payload', e.payload, 'created_at', e.created_at) order by e.id desc), '[]'::jsonb)
  into v_ticker
  from (
    select * from public.events ev
    where ev.game_id = p_game.id
    order by ev.id desc
    limit 20
  ) e;

  if p_player is not null then
    select jsonb_build_object(
             'player_id', p.id, 'name', p.name, 'color', p.color,
             'entries', coalesce((
               select jsonb_agg(jsonb_build_object('cell', en.cell, 'digit', en.digit) order by en.cell)
               from public.entries en
               where en.round_id = p_game.current_round_id and en.player_id = p.id), '[]'::jsonb),
             'err_window_count', p.err_window_count,
             'err_window_started_at', p.err_window_started_at,
             'locked_until', p.locked_until,
             'hunt', (
               select jsonb_build_object(
                        'lines_label', h.lines_label, 'kind', h.kind,
                        'started_at', h.started_at, 'min_press_at', h.min_press_at,
                        'deadline', h.deadline)
               from public.hunts h
               where h.id = p.active_hunt_id and h.status = 'active'),
             'sips_to_distribute', p.sips_to_distribute,
             'sips_to_drink', p.sips_to_drink,
             'sip_senders', coalesce((
               select jsonb_agg(jsonb_build_object('from_player', s.from_player, 'amount', s.amount))
               from (
                 select t.from_player, sum(t.amount)::int as amount
                 from public.sip_transfers t
                 where t.game_id = p_game.id and t.round_no = p_game.round_no and t.to_player = p.id
                 group by t.from_player
               ) s), '[]'::jsonb),
             'ready', p.ready,
             'balloons_allowed', p.hunts_success,
             'cash_cents', p.cash_cents)
    into v_me
    from public.players p
    where p.id = p_player;
  end if;

  return jsonb_build_object(
    'ok', true,
    'server_now', now(),
    'palette', public.palette(),
    'game', jsonb_build_object(
      'id', p_game.id, 'code', p_game.code, 'phase', p_game.phase, 'version', p_game.version,
      'config', cfg, 'trial_done', p_game.trial_done, 'round_no', p_game.round_no,
      'main_started_at', p_game.main_started_at, 'phase_started_at', p_game.phase_started_at,
      'phase_deadline', p_game.phase_deadline, 'hunts_started', p_game.hunts_started,
      'balloons_left', (cfg ->> 'balloons_total')::int - p_game.hunts_started,
      'elapsed_s', case when p_game.main_started_at is not null
                        then extract(epoch from now() - p_game.main_started_at)::int end),
    'round', v_round,
    'lines', v_lines,
    'players', v_players,
    'hunts_active', v_hunts,
    'sip_transfers', v_transfers,
    'ticker', v_ticker,
    'me', v_me
  );
end;
$$;

revoke all on function public.default_config() from public, anon, authenticated;
revoke all on function public.palette() from public, anon, authenticated;
revoke all on function public.merge_config(jsonb) from public, anon, authenticated;
revoke all on function public.game_id_by_code(text) from public, anon, authenticated;
revoke all on function public.hash_token(text) from public, anon, authenticated;
revoke all on function public.player_by_token(uuid, text) from public, anon, authenticated;
revoke all on function public.pin_is_valid(uuid, text) from public, anon, authenticated;
revoke all on function public.bump_version(uuid) from public, anon, authenticated;
revoke all on function public.add_event(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.build_state(public.games, uuid) from public, anon, authenticated;
