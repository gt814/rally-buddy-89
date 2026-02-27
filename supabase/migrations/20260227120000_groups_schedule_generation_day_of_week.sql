ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS schedule_generation_day_of_week SMALLINT NOT NULL DEFAULT 1;

UPDATE public.groups
SET schedule_generation_day_of_week = 1
WHERE schedule_generation_day_of_week IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'groups_schedule_generation_day_of_week_check'
  ) THEN
    ALTER TABLE public.groups
      ADD CONSTRAINT groups_schedule_generation_day_of_week_check
      CHECK (schedule_generation_day_of_week BETWEEN 0 AND 6);
  END IF;
END;
$$;

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
            to_char(COALESCE(schedule_generation_time, '03:00:00'::time), 'HH24:MI')
  LOOP
    v_total := v_total + public.generate_next_week_sessions_for_group(v_group.id, true);
  END LOOP;

  RETURN v_total;
END;
$$;
