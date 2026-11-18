-- Respect the host's selected color in Supabase-backed online rooms.
-- The guest is always assigned the opposite color under the same room lock.
create or replace function public.online_create_room(
  p_room_id uuid,
  p_code_hash text,
  p_user_id uuid,
  p_display_name text,
  p_initial_fen text,
  p_host_color text default 'random'
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_host_color text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_room_id is null or p_user_id is null or p_code_hash is null
    or p_display_name is null or p_initial_fen is null
    or p_code_hash !~ '^[0-9a-f]{64}$'
    or char_length(trim(p_display_name)) not between 1 and 24
    or char_length(p_initial_fen) not between 1 and 200
    or coalesce(p_host_color, 'random') not in ('w', 'b', 'random') then
    raise exception 'INVALID_ROOM';
  end if;

  v_host_color := case
    when p_host_color = 'w' then 'w'
    when p_host_color = 'b' then 'b'
    when random() < 0.5 then 'w'
    else 'b'
  end;

  insert into public.online_rooms (id, code_hash, host_id)
    values (p_room_id, p_code_hash, p_user_id);
  insert into public.online_players (room_id, user_id, color, display_name)
    values (p_room_id, p_user_id, v_host_color, trim(p_display_name));
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
  v_host_color text;
  v_guest_color text;
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
  select color into v_host_color
    from public.online_players
    where room_id = p_room_id and user_id = v_room.host_id;
  if v_host_color is null then raise exception 'ROOM_NOT_FOUND'; end if;
  if v_room.status <> 'waiting' or exists (
    select 1 from public.online_players
    where room_id = p_room_id and color = case when v_host_color = 'w' then 'b' else 'w' end
  ) then
    raise exception 'ROOM_FULL';
  end if;

  v_guest_color := case when v_host_color = 'w' then 'b' else 'w' end;
  insert into public.online_players (room_id, user_id, color, display_name)
    values (p_room_id, p_user_id, v_guest_color, trim(p_display_name));
  update public.online_rooms
    set status = 'playing', updated_at = now()
    where id = p_room_id;
end;
$$;

revoke all on function public.online_create_room(uuid, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.online_create_room(uuid, text, uuid, text, text, text) to service_role;
