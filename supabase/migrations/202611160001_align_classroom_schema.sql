-- Preserve the previous Classroom schema before installing the schema used by the current app.
DO $$
DECLARE
  legacy_table text;
BEGIN
  IF to_regclass('public.classroom_rooms') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='classroom_rooms' AND column_name='host_id'
     )
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='classroom_rooms' AND column_name='owner_id'
     ) THEN
    ALTER TABLE public.classroom_rooms RENAME TO classroom_legacy_rooms;
    IF to_regclass('public.classroom_members') IS NOT NULL THEN
      ALTER TABLE public.classroom_members RENAME TO classroom_legacy_members;
    END IF;
    IF to_regclass('public.classroom_state') IS NOT NULL THEN
      ALTER TABLE public.classroom_state RENAME TO classroom_legacy_state;
    END IF;
    IF to_regclass('public.classroom_messages') IS NOT NULL THEN
      ALTER TABLE public.classroom_messages RENAME TO classroom_legacy_messages;
    END IF;
    IF to_regclass('public.classroom_games') IS NOT NULL THEN
      ALTER TABLE public.classroom_games RENAME TO classroom_legacy_games;
    END IF;
  END IF;

  FOREACH legacy_table IN ARRAY ARRAY[
    'classroom_legacy_rooms','classroom_legacy_members','classroom_legacy_state',
    'classroom_legacy_messages','classroom_legacy_games'
  ] LOOP
    IF to_regclass('public.' || legacy_table) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', legacy_table);
    END IF;
  END LOOP;
END $$;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

create table if not exists public.classroom_rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null check (char_length(name) between 1 and 80),
  locked boolean not null default false,
  closed boolean not null default false,
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.classroom_room_secrets (
  room_id uuid primary key references public.classroom_rooms(id) on delete cascade,
  invite_code_hash text not null unique,
  password_hash text
);

create table if not exists public.classroom_room_members (
  room_id uuid not null references public.classroom_rooms(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'student' check (role in ('host', 'student')),
  permission text not null default 'view' check (permission in ('view', 'white', 'black', 'both', 'control')),
  display_name text not null check (char_length(display_name) between 1 and 24),
  avatar_data_url text not null default '' check (char_length(avatar_data_url) <= 32768),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id),
  check ((role = 'host' and permission = 'control') or role = 'student')
);

create index if not exists classroom_room_members_user_idx
  on public.classroom_room_members (user_id, room_id);

create table if not exists public.classroom_room_games (
  id uuid primary key,
  room_id uuid not null references public.classroom_rooms(id) on delete cascade,
  created_by uuid not null,
  start_fen text not null,
  final_fen text not null,
  pgn text not null default '',
  moves jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists classroom_room_games_room_idx
  on public.classroom_room_games (room_id, created_at desc);

create table if not exists public.classroom_room_state (
  room_id uuid primary key references public.classroom_rooms(id) on delete cascade,
  fen text not null,
  pgn text not null default '',
  moves jsonb not null default '[]'::jsonb,
  redo_stack jsonb not null default '[]'::jsonb,
  orientation text not null default 'w' check (orientation in ('w', 'b')),
  selected_ply integer not null default 0 check (selected_ply >= 0),
  annotations jsonb not null default '[]'::jsonb,
  version bigint not null default 0 check (version >= 0),
  current_game_id uuid not null references public.classroom_room_games(id),
  selected_game_id uuid not null references public.classroom_room_games(id),
  published_analysis jsonb,
  last_event_id uuid,
  updated_at timestamptz not null default now()
);

create table if not exists public.classroom_room_messages (
  id uuid primary key,
  room_id uuid not null references public.classroom_rooms(id) on delete cascade,
  user_id uuid not null,
  display_name text not null,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists classroom_room_messages_room_idx
  on public.classroom_room_messages (room_id, created_at desc);

alter table public.classroom_rooms enable row level security;
alter table public.classroom_room_members enable row level security;
alter table public.classroom_room_games enable row level security;
alter table public.classroom_room_state enable row level security;
alter table public.classroom_room_messages enable row level security;
alter table public.classroom_room_secrets enable row level security;

create or replace function private.is_classroom_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
  select 1
  from public.classroom_room_members m
  join public.classroom_rooms r on r.id = m.room_id
  where m.room_id = p_room_id and m.user_id = auth.uid()
    and not r.closed and r.expires_at > now()
  );
$$;

drop policy if exists "Room members can read their rooms" on public.classroom_rooms;
create policy "Room members can read their rooms"
  on public.classroom_rooms for select to authenticated
  using (private.is_classroom_member(classroom_rooms.id));

drop policy if exists "Room members can read their membership" on public.classroom_room_members;
create policy "Room members can read their membership"
  on public.classroom_room_members for select to authenticated
  using (private.is_classroom_member(classroom_room_members.room_id));

drop policy if exists "Room members can read shared games" on public.classroom_room_games;
create policy "Room members can read shared games"
  on public.classroom_room_games for select to authenticated
  using (private.is_classroom_member(classroom_room_games.room_id));

drop policy if exists "Room members can read shared state" on public.classroom_room_state;
create policy "Room members can read shared state"
  on public.classroom_room_state for select to authenticated
  using (private.is_classroom_member(classroom_room_state.room_id));

drop policy if exists "Room members can read chat" on public.classroom_room_messages;
create policy "Room members can read chat"
  on public.classroom_room_messages for select to authenticated
  using (private.is_classroom_member(classroom_room_messages.room_id));

drop policy if exists "Room members can receive private realtime messages" on realtime.messages;
create policy "Room members can receive private realtime messages"
  on realtime.messages for select to authenticated
  using (
    extension in ('broadcast', 'presence')
    and exists (
      select 1 from public.classroom_room_members m
      where m.user_id = (select auth.uid())
        and realtime.topic() = 'classroom:' || m.room_id::text
    )
  );

drop policy if exists "Room members can publish presence and untrusted signals" on realtime.messages;
create policy "Room members can publish presence and untrusted signals"
  on realtime.messages for insert to authenticated
  with check (
    extension in ('broadcast', 'presence')
    and exists (
      select 1 from public.classroom_room_members m
      where m.user_id = (select auth.uid())
        and realtime.topic() = 'classroom:' || m.room_id::text
    )
  );

create or replace function public.create_classroom_room(
  p_room_id uuid,
  p_owner_id uuid,
  p_name text,
  p_invite_code_hash text,
  p_password_hash text,
  p_game_id uuid,
  p_start_fen text,
  p_display_name text,
  p_avatar_data_url text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  if char_length(trim(p_name)) not between 1 and 80
    or char_length(p_invite_code_hash) <> 64
    or char_length(p_start_fen) > 200
    or char_length(trim(p_display_name)) not between 1 and 24
    or char_length(p_avatar_data_url) > 32768 then
    raise exception 'INVALID_ROOM';
  end if;

  insert into public.classroom_rooms (id, owner_id, name)
  values (p_room_id, p_owner_id, trim(p_name));
  insert into public.classroom_room_secrets (room_id, invite_code_hash, password_hash)
  values (p_room_id, p_invite_code_hash, p_password_hash);
  insert into public.classroom_room_members (
    room_id, user_id, role, permission, display_name, avatar_data_url
  ) values (p_room_id, p_owner_id, 'host', 'control', trim(p_display_name), p_avatar_data_url);
  insert into public.classroom_room_games (id, room_id, created_by, start_fen, final_fen)
  values (p_game_id, p_room_id, p_owner_id, p_start_fen, p_start_fen);
  insert into public.classroom_room_state (
    room_id, fen, current_game_id, selected_game_id
  ) values (p_room_id, p_start_fen, p_game_id, p_game_id);
end;
$$;

create or replace function public.join_classroom_room(
  p_room_id uuid,
  p_user_id uuid,
  p_display_name text,
  p_avatar_data_url text,
  p_invitation_verified boolean
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.classroom_rooms%rowtype;
  v_existing boolean;
  v_count integer;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  select * into v_room from public.classroom_rooms where id = p_room_id for update;
  if not found or v_room.closed or v_room.expires_at <= now() then
    raise exception 'ROOM_NOT_FOUND';
  end if;
  select exists (
    select 1 from public.classroom_room_members
    where room_id = p_room_id and user_id = p_user_id
  ) into v_existing;
  if not v_existing then
    if not p_invitation_verified then raise exception 'ROOM_NOT_FOUND'; end if;
    if v_room.locked then raise exception 'ROOM_LOCKED'; end if;
    select count(*) into v_count from public.classroom_room_members where room_id = p_room_id;
    if v_count >= 64 then raise exception 'ROOM_FULL'; end if;
    insert into public.classroom_room_members (
      room_id, user_id, display_name, avatar_data_url
    ) values (p_room_id, p_user_id, trim(p_display_name), p_avatar_data_url);
  else
    update public.classroom_room_members set
      display_name = trim(p_display_name),
      avatar_data_url = p_avatar_data_url
      where room_id = p_room_id and user_id = p_user_id;
  end if;
end;
$$;

create or replace function public.commit_classroom_action(
  p_room_id uuid,
  p_actor_id uuid,
  p_base_version bigint,
  p_event_id uuid,
  p_action text,
  p_state jsonb,
  p_payload jsonb default '{}'::jsonb
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.classroom_rooms%rowtype;
  v_state public.classroom_room_state%rowtype;
  v_member public.classroom_room_members%rowtype;
  v_target uuid;
  v_move_color text;
  v_allowed_permission text;
  v_next_version bigint;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  select * into v_room from public.classroom_rooms where id = p_room_id for update;
  if not found or v_room.closed or v_room.expires_at <= now() then
    raise exception 'ROOM_CLOSED';
  end if;
  select * into v_state from public.classroom_room_state where room_id = p_room_id for update;
  select * into v_member from public.classroom_room_members
    where room_id = p_room_id and user_id = p_actor_id for update;
  if not found then
    raise exception 'MEMBERSHIP_REQUIRED';
  end if;
  if v_state.last_event_id = p_event_id then
    return v_state.version;
  end if;
  if v_state.version <> p_base_version then
    raise exception 'STALE_VERSION';
  end if;

  if p_action = 'move' then
    v_move_color := split_part(v_state.fen, ' ', 2);
    v_allowed_permission := case when v_move_color = 'w' then 'white' else 'black' end;
    if v_member.role <> 'host'
      and v_member.permission not in ('control', 'both', v_allowed_permission) then
      raise exception 'MOVE_NOT_PERMITTED';
    end if;
  elsif p_action <> 'annotation' and v_member.role <> 'host' then
    raise exception 'HOST_ONLY';
  end if;

  if p_action in ('reset', 'load', 'select_game', 'close') then
    insert into public.classroom_room_games (
      id, room_id, created_by, start_fen, final_fen, pgn, moves, created_at, updated_at
    )
    select current_game_id, room_id, p_actor_id,
      (select g.start_fen from public.classroom_room_games g where g.id = current_game_id),
      fen, pgn, moves, now(), now()
    from public.classroom_room_state
    where room_id = p_room_id
    on conflict (id) do update set
      final_fen = excluded.final_fen,
      pgn = excluded.pgn,
      moves = excluded.moves,
      updated_at = now();
  end if;
  if p_action in ('reset', 'load') then
    insert into public.classroom_room_games (id, room_id, created_by, start_fen, final_fen, pgn, moves)
    values (
      (p_state->>'current_game_id')::uuid,
      p_room_id,
      p_actor_id,
      p_state->>'fen',
      p_state->>'fen',
      p_state->>'pgn',
      p_state->'moves'
    );
  end if;

  if p_action = 'permissions' then
    v_target := nullif(p_payload->>'participantId', '')::uuid;
    if p_payload->>'permission' not in ('view', 'white', 'black', 'both', 'control')
      or v_target is null then
      raise exception 'INVALID_PERMISSION';
    end if;
    update public.classroom_room_members
      set permission = p_payload->>'permission'
      where room_id = p_room_id and user_id = v_target and role = 'student';
    if not found then raise exception 'PARTICIPANT_NOT_FOUND'; end if;
  elsif p_action = 'remove' then
    v_target := nullif(p_payload->>'participantId', '')::uuid;
    delete from public.classroom_room_members
      where room_id = p_room_id and user_id = v_target and role = 'student';
    if not found then raise exception 'PARTICIPANT_NOT_FOUND'; end if;
  elsif p_action = 'transfer' then
    v_target := nullif(p_payload->>'participantId', '')::uuid;
    if v_target is null or not exists (
      select 1 from public.classroom_room_members
      where room_id = p_room_id and user_id = v_target and role = 'student'
    ) then raise exception 'PARTICIPANT_NOT_FOUND'; end if;
    update public.classroom_room_members
      set role = 'student', permission = 'view'
      where room_id = p_room_id and user_id = v_room.owner_id;
    update public.classroom_room_members
      set role = 'host', permission = 'control'
      where room_id = p_room_id and user_id = v_target;
    update public.classroom_rooms set owner_id = v_target where id = p_room_id;
  elsif p_action = 'lock' then
    if jsonb_typeof(p_payload->'locked') <> 'boolean' then raise exception 'INVALID_LOCK_STATE'; end if;
    update public.classroom_rooms set locked = (p_payload->>'locked')::boolean where id = p_room_id;
  elsif p_action = 'close' then
    update public.classroom_rooms set closed = true where id = p_room_id;
  elsif p_action = 'publish_analysis' then
    if p_state->'published_analysis' is not null
      and octet_length(p_state->'published_analysis'::text) > 12000 then
      raise exception 'INVALID_ANALYSIS';
    end if;
  elsif p_action not in (
    'move', 'undo', 'redo', 'reset', 'load', 'navigate', 'orientation',
    'annotation', 'select_game', 'publish_analysis', 'lock', 'close',
    'permissions', 'remove', 'transfer'
  ) then
    raise exception 'UNKNOWN_ACTION';
  end if;

  if jsonb_typeof(p_state->'moves') <> 'array'
    or jsonb_typeof(p_state->'annotations') <> 'array'
    or jsonb_typeof(p_state->'redo_stack') <> 'array'
    or char_length(coalesce(p_state->>'fen', '')) > 200
    or char_length(coalesce(p_state->>'pgn', '')) > 100000
    or jsonb_array_length(p_state->'annotations') > 128 then
    raise exception 'INVALID_STATE';
  end if;
  update public.classroom_room_state set
    fen = p_state->>'fen',
    pgn = p_state->>'pgn',
    moves = p_state->'moves',
    redo_stack = p_state->'redo_stack',
    orientation = p_state->>'orientation',
    selected_ply = (p_state->>'selected_ply')::integer,
    annotations = p_state->'annotations',
    current_game_id = (p_state->>'current_game_id')::uuid,
    selected_game_id = (p_state->>'selected_game_id')::uuid,
    published_analysis = p_state->'published_analysis',
    version = version + 1,
    last_event_id = p_event_id,
    updated_at = now()
    where room_id = p_room_id
    returning version into v_next_version;

  update public.classroom_room_games set
    final_fen = p_state->>'fen',
    pgn = p_state->>'pgn',
    moves = p_state->'moves',
    updated_at = now()
    where id = (p_state->>'current_game_id')::uuid;
  update public.classroom_rooms set updated_at = now() where id = p_room_id;
  return v_next_version;
end;
$$;

create or replace function public.create_classroom_message(
  p_room_id uuid,
  p_user_id uuid,
  p_message_id uuid,
  p_body text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  select display_name into v_name from public.classroom_room_members
    where room_id = p_room_id and user_id = p_user_id;
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
  if char_length(trim(p_body)) not between 1 and 1000 then raise exception 'INVALID_MESSAGE'; end if;
  insert into public.classroom_room_messages (id, room_id, user_id, display_name, body)
  values (p_message_id, p_room_id, p_user_id, v_name, trim(p_body))
  on conflict (id) do nothing;
end;
$$;

revoke all on function public.create_classroom_room(uuid, uuid, text, text, text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.join_classroom_room(uuid, uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.commit_classroom_action(uuid, uuid, bigint, uuid, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.create_classroom_message(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.is_classroom_member(uuid) from public, anon;
grant execute on function private.is_classroom_member(uuid) to authenticated, service_role;
grant execute on function private.is_classroom_member(uuid) to authenticated;
grant execute on function public.create_classroom_room(uuid, uuid, text, text, text, uuid, text, text, text) to service_role;
grant execute on function public.join_classroom_room(uuid, uuid, text, text, boolean) to service_role;
grant execute on function public.commit_classroom_action(uuid, uuid, bigint, uuid, text, jsonb, jsonb) to service_role;
grant execute on function public.create_classroom_message(uuid, uuid, uuid, text) to service_role;

revoke all on public.classroom_rooms, public.classroom_room_members,
  public.classroom_room_games, public.classroom_room_state, public.classroom_room_messages
  from public, anon, authenticated;
grant select on public.classroom_rooms, public.classroom_room_members,
  public.classroom_room_games, public.classroom_room_state, public.classroom_room_messages
  to authenticated;
revoke all on public.classroom_room_secrets from public, anon, authenticated;
grant all on public.classroom_rooms, public.classroom_room_secrets,
  public.classroom_room_members, public.classroom_room_games,
  public.classroom_room_state, public.classroom_room_messages to service_role;


-- The Edge Function uses the service role. Browser clients only need a member lookup
-- for private Realtime authorization; RLS still restricts it to the caller's rooms.
REVOKE ALL ON TABLE
  public.classroom_rooms,
  public.classroom_room_members,
  public.classroom_room_games,
  public.classroom_room_state,
  public.classroom_room_messages,
  public.classroom_room_secrets
FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE
  public.classroom_rooms,
  public.classroom_room_members,
  public.classroom_room_games,
  public.classroom_room_state,
  public.classroom_room_messages,
  public.classroom_room_secrets
TO service_role;

GRANT SELECT ON TABLE public.classroom_room_members TO authenticated;

GRANT EXECUTE ON FUNCTION public.create_classroom_room(uuid, uuid, text, text, text, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.join_classroom_room(uuid, uuid, text, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_classroom_action(uuid, uuid, bigint, uuid, text, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_classroom_message(uuid, uuid, uuid, text) TO service_role;

-- Retire the old SECURITY DEFINER RPCs from the previous schema.
DO $$
BEGIN
  IF to_regprocedure('public.create_classroom_room(text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.create_classroom_room(text) FROM PUBLIC, anon, authenticated;
  END IF;
  IF to_regprocedure('public.join_classroom_room(text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.join_classroom_room(text) FROM PUBLIC, anon, authenticated;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.is_classroom_member(uuid);

CREATE INDEX IF NOT EXISTS classroom_rooms_owner_idx ON public.classroom_rooms(owner_id);
CREATE INDEX IF NOT EXISTS classroom_room_messages_user_idx ON public.classroom_room_messages(user_id);
CREATE INDEX IF NOT EXISTS classroom_room_games_white_user_idx ON public.classroom_room_games(white_user_id);
CREATE INDEX IF NOT EXISTS classroom_room_games_black_user_idx ON public.classroom_room_games(black_user_id);
CREATE INDEX IF NOT EXISTS classroom_room_state_updated_by_idx ON public.classroom_room_state(updated_by);
