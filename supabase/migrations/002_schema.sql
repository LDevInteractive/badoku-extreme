-- Badoku-Extreme - Migration 002: game tables (CLAUDE.md section 6.1)
-- Run after 001_puzzles.sql. All tables are locked down in 003_security.sql.

create table public.games (
  id                uuid primary key default gen_random_uuid(),
  code              text not null check (code ~ '^[0-9]{4}$'),
  phase             text not null default 'lobby' check (phase in (
                      'lobby', 'trial_running', 'trial_ending',
                      'round_running', 'round_ending',
                      'break_distribute', 'break_drink',
                      'cashout', 'tiebreak', 'results')),
  version           bigint not null default 1,
  config            jsonb not null,
  trial_done        boolean not null default false,
  round_no          int not null default 0,
  current_round_id  uuid,
  main_started_at   timestamptz,
  phase_started_at  timestamptz not null default now(),
  phase_deadline    timestamptz,
  hunts_started     int not null default 0,
  created_at        timestamptz not null default now()
);

-- A code is unique among games that are not finished; finished games free it again.
create unique index games_open_code_idx on public.games (code) where phase <> 'results';
create index games_code_idx on public.games (code, created_at desc);

create table public.game_secrets (
  game_id        uuid primary key references public.games (id) on delete cascade,
  host_pin_hash  text not null
);

create table public.players (
  id                        uuid primary key default gen_random_uuid(),
  game_id                   uuid not null references public.games (id) on delete cascade,
  name                      text not null,
  color                     text not null,
  seat_no                   int not null,
  joined_at                 timestamptz not null default now(),
  locked_until              timestamptz,
  err_window_started_at     timestamptz,
  err_window_count          int not null default 0,
  active_hunt_id            uuid,
  lines_claimed             int not null default 0,
  hunts_started             int not null default 0,
  hunts_success             int not null default 0,
  errors_total              int not null default 0,
  locks_total               int not null default 0,
  sips_to_distribute        int not null default 0,
  sips_to_drink             int not null default 0,
  sips_given_total          int not null default 0,
  sips_received_total       int not null default 0,
  ready                     boolean not null default false,
  cash_cents                int,
  cash_submitted_at         timestamptz,
  tiebreak_group            int,
  tiebreak_correct          int not null default 0,
  tiebreak_last_correct_at  timestamptz,
  tiebreak_finished_at      timestamptz,
  final_rank                int,
  rank_by_lot               boolean not null default false,
  unique (game_id, name),
  unique (game_id, color)
);

-- "Anna" and "anna" would be the same person on the TV.
create unique index players_game_lower_name_idx on public.players (game_id, lower(name));

create table public.player_secrets (
  player_id   uuid primary key references public.players (id) on delete cascade,
  token_hash  text not null unique
);

create table public.rounds (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references public.games (id) on delete cascade,
  kind        text not null check (kind in ('trial', 'main', 'tiebreak')),
  round_no    int not null default 0,
  puzzle_id   uuid not null references public.puzzles (id),
  size        int not null check (size in (4, 6, 9)),
  givens      text not null,
  revealed    text not null,
  started_at  timestamptz not null default now(),
  deadline    timestamptz,
  ended_at    timestamptz
);

create index rounds_game_idx on public.rounds (game_id);
create index rounds_puzzle_idx on public.rounds (puzzle_id);

alter table public.games
  add constraint games_current_round_fk
  foreign key (current_round_id) references public.rounds (id) on delete set null;
create index games_current_round_idx on public.games (current_round_id);

create table public.lines (
  id           uuid primary key default gen_random_uuid(),
  round_id     uuid not null references public.rounds (id) on delete cascade,
  game_id      uuid not null references public.games (id) on delete cascade,
  line_type    text not null check (line_type in ('row', 'col')),
  idx          int not null,
  status       text not null check (status in ('claimed', 'neutral')),
  player_id    uuid references public.players (id) on delete cascade,
  claimed_at   timestamptz not null default now(),
  origin_cell  int,
  digits       text not null,
  unique (round_id, line_type, idx)
);

create index lines_game_idx on public.lines (game_id);
create index lines_player_idx on public.lines (player_id);

create table public.entries (
  round_id    uuid not null references public.rounds (id) on delete cascade,
  player_id   uuid not null references public.players (id) on delete cascade,
  cell        int not null,
  digit       int not null,
  entered_at  timestamptz not null default now(),
  primary key (round_id, player_id, cell)
);

create index entries_player_idx on public.entries (player_id);

create table public.hunts (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid not null references public.games (id) on delete cascade,
  round_id      uuid not null references public.rounds (id) on delete cascade,
  player_id     uuid not null references public.players (id) on delete cascade,
  kind          text not null check (kind in ('main', 'trial')),
  lines_label   text not null,
  started_at    timestamptz not null default now(),
  min_press_at  timestamptz not null,
  deadline      timestamptz not null,
  status        text not null default 'active' check (status in ('active', 'success', 'failed')),
  pressed_at    timestamptz
);

create index hunts_game_idx on public.hunts (game_id);
create index hunts_round_idx on public.hunts (round_id);
create index hunts_player_idx on public.hunts (player_id);

alter table public.players
  add constraint players_active_hunt_fk
  foreign key (active_hunt_id) references public.hunts (id) on delete set null;
create index players_active_hunt_idx on public.players (active_hunt_id);

create table public.sip_transfers (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references public.games (id) on delete cascade,
  round_no     int not null,
  from_player  uuid not null references public.players (id) on delete cascade,
  to_player    uuid not null references public.players (id) on delete cascade,
  amount       int not null check (amount > 0),
  is_random    boolean not null default false,
  created_at   timestamptz not null default now()
);

create index sip_transfers_game_idx on public.sip_transfers (game_id, round_no);
create index sip_transfers_from_idx on public.sip_transfers (from_player);
create index sip_transfers_to_idx on public.sip_transfers (to_player);

create table public.events (
  id          bigserial primary key,
  game_id     uuid not null references public.games (id) on delete cascade,
  type        text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index events_game_idx on public.events (game_id, id desc);
