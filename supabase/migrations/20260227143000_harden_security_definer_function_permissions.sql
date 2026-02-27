REVOKE ALL ON FUNCTION public.generate_next_week_sessions_for_group(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_next_week_sessions_for_group(uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.generate_next_week_sessions_for_group(uuid, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.generate_next_week_sessions_for_group(uuid, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.generate_weekly_sessions_due_groups() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_weekly_sessions_due_groups() FROM anon;
REVOKE ALL ON FUNCTION public.generate_weekly_sessions_due_groups() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.generate_weekly_sessions_due_groups() TO service_role;
