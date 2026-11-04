-- Badoku-Extreme - Migration 006: Realtime (CLAUDE.md section 5.1)
-- Clients subscribe to their games row only and reload the snapshot on a version change.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'games'
  ) then
    alter publication supabase_realtime add table public.games;
  end if;
end;
$$;
