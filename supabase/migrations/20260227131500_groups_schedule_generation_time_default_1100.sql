ALTER TABLE public.groups
  ALTER COLUMN schedule_generation_time SET DEFAULT '11:00:00'::time;

UPDATE public.groups
SET schedule_generation_time = '11:00:00'::time
WHERE schedule_generation_time IS NULL;

CREATE OR REPLACE FUNCTION public.generate_weekly_sessions_due_groups()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group RECORD;
  v_total INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT id
    FROM public.groups
    WHERE EXTRACT(DOW FROM (now() AT TIME ZONE COALESCE(timezone, 'Europe/Moscow')))::INTEGER =
            COALESCE(schedule_generation_day_of_week, 1)
      AND to_char((now() AT TIME ZONE COALESCE(timezone, 'Europe/Moscow')), 'HH24:MI') =
            to_char(COALESCE(schedule_generation_time, '11:00:00'::time), 'HH24:MI')
  LOOP
    v_total := v_total + public.generate_next_week_sessions_for_group(v_group.id, true);
  END LOOP;

  RETURN v_total;
END;
$$;
