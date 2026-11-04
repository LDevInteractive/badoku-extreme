-- Badoku-Extreme - Migration 003: access rules (CLAUDE.md section 5.2)
-- RLS on every table. The only readable table is games, for Realtime; it holds
-- nothing secret. Everything else is reachable through RPC functions only.

alter table public.games          enable row level security;
alter table public.game_secrets   enable row level security;
alter table public.players        enable row level security;
alter table public.player_secrets enable row level security;
alter table public.rounds         enable row level security;
alter table public.lines          enable row level security;
alter table public.entries        enable row level security;
alter table public.hunts          enable row level security;
alter table public.sip_transfers  enable row level security;
alter table public.events         enable row level security;

revoke all on table
  public.games, public.game_secrets, public.players, public.player_secrets,
  public.rounds, public.lines, public.entries, public.hunts,
  public.sip_transfers, public.events
from anon, authenticated;

revoke all on sequence public.events_id_seq from anon, authenticated;

grant select on table public.games to anon, authenticated;

create policy games_read on public.games
  for select to anon, authenticated
  using (true);
