-- Remove legacy strikes feature objects.
-- Safe for both existing and fresh environments.
DROP TABLE IF EXISTS public.strikes CASCADE;
