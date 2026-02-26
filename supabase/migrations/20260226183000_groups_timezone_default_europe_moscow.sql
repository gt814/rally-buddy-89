ALTER TABLE public.groups
  ALTER COLUMN timezone SET DEFAULT 'Europe/Moscow';

UPDATE public.groups
SET timezone = 'Europe/Moscow'
WHERE timezone IS NULL OR btrim(timezone) = '';
