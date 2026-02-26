
-- Таблица пользователей бота
CREATE TABLE public.bot_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  is_super_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Группы
CREATE TABLE public.groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(6), 'hex'),
  freeze_hours INTEGER NOT NULL DEFAULT 4,
  max_participants INTEGER NOT NULL DEFAULT 8,
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  created_by UUID REFERENCES public.bot_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Администраторы групп
CREATE TABLE public.group_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.bot_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, user_id)
);

-- Участники групп
CREATE TABLE public.group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.bot_users(id) ON DELETE CASCADE,
  is_banned BOOLEAN NOT NULL DEFAULT false,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, user_id)
);

-- Расписание (повторяющееся)
CREATE TABLE public.schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Сессии (конкретные тренировки)
CREATE TYPE public.session_status AS ENUM ('scheduled', 'cancelled', 'completed');

CREATE TABLE public.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  schedule_id UUID REFERENCES public.schedules(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status public.session_status NOT NULL DEFAULT 'scheduled',
  max_participants INTEGER NOT NULL DEFAULT 8,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, date, start_time)
);

-- Бронирования
CREATE TYPE public.booking_status AS ENUM ('active', 'waitlist', 'cancelled');

CREATE TABLE public.bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.bot_users(id) ON DELETE CASCADE,
  status public.booking_status NOT NULL DEFAULT 'active',
  waitlist_position INTEGER,
  attended BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ
);

-- Уникальность: один пользователь - одна активная запись на сессию
CREATE UNIQUE INDEX idx_bookings_active_unique 
ON public.bookings (session_id, user_id) 
WHERE status IN ('active', 'waitlist');

-- Лог уведомлений
CREATE TABLE public.notifications_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.bot_users(id) ON DELETE SET NULL,
  telegram_id BIGINT,
  type TEXT NOT NULL,
  message TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Индексы для производительности
CREATE INDEX idx_sessions_group_date ON public.sessions(group_id, date);
CREATE INDEX idx_bookings_session ON public.bookings(session_id, status);
CREATE INDEX idx_bookings_user ON public.bookings(user_id, status);
CREATE INDEX idx_group_members_group ON public.group_members(group_id);
CREATE INDEX idx_group_members_user ON public.group_members(user_id);

-- RLS: Все таблицы работают через edge functions с service role key,
-- поэтому RLS включаем, но даём доступ только service_role
ALTER TABLE public.bot_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications_log ENABLE ROW LEVEL SECURITY;

-- Политики для service_role (edge functions используют service role key)
-- Для каждой таблицы - полный доступ для service_role
CREATE POLICY "Service role full access" ON public.bot_users FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON public.groups FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON public.group_admins FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON public.group_members FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON public.schedules FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON public.sessions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON public.bookings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON public.notifications_log FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Анонимный доступ на чтение для веб-панели (будет через authenticated позже)
CREATE POLICY "Anon read groups" ON public.groups FOR SELECT TO anon USING (true);
CREATE POLICY "Anon read sessions" ON public.sessions FOR SELECT TO anon USING (true);
CREATE POLICY "Anon read bookings" ON public.bookings FOR SELECT TO anon USING (true);

-- Функция обновления updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_bot_users_updated_at BEFORE UPDATE ON public.bot_users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_groups_updated_at BEFORE UPDATE ON public.groups FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
