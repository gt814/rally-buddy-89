-- Default attendance to true for active bookings.
ALTER TABLE public.bookings
  ALTER COLUMN attended SET DEFAULT true;

-- Backfill existing active bookings where attendance was not set yet.
UPDATE public.bookings
SET attended = true
WHERE status = 'active'
  AND attended IS NULL;
