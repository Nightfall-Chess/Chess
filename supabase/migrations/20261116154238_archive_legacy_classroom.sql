-- Keep the empty pre-alignment tables as private archives, outside the exposed API schema.
ALTER TABLE public.classroom_legacy_rooms SET SCHEMA private;
ALTER TABLE public.classroom_legacy_members SET SCHEMA private;
ALTER TABLE public.classroom_legacy_state SET SCHEMA private;
ALTER TABLE public.classroom_legacy_messages SET SCHEMA private;
ALTER TABLE public.classroom_legacy_games SET SCHEMA private;

REVOKE ALL ON ALL TABLES IN SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;
