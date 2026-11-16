-- Remove stale policies and RPCs from the retired Classroom schema.
DROP POLICY IF EXISTS "members can create classroom games" ON public.classroom_legacy_games;
DROP POLICY IF EXISTS "members can read classroom games" ON public.classroom_legacy_games;
DROP POLICY IF EXISTS "members can update classroom games" ON public.classroom_legacy_games;
DROP POLICY IF EXISTS "members can view room members" ON public.classroom_legacy_members;
DROP POLICY IF EXISTS "members can read classroom messages" ON public.classroom_legacy_messages;
DROP POLICY IF EXISTS "members can send classroom messages" ON public.classroom_legacy_messages;
DROP POLICY IF EXISTS "room members can view rooms" ON public.classroom_legacy_rooms;
DROP POLICY IF EXISTS "members can read classroom state" ON public.classroom_legacy_state;
DROP POLICY IF EXISTS "members can update classroom state" ON public.classroom_legacy_state;
DROP POLICY IF EXISTS "room members can receive realtime" ON realtime.messages;
DROP POLICY IF EXISTS "room members can send realtime" ON realtime.messages;

DROP FUNCTION IF EXISTS public.create_classroom_room(text);
DROP FUNCTION IF EXISTS public.join_classroom_room(text);

CREATE INDEX IF NOT EXISTS classroom_room_state_current_game_idx
  ON public.classroom_room_state(current_game_id);
CREATE INDEX IF NOT EXISTS classroom_room_state_selected_game_idx
  ON public.classroom_room_state(selected_game_id);
