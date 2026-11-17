create or replace function public.online_create_room(
  p_room_id uuid,
  p_code_hash text,
  p_user_id uuid,
  p_display_name text,
  p_initial_fen text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_room_id is null or p_user_id is null or p_code_hash is null
    or p_display_name is null or p_initial_fen is null
    or p_code_hash !~ '^[0-9a-f]{64}$'
    or char_length(trim(p_display_name)) not between 1 and 24
    or char_length(p_initial_fen) not between 1 and 200 then
    raise exception 'INVALID_ROOM';
  end if;

  insert into public.online_rooms (id, code_hash, host_id)
    values (p_room_id, p_code_hash, p_user_id);
  insert into public.online_players (room_id, user_id, color, display_name)
    values (p_room_id, p_user_id, 'w', trim(p_display_name));
  insert into public.online_game_state (room_id, fen)
    values (p_room_id, p_initial_fen);
end;
$$;

create or replace function public.online_join_room(
  p_room_id uuid,
  p_user_id uuid,
  p_display_name text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.online_rooms%rowtype;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_room_id is null or p_user_id is null or p_display_name is null
    or char_length(trim(p_display_name)) not between 1 and 24 then
    raise exception 'INVALID_ROOM';
  end if;

  select * into v_room
    from public.online_rooms
    where id = p_room_id
    for update;
  if not found or v_room.expires_at <= now() then
    raise exception 'ROOM_NOT_FOUND';
  end if;
  if exists (
    select 1 from public.online_players
    where room_id = p_room_id and user_id = p_user_id
  ) then
    return;
  end if;
  if v_room.status <> 'waiting' or exists (
    select 1 from public.online_players
    where room_id = p_room_id and color = 'b'
  ) then
    raise exception 'ROOM_FULL';
  end if;

  insert into public.online_players (room_id, user_id, color, display_name)
    values (p_room_id, p_user_id, 'b', trim(p_display_name));
  update public.online_rooms
    set status = 'playing', updated_at = now()
    where id = p_room_id;
end;
$$;

create or replace function public.online_resign_room(
  p_room_id uuid,
  p_user_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.online_rooms%rowtype;
  v_state public.online_game_state%rowtype;
  v_player public.online_players%rowtype;
  v_winner text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  select * into v_room
    from public.online_rooms
    where id = p_room_id
    for update;
  if not found or v_room.expires_at <= now() then
    raise exception 'ROOM_NOT_FOUND';
  end if;
  select * into v_player
    from public.online_players
    where room_id = p_room_id and user_id = p_user_id;
  if not found then
    raise exception 'NOT_A_PLAYER';
  end if;
  select * into v_state
    from public.online_game_state
    where room_id = p_room_id
    for update;
  if v_room.status <> 'playing' or v_state.result is not null then
    raise exception 'GAME_NOT_ACTIVE';
  end if;

  v_winner := case when v_player.color = 'w' then 'Black' else 'White' end;
  update public.online_game_state
    set result = v_winner || ' wins by resignation',
        version = version + 1,
        updated_at = now()
    where room_id = p_room_id;
  update public.online_rooms
    set status = 'finished', updated_at = now()
    where id = p_room_id;
end;
$$;

create or replace function public.online_commit_move(
  p_room_id uuid,
  p_expected_version bigint,
  p_fen text,
  p_pgn text,
  p_moves jsonb,
  p_result text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.online_rooms%rowtype;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_room_id is null or p_expected_version is null or p_fen is null
    or p_pgn is null or p_moves is null or jsonb_typeof(p_moves) <> 'array'
    or char_length(p_fen) not between 1 and 200 then
    raise exception 'INVALID_MOVE';
  end if;

  select * into v_room
    from public.online_rooms
    where id = p_room_id
    for update;
  if not found or v_room.expires_at <= now() then
    raise exception 'ROOM_NOT_FOUND';
  end if;
  if v_room.status <> 'playing' then
    raise exception 'GAME_NOT_ACTIVE';
  end if;

  update public.online_game_state
    set fen = p_fen,
        pgn = p_pgn,
        moves = p_moves,
        result = p_result,
        version = p_expected_version + 1,
        updated_at = now()
    where room_id = p_room_id and version = p_expected_version;
  if not found then
    raise exception 'STALE_VERSION';
  end if;

  if p_result is not null then
    update public.online_rooms
      set status = 'finished', updated_at = now()
      where id = p_room_id;
  end if;
end;
$$;

revoke all on function public.online_create_room(uuid, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.online_join_room(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.online_resign_room(uuid, uuid) from public, anon, authenticated;
revoke all on function public.online_commit_move(uuid, bigint, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.online_create_room(uuid, text, uuid, text, text) to service_role;
grant execute on function public.online_join_room(uuid, uuid, text) to service_role;
grant execute on function public.online_resign_room(uuid, uuid) to service_role;
grant execute on function public.online_commit_move(uuid, bigint, text, text, jsonb, text) to service_role;
