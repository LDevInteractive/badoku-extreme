-- Badoku-Extreme - Migration 000: smoke-test RPC
-- Run in the Supabase SQL editor before 001_schema.sql.
-- Returns the server clock so index.html can verify the connection and
-- measure the clock offset (CLAUDE.md sections 5.5 and 8).

create or replace function public.server_time()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object('ok', true, 'server_now', now());
$$;

revoke all on function public.server_time() from public;
grant execute on function public.server_time() to anon, authenticated;
