ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS schedule_generation_time TIME NOT NULL DEFAULT '03:00:00'::time;

UPDATE public.groups
SET schedule_generation_time = '03:00:00'::time
WHERE schedule_generation_time IS NULL;

CREATE OR REPLACE FUNCTION public.generate_next_week_sessions_for_group(
  p_group_id UUID,
  p_allow_update BOOLEAN DEFAULT false
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group RECORD;
  v_schedule RECORD;
  v_current_day INTEGER;
  v_days_until_next_monday INTEGER;
  v_next_week_monday DATE;
  v_day_offset INTEGER;
  v_session_date DATE;
  v_total INTEGER := 0;
  v_affected INTEGER := 0;
BEGIN
  SELECT id, max_participants
  INTO v_group
  FROM public.groups
  WHERE id = p_group_id;

  IF v_group.id IS NULL THEN
    RETURN 0;
  END IF;

  v_current_day := EXTRACT(DOW FROM (now() AT TIME ZONE 'UTC'))::INTEGER;
  v_days_until_next_monday := CASE
    WHEN v_current_day = 1 THEN 7
    ELSE MOD(8 - v_current_day, 7)
  END;
  v_next_week_monday := (now() AT TIME ZONE 'UTC')::DATE + v_days_until_next_monday;

  FOR v_schedule IN
    SELECT id, day_of_week, start_time, end_time
    FROM public.schedules
    WHERE group_id = p_group_id
  LOOP
    IF v_schedule.day_of_week < 0 OR v_schedule.day_of_week > 6 THEN
      CONTINUE;
    END IF;

    v_day_offset := CASE
      WHEN v_schedule.day_of_week = 0 THEN 6
      ELSE v_schedule.day_of_week - 1
    END;
    v_session_date := v_next_week_monday + v_day_offset;

    IF p_allow_update THEN
      INSERT INTO public.sessions (
        group_id,
        schedule_id,
        date,
        start_time,
        end_time,
        max_participants
      )
      VALUES (
        p_group_id,
        v_schedule.id,
        v_session_date,
        v_schedule.start_time,
        v_schedule.end_time,
        COALESCE(v_group.max_participants, 8)
      )
      ON CONFLICT (group_id, date, start_time)
      DO UPDATE SET
        schedule_id = EXCLUDED.schedule_id,
        end_time = EXCLUDED.end_time,
        max_participants = EXCLUDED.max_participants;
    ELSE
      INSERT INTO public.sessions (
        group_id,
        schedule_id,
        date,
        start_time,
        end_time,
        max_participants
      )
      VALUES (
        p_group_id,
        v_schedule.id,
        v_session_date,
        v_schedule.start_time,
        v_schedule.end_time,
        COALESCE(v_group.max_participants, 8)
      )
      ON CONFLICT (group_id, date, start_time)
      DO NOTHING;
    END IF;

    GET DIAGNOSTICS v_affected = ROW_COUNT;
    v_total := v_total + v_affected;
  END LOOP;

  RETURN v_total;
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
    WHERE to_char((now() AT TIME ZONE COALESCE(timezone, 'Europe/Moscow')), 'HH24:MI') =
      to_char(COALESCE(schedule_generation_time, '03:00:00'::time), 'HH24:MI')
  LOOP
    v_total := v_total + public.generate_next_week_sessions_for_group(v_group.id, true);
  END LOOP;

  RETURN v_total;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $job$
DECLARE
  v_job RECORD;
BEGIN
  FOR v_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'generate-weekly-sessions-by-group-time'
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;

  PERFORM cron.schedule(
    'generate-weekly-sessions-by-group-time',
    '* * * * *',
    $cron$SELECT public.generate_weekly_sessions_due_groups();$cron$
  );
END;
$job$;
