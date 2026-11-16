-- Online multiplayer rooms use server-side Edge Function access only.
create table if not exists public.online_rooms (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  host_id uuid not null,
  status text not null default 'waiting' check (status in ('waiting','playing','finished')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);
create table if not exists public.online_players (
  room_id uuid not null references public.online_rooms(id) on delete cascade,
  user_id uuid not null,
  color text not null check (color in ('w','b')),
  display_name text not null check (char_length(display_name) between 1 and 24),
  joined_at timestamptz not null default now(),
  primary key (room_id,user_id),
  unique (room_id,color)
);
create table if not exists public.online_game_state (
  room_id uuid primary key references public.online_rooms(id) on delete cascade,
  fen text not null,
  pgn text not null default '',
  moves jsonb not null default '[]'::jsonb,
  version bigint not null default 0 check (version >= 0),
  result text,
  updated_at timestamptz not null default now()
);
alter table public.online_rooms enable row level security;
alter table public.online_players enable row level security;
alter table public.online_game_state enable row level security;
revoke all on public.online_rooms, public.online_players, public.online_game_state from anon, authenticated;
grant select on public.online_players to authenticated;
drop policy if exists "online players can read own membership" on public.online_players;
create policy "online players can read own membership"
on public.online_players for select to authenticated
using ((select auth.uid()) = user_id);
drop policy if exists "online members can receive room realtime" on realtime.messages;
create policy "online members can receive room realtime"
on realtime.messages for select to authenticated
using (
  realtime.messages.extension in ('broadcast','presence')
  and exists (
    select 1 from public.online_players p
    where p.user_id = (select auth.uid())
      and p.room_id::text = split_part((select realtime.topic()), ':', 2)
  )
);
drop policy if exists "online members can send room realtime" on realtime.messages;
create policy "online members can send room realtime"
on realtime.messages for insert to authenticated
with check (
  realtime.messages.extension in ('broadcast','presence')
  and exists (
    select 1 from public.online_players p
    where p.user_id = (select auth.uid())
      and p.room_id::text = split_part((select realtime.topic()), ':', 2)
  )
);
