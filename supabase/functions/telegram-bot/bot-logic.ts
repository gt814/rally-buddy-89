// Business logic module — extracted for testability
// All external dependencies are injected via the `deps` parameter.

export interface Deps {
  supabase: any;
  sendMessage: (chatId: number, text: string, reply_markup?: any) => Promise<void>;
  editMessage: (chatId: number, messageId: number, text: string, reply_markup?: any) => Promise<void>;
  answerCallback: (callbackQueryId: string, text?: string) => Promise<void>;
  superAdminIds: number[];
}

const DAYS_RU = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const DAYS_FULL_RU = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
const MONTHS_RU = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];
const DEFAULT_TIMEZONE = "Europe/Moscow";

export function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  if (!year || !month || !day) return dateStr;

  // Parse date-only values in UTC to avoid weekday shifts caused by server timezone.
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = DAYS_RU[d.getUTCDay()];
  const monthName = MONTHS_RU[d.getUTCMonth()];
  return `${dayOfWeek}, ${day} ${monthName}`;
}

export function formatTime(time: string, timezone: string = DEFAULT_TIMEZONE): string {
  void timezone;
  return time.substring(0, 5);
}

function parseGenerationTime(value: string): string | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return `${match[1]}:${match[2]}:00`;
}

function parseGenerationDay(value: string): number | null {
  const day = parseInt(value.trim(), 10);
  if (Number.isNaN(day) || day < 0 || day > 6) return null;
  return day;
}

async function getGroupTimezone(deps: Deps, groupId: string): Promise<string> {
  const { data: group } = await deps.supabase
    .from("groups")
    .select("timezone")
    .eq("id", groupId)
    .single();
  return group?.timezone || DEFAULT_TIMEZONE;
}

function getFreezeContext(sessionDate: string, sessionStartTime: string, freezeHours: number) {
  const sessionDateTime = new Date(`${sessionDate}T${sessionStartTime}`);
  const now = new Date();
  const hoursUntil = (sessionDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);
  return {
    freezeHours,
    hoursUntil,
    isFrozen: hoursUntil <= freezeHours,
  };
}

// ===== DB helpers =====
export async function getOrCreateUser(deps: Deps, telegramUser: any) {
  const { data: existing } = await deps.supabase
    .from("bot_users")
    .select("*")
    .eq("telegram_id", telegramUser.id)
    .single();

  if (existing) {
    if (existing.username !== telegramUser.username || existing.first_name !== telegramUser.first_name) {
      await deps.supabase
        .from("bot_users")
        .update({
          username: telegramUser.username || null,
          first_name: telegramUser.first_name || null,
          last_name: telegramUser.last_name || null,
          is_super_admin: deps.superAdminIds.includes(telegramUser.id),
        })
        .eq("id", existing.id);
    }
    return { ...existing, is_super_admin: deps.superAdminIds.includes(telegramUser.id) };
  }

  const { data: newUser } = await deps.supabase
    .from("bot_users")
    .insert({
      telegram_id: telegramUser.id,
      username: telegramUser.username || null,
      first_name: telegramUser.first_name || null,
      last_name: telegramUser.last_name || null,
      is_super_admin: deps.superAdminIds.includes(telegramUser.id),
    })
    .select()
    .single();

  return newUser;
}

export async function isGroupAdmin(deps: Deps, userId: string, groupId: string): Promise<boolean> {
  const { data } = await deps.supabase
    .from("group_admins")
    .select("id")
    .eq("user_id", userId)
    .eq("group_id", groupId)
    .single();
  return !!data;
}

export async function isGroupMember(deps: Deps, userId: string, groupId: string): Promise<boolean> {
  const { data } = await deps.supabase
    .from("group_members")
    .select("id, is_banned")
    .eq("user_id", userId)
    .eq("group_id", groupId)
    .single();
  return !!data && !data.is_banned;
}

export async function getUserGroups(deps: Deps, userId: string) {
  const { data: memberships } = await deps.supabase
    .from("group_members")
    .select("group_id, is_banned, groups(id, name)")
    .eq("user_id", userId)
    .eq("is_banned", false);
  return memberships || [];
}

export async function getUserAdminGroups(deps: Deps, userId: string) {
  const { data } = await deps.supabase
    .from("group_admins")
    .select("group_id, groups(id, name)")
    .eq("user_id", userId);
  return data || [];
}

// ===== Generate sessions =====
export async function generateSessions(deps: Deps, groupId: string, allowUpdates = false) {
  const { data: schedules } = await deps.supabase
    .from("schedules")
    .select("*")
    .eq("group_id", groupId);

  if (!schedules || schedules.length === 0) return;

  const { data: group } = await deps.supabase
    .from("groups")
    .select("max_participants")
    .eq("id", groupId)
    .single();

  // Generate only for the next calendar week: Monday..Sunday (UTC)
  const now = new Date();
  const currentDay = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysUntilNextMonday = currentDay === 1 ? 7 : (8 - currentDay) % 7;
  const nextWeekMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  nextWeekMonday.setUTCDate(nextWeekMonday.getUTCDate() + daysUntilNextMonday);

  for (const schedule of schedules) {
    const dayOfWeek = Number(schedule.day_of_week);
    if (Number.isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) continue;

    // Convert schedule day (Sun=0..Sat=6) to offset in next week Monday..Sunday.
    const dayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const sessionDate = new Date(nextWeekMonday);
    sessionDate.setUTCDate(nextWeekMonday.getUTCDate() + dayOffset);
    const dateStr = sessionDate.toISOString().split("T")[0];

    await deps.supabase
      .from("sessions")
      .upsert(
        {
          group_id: groupId,
          schedule_id: schedule.id,
          date: dateStr,
          start_time: schedule.start_time,
          end_time: schedule.end_time,
          max_participants: group?.max_participants || 8,
        },
        { onConflict: "group_id,date,start_time", ignoreDuplicates: !allowUpdates }
      );
  }
}

// ===== Handlers =====
export async function handleStart(deps: Deps, chatId: number, user: any, startParam?: string) {
  if (startParam?.startsWith("join_")) {
    const inviteCode = startParam.substring(5);
    const { data: group } = await deps.supabase
      .from("groups")
      .select("*")
      .eq("invite_code", inviteCode)
      .single();

    if (!group) {
      await deps.sendMessage(chatId, "❌ Группа не найдена или ссылка недействительна.");
      return;
    }

    const { data: existing } = await deps.supabase
      .from("group_members")
      .select("id, is_banned")
      .eq("group_id", group.id)
      .eq("user_id", user.id)
      .single();

    if (existing?.is_banned) {
      await deps.sendMessage(chatId, `❌ Вы заблокированы в группе «${group.name}».`);
      return;
    }

    if (existing) {
      await deps.sendMessage(chatId, `Вы уже участник группы «${group.name}» ✅`);
    } else {
      await deps.supabase.from("group_members").insert({
        group_id: group.id,
        user_id: user.id,
      });
      await deps.sendMessage(chatId, `🎉 Вы вступили в группу «${group.name}»!`);
    }
  }

  const isAdmin = user.is_super_admin || (await getUserAdminGroups(deps, user.id)).length > 0;

  const buttons: any[][] = [
    [{ text: "📋 Группы", callback_data: "my_groups" }],
    [{ text: "📝 Расписание", callback_data: "schedule" }],
    [{ text: "👤 Профиль", callback_data: "profile" }],
  ];

  if (isAdmin) {
    buttons.push([{ text: "⚙️ Управление", callback_data: "admin" }]);
  }

  await deps.sendMessage(
    chatId,
    `Привет, <b>${user.first_name || "друг"}</b>! 🏓\n\nЯ бот для бронирования тренировок по настольному теннису.\n\nВыберите действие:`,
    { inline_keyboard: buttons }
  );
}

export async function handleMyGroups(deps: Deps, chatId: number, messageId: number, user: any) {
  const groups = await getUserGroups(deps, user.id);

  if (groups.length === 0) {
    await deps.editMessage(chatId, messageId, "У вас пока нет групп. Попросите ссылку-приглашение у администратора.", {
      inline_keyboard: [[{ text: "« Назад", callback_data: "main_menu" }]],
    });
    return;
  }

  const buttons = groups.map((m: any) => [
    { text: `🚪 ${m.groups.name}`, callback_data: `leave_group_${m.group_id}` },
  ]);
  buttons.push([{ text: "« Назад", callback_data: "main_menu" }]);

  await deps.editMessage(chatId, messageId, "📋 <b>Ваши группы:</b>\n\nВыберите группу, чтобы выйти из неё.", {
    inline_keyboard: buttons,
  });
}

export async function handleLeaveGroup(deps: Deps, chatId: number, messageId: number, user: any, groupId: string) {
  const { data: membership } = await deps.supabase
    .from("group_members")
    .select("group_id, groups(name)")
    .eq("group_id", groupId)
    .eq("user_id", user.id)
    .eq("is_banned", false)
    .maybeSingle();

  if (!membership) {
    await deps.editMessage(chatId, messageId, "Вы уже не состоите в этой группе.", {
      inline_keyboard: [[{ text: "« К моим группам", callback_data: "my_groups" }]],
    });
    return;
  }

  const groupName = (membership as any).groups?.name || "группа";
  await deps.editMessage(
    chatId,
    messageId,
    `⚠️ Выйти из группы «${groupName}»?\n\nВсе ваши записи на будущие тренировки в этой группе будут отменены.`,
    {
      inline_keyboard: [
        [
          { text: "✅ Да, выйти", callback_data: `confirm_leave_group_${groupId}` },
          { text: "❌ Нет", callback_data: "my_groups" },
        ],
      ],
    }
  );
}

export async function handleConfirmLeaveGroup(deps: Deps, chatId: number, messageId: number, user: any, groupId: string) {
  const { data: membership } = await deps.supabase
    .from("group_members")
    .select("group_id, groups(name)")
    .eq("group_id", groupId)
    .eq("user_id", user.id)
    .eq("is_banned", false)
    .maybeSingle();

  if (!membership) {
    await deps.editMessage(chatId, messageId, "Вы уже не состоите в этой группе.", {
      inline_keyboard: [[{ text: "« К моим группам", callback_data: "my_groups" }]],
    });
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const { data: futureSessions } = await deps.supabase
    .from("sessions")
    .select("id")
    .eq("group_id", groupId)
    .gte("date", today);
  const futureSessionIds = (futureSessions || []).map((s: any) => s.id);

  let cancelledCount = 0;
  if (futureSessionIds.length > 0) {
    const { data: myFutureBookings } = await deps.supabase
      .from("bookings")
      .select("id")
      .eq("user_id", user.id)
      .in("session_id", futureSessionIds)
      .in("status", ["active", "waitlist"]);

    cancelledCount = myFutureBookings?.length || 0;
    if (cancelledCount > 0) {
      await deps.supabase
        .from("bookings")
        .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
        .eq("user_id", user.id)
        .in("session_id", futureSessionIds)
        .in("status", ["active", "waitlist"]);
    }
  }

  await deps.supabase.from("group_admins").delete().eq("group_id", groupId).eq("user_id", user.id);
  await deps.supabase.from("group_members").delete().eq("group_id", groupId).eq("user_id", user.id);

  const groupName = (membership as any).groups?.name || "группа";
  await deps.editMessage(
    chatId,
    messageId,
    `✅ Вы вышли из группы «${groupName}».\nОтменено записей на тренировки: ${cancelledCount}.`,
    {
      inline_keyboard: [
        [{ text: "📋 Группы", callback_data: "my_groups" }],
        [{ text: "« В меню", callback_data: "main_menu" }],
      ],
    }
  );
}

export async function handleBook(deps: Deps, chatId: number, messageId: number, user: any, sessionId: string) {
  const { data: session } = await deps.supabase
    .from("sessions")
    .select("*, groups(name, freeze_hours, max_participants, timezone)")
    .eq("id", sessionId)
    .single();

  if (!session || session.status !== "scheduled") {
    await deps.answerCallback("", "Тренировка недоступна");
    return;
  }

  const { data: membership } = await deps.supabase
    .from("group_members")
    .select("is_banned")
    .eq("group_id", session.group_id)
    .eq("user_id", user.id)
    .single();

  if (membership?.is_banned) {
    await deps.editMessage(
      chatId,
      messageId,
      "❌ Вы заблокированы в этой группе.\n\nОбратитесь к администратору.",
      { inline_keyboard: [[{ text: "« Назад", callback_data: `sched_${session.group_id}` }]] }
    );
    return;
  }

  const freeze = getFreezeContext(session.date, session.start_time, session.groups?.freeze_hours || 4);
  if (freeze.isFrozen) {
    await deps.editMessage(chatId, messageId, `⏰ Запись закрыта — время фиксации (за ${freeze.freezeHours}ч).`, {
      inline_keyboard: [[{ text: "« Назад", callback_data: `sched_${session.group_id}` }]],
    });
    return;
  }

  const { data: activeBookings } = await deps.supabase
    .from("bookings")
    .select("id")
    .eq("session_id", sessionId)
    .eq("status", "active");

  const activeCount = activeBookings?.length || 0;
  const maxP = session.max_participants;
  const groupTimezone = session.groups?.timezone || DEFAULT_TIMEZONE;

  if (activeCount < maxP) {
    const { error } = await deps.supabase.from("bookings").insert({
      session_id: sessionId,
      user_id: user.id,
      status: "active",
    });
    if (error) {
      if (error.code === "23505") {
        await deps.editMessage(chatId, messageId, "Вы уже записаны на эту тренировку.", {
          inline_keyboard: [[{ text: "« Назад", callback_data: `sched_${session.group_id}` }]],
        });
      } else {
        await deps.editMessage(chatId, messageId, "Ошибка при записи. Попробуйте позже.", {
          inline_keyboard: [[{ text: "« Назад", callback_data: `sched_${session.group_id}` }]],
        });
      }
      return;
    }
    await deps.editMessage(
      chatId,
      messageId,
      `✅ Вы записаны на тренировку!\n\n📅 ${formatDate(session.date)}, ${formatTime(session.start_time, groupTimezone)}–${formatTime(session.end_time, groupTimezone)}`,
      { inline_keyboard: [[{ text: "« К расписанию", callback_data: `sched_${session.group_id}` }]] }
    );
  } else {
    const { data: wlBookings } = await deps.supabase
      .from("bookings")
      .select("id")
      .eq("session_id", sessionId)
      .eq("status", "waitlist");

    const position = (wlBookings?.length || 0) + 1;

    const { error } = await deps.supabase.from("bookings").insert({
      session_id: sessionId,
      user_id: user.id,
      status: "waitlist",
      waitlist_position: position,
    });

    if (error) {
      await deps.editMessage(chatId, messageId, "Ошибка при записи. Попробуйте позже.", {
        inline_keyboard: [[{ text: "« Назад", callback_data: `sched_${session.group_id}` }]],
      });
      return;
    }

    await deps.editMessage(
      chatId,
      messageId,
      `⏳ Мест нет. Вы в листе ожидания (позиция ${position}).\n\nЕсли место освободится, вы будете записаны автоматически.\n\n📅 ${formatDate(session.date)}, ${formatTime(session.start_time, groupTimezone)}–${formatTime(session.end_time, groupTimezone)}`,
      { inline_keyboard: [[{ text: "« К расписанию", callback_data: `sched_${session.group_id}` }]] }
    );
  }
}

export async function handleConfirmCancel(deps: Deps, chatId: number, messageId: number, user: any, sessionId: string) {
  const { data: session } = await deps.supabase
    .from("sessions")
    .select("*, groups(freeze_hours, timezone)")
    .eq("id", sessionId)
    .single();

  if (!session) return;

  const groupTimezone = session.groups?.timezone || DEFAULT_TIMEZONE;
  const freeze = getFreezeContext(session.date, session.start_time, session.groups?.freeze_hours || 4);
  if (freeze.isFrozen) {
    await deps.editMessage(chatId, messageId, `⏰ Отмена невозможна — время фиксации (за ${freeze.freezeHours}ч).`, {
      inline_keyboard: [[{ text: "« К расписанию", callback_data: `sched_${session.group_id}` }]],
    });
    return;
  }

  await deps.supabase
    .from("bookings")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("user_id", user.id)
    .in("status", ["active"]);

  const { data: nextInLine } = await deps.supabase
    .from("bookings")
    .select("*, bot_users(telegram_id)")
    .eq("session_id", sessionId)
    .eq("status", "waitlist")
    .order("waitlist_position", { ascending: true })
    .limit(1)
    .single();

  if (nextInLine) {
    await deps.supabase
      .from("bookings")
      .update({ status: "active", waitlist_position: null })
      .eq("id", nextInLine.id);

    if (nextInLine.bot_users?.telegram_id) {
      await deps.sendMessage(
        nextInLine.bot_users.telegram_id,
        `🎉 Место освободилось! Вы записаны на тренировку:\n\n📅 ${formatDate(session.date)}, ${formatTime(session.start_time, groupTimezone)}–${formatTime(session.end_time, groupTimezone)}`
      );
    }
  }

  await deps.editMessage(chatId, messageId, "✅ Запись отменена.", {
    inline_keyboard: [[{ text: "« К расписанию", callback_data: `sched_${session.group_id}` }]],
  });
}

export async function handleCancelWaitlist(deps: Deps, chatId: number, messageId: number, user: any, sessionId: string) {
  const { data: session } = await deps.supabase
    .from("sessions")
    .select("group_id, date, start_time, groups(freeze_hours)")
    .eq("id", sessionId)
    .single();

  if (!session) return;

  const freeze = getFreezeContext(session.date, session.start_time, session.groups?.freeze_hours || 4);
  if (freeze.isFrozen) {
    await deps.editMessage(chatId, messageId, `⏰ Выход из очереди невозможен — время фиксации (за ${freeze.freezeHours}ч).`, {
      inline_keyboard: [[{ text: "« К расписанию", callback_data: `sched_${session.group_id}` }]],
    });
    return;
  }

  await deps.supabase
    .from("bookings")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("user_id", user.id)
    .eq("status", "waitlist");

  await deps.editMessage(chatId, messageId, "✅ Вы покинули лист ожидания.", {
    inline_keyboard: [[{ text: "« К расписанию", callback_data: `sched_${session?.group_id}` }]],
  });
}

export async function handleProfile(deps: Deps, chatId: number, messageId: number, user: any) {
  const groups = await getUserGroups(deps, user.id);

  const today = new Date().toISOString().split("T")[0];
  const { data: upcomingBookings } = await deps.supabase
    .from("bookings")
    .select("id, sessions(date)")
    .eq("user_id", user.id)
    .eq("status", "active");

  const upcoming = (upcomingBookings || []).filter(
    (b: any) => b.sessions?.date >= today
  ).length;

  let text = `👤 <b>Профиль</b>\n\n`;
  text += `Имя: ${user.first_name || "—"} ${user.last_name || ""}\n`;
  if (user.username) text += `Username: @${user.username}\n`;
  text += `\n📋 Групп: ${groups.length}\n`;
  text += `📝 Предстоящих тренировок: ${upcoming}\n`;

  await deps.editMessage(chatId, messageId, text, {
    inline_keyboard: [[{ text: "« Назад", callback_data: "main_menu" }]],
  });
}

export async function handleNewGroup(deps: Deps, chatId: number, user: any, name: string) {
  if (!user.is_super_admin) {
    await deps.sendMessage(chatId, "❌ Только суперадмин может создавать группы.");
    return;
  }

  if (!name) {
    await deps.sendMessage(chatId, "Укажите название: <code>/newgroup Название</code>");
    return;
  }

  const { data: group } = await deps.supabase
    .from("groups")
    .insert({ name, created_by: user.id })
    .select()
    .single();

  if (group) {
    await deps.supabase.from("group_admins").insert({ group_id: group.id, user_id: user.id });
    await deps.supabase.from("group_members").insert({ group_id: group.id, user_id: user.id });

    await deps.sendMessage(
      chatId,
      `✅ Группа «${name}» создана!\n\n🔗 Инвайт: <code>join_${group.invite_code}</code>\n\nТеперь настройте расписание кнопкой ниже или через меню «⚙️ Управление».`,
      {
        inline_keyboard: [[{ text: "🗓 Шаблоны расписания", callback_data: `asched_list_${group.id}` }]],
      }
    );
  }
}

export async function handleEditGroup(
  deps: Deps,
  chatId: number,
  user: any,
  groupIdPrefix: string,
  field: string,
  value: string
) {
  // Find group by prefix
  let group: any = null;
  const { data: exactMatch } = await deps.supabase
    .from("groups")
    .select("*")
    .eq("id", groupIdPrefix)
    .maybeSingle();
  if (exactMatch) {
    group = exactMatch;
  } else {
    const { data: allGroups } = await deps.supabase.from("groups").select("*");
    group = (allGroups || []).find((g: any) => g.id.startsWith(groupIdPrefix));
  }

  if (!group) {
    await deps.sendMessage(chatId, "❌ Группа не найдена.");
    return;
  }

  // Check admin
  const admin = await isGroupAdmin(deps, user.id, group.id);
  if (!admin && !user.is_super_admin) {
    await deps.sendMessage(chatId, "❌ Вы не администратор этой группы.");
    return;
  }

  const allowedFields: Record<string, string> = {
    name: "name",
    max: "max_participants",
    freeze: "freeze_hours",
    timezone: "timezone",
    gendate: "schedule_generation_day_of_week",
    gentime: "schedule_generation_time",
  };

  const dbField = allowedFields[field];
  if (!dbField) {
    await deps.sendMessage(
      chatId,
      "❌ Неизвестное поле. Допустимые: <code>name</code>, <code>max</code>, <code>freeze</code>, <code>timezone</code>, <code>gendate</code>, <code>gentime</code>."
    );
    return;
  }

  let parsedValue: any = value;
  if (field === "max" || field === "freeze") {
    parsedValue = parseInt(value);
    if (isNaN(parsedValue) || parsedValue <= 0) {
      await deps.sendMessage(chatId, "❌ Значение должно быть положительным числом.");
      return;
    }
  } else if (field === "gendate") {
    parsedValue = parseGenerationDay(value);
    if (parsedValue === null) {
      await deps.sendMessage(chatId, "❌ Неверный день запуска. Используйте день недели 0..6 (0=Вс, 1=Пн, ...).");
      return;
    }
  } else if (field === "gentime") {
    parsedValue = parseGenerationTime(value);
    if (!parsedValue) {
      await deps.sendMessage(chatId, "❌ Неверный формат времени. Используйте HH:MM, например 03:30.");
      return;
    }
  }

  await deps.supabase
    .from("groups")
    .update({ [dbField]: parsedValue })
    .eq("id", group.id);

  await deps.sendMessage(
    chatId,
    `✅ Группа «${group.name}» обновлена.\n\n${field} → <code>${parsedValue}</code>`
  );
}

export async function handleDeleteGroup(
  deps: Deps,
  chatId: number,
  user: any,
  groupIdPrefix: string
) {
  if (!user.is_super_admin) {
    await deps.sendMessage(chatId, "❌ Только суперадмин может удалять группы.");
    return;
  }

  // Find group by prefix
  let group: any = null;
  const { data: exactMatch } = await deps.supabase
    .from("groups")
    .select("*")
    .eq("id", groupIdPrefix)
    .maybeSingle();
  if (exactMatch) {
    group = exactMatch;
  } else {
    const { data: allGroups } = await deps.supabase.from("groups").select("*");
    group = (allGroups || []).find((g: any) => g.id.startsWith(groupIdPrefix));
  }

  if (!group) {
    await deps.sendMessage(chatId, "❌ Группа не найдена.");
    return;
  }

  // Delete related data in order
  await deps.supabase.from("group_admins").delete().eq("group_id", group.id);
  await deps.supabase.from("group_members").delete().eq("group_id", group.id);
  await deps.supabase.from("schedules").delete().eq("group_id", group.id);
  // Cancel all future sessions and their bookings
  const today = new Date().toISOString().split("T")[0];
  const { data: futureSessions } = await deps.supabase
    .from("sessions")
    .select("id")
    .eq("group_id", group.id)
    .gte("date", today);
  
  for (const s of futureSessions || []) {
    await deps.supabase
      .from("bookings")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("session_id", s.id)
      .in("status", ["active", "waitlist"]);
  }
  await deps.supabase.from("sessions").delete().eq("group_id", group.id);
  await deps.supabase.from("groups").delete().eq("id", group.id);

  await deps.sendMessage(chatId, `✅ Группа «${group.name}» удалена.`);
}

// ===== Inline admin edit/delete handlers =====

export async function handleAdminEditMenu(deps: Deps, chatId: number, messageId: number, user: any, groupId: string) {
  const { data: group } = await deps.supabase
    .from("groups")
    .select("*")
    .eq("id", groupId)
    .single();

  if (!group) return;

  const admin = await isGroupAdmin(deps, user.id, groupId);
  if (!admin && !user.is_super_admin) {
    await deps.editMessage(chatId, messageId, "❌ Вы не администратор этой группы.", {
      inline_keyboard: [[{ text: "« Назад", callback_data: `admin_group_${groupId}` }]],
    });
    return;
  }

  let text = `✏️ <b>Редактирование «${group.name}»</b>\n\n`;
  text += `📝 Название: ${group.name}\n`;
  text += `👥 Макс. участников: ${group.max_participants}\n`;
  text += `⏰ Время фиксации: за ${group.freeze_hours}ч\n`;
  text += `🗓 Генерация расписания: ${DAYS_FULL_RU[Number(group.schedule_generation_day_of_week ?? 1)] || "Понедельник"}, ${formatTime(group.schedule_generation_time || "11:00:00")}\n`;
  text += `🌍 Часовой пояс: ${group.timezone || DEFAULT_TIMEZONE}\n\n`;
  text += `Выберите параметр для изменения:`;

  await deps.editMessage(chatId, messageId, text, {
    inline_keyboard: [
      [{ text: "👥 Макс. участников", callback_data: `aedit_max_${groupId}` }],
      [{ text: "⏰ Время фиксации (часы)", callback_data: `aedit_freeze_${groupId}` }],
      [{ text: "🗓 Генерация расписания", callback_data: `aedit_gen_${groupId}` }],
      [{ text: "📝 Название", callback_data: `aedit_name_${groupId}` }],
      [{ text: "🌍 Часовой пояс", callback_data: `aedit_timezone_${groupId}` }],
      [{ text: "« Назад", callback_data: `admin_group_${groupId}` }],
    ],
  });
}

export async function handleAdminEditMax(deps: Deps, chatId: number, messageId: number, groupId: string) {
  const { data: group } = await deps.supabase.from("groups").select("max_participants").eq("id", groupId).single();
  const current = group?.max_participants || 8;

  const options = [4, 6, 8, 10, 12];
  const buttons = options.map((v) => ({
    text: v === current ? `✅ ${v}` : `${v}`,
    callback_data: `aset_max_${v}_${groupId}`,
  }));

  // Split into rows of 4
  const rows: any[][] = [];
  for (let i = 0; i < buttons.length; i += 4) {
    rows.push(buttons.slice(i, i + 4));
  }
  rows.push([{ text: "⌨️ Ввести вручную", callback_data: `aedit_max_custom_${groupId}` }]);
  rows.push([{ text: "« Назад", callback_data: `aedit_${groupId}` }]);

  await deps.editMessage(chatId, messageId, `👥 Выберите макс. количество участников (сейчас: ${current}):`, {
    inline_keyboard: rows,
  });
}

export async function handleAdminEditMaxCustom(deps: Deps, chatId: number, messageId: number, groupId: string) {
  const shortId = groupId.substring(0, 8);

  await deps.editMessage(
    chatId,
    messageId,
    `Введите любое число командой:\n\n` +
    `👥 <code>/editgroup ${shortId} max 9</code>\n\n` +
    `Допустимы любые положительные целые числа.`,
    {
      inline_keyboard: [[{ text: "« Назад", callback_data: `aedit_max_${groupId}` }]],
    }
  );
}

export async function handleAdminEditFreeze(deps: Deps, chatId: number, messageId: number, groupId: string) {
  const { data: group } = await deps.supabase.from("groups").select("freeze_hours").eq("id", groupId).single();
  const current = group?.freeze_hours || 4;

  const options = [1, 2, 3, 4, 6, 8, 12, 24];
  const buttons = options.map((v) => ({
    text: v === current ? `✅ ${v}ч` : `${v}ч`,
    callback_data: `aset_freeze_${v}_${groupId}`,
  }));

  const rows: any[][] = [];
  for (let i = 0; i < buttons.length; i += 4) {
    rows.push(buttons.slice(i, i + 4));
  }
  rows.push([{ text: "« Назад", callback_data: `aedit_${groupId}` }]);

  await deps.editMessage(chatId, messageId, `⏰ Выберите время фиксации (сейчас: за ${current}ч):`, {
    inline_keyboard: rows,
  });
}

export async function handleAdminSetField(deps: Deps, chatId: number, messageId: number, groupId: string, field: string, value: number) {
  const dbField = field === "max" ? "max_participants" : "freeze_hours";
  await deps.supabase.from("groups").update({ [dbField]: value }).eq("id", groupId);

  const label = field === "max" ? "Макс. участников" : "Время фиксации";
  const suffix = field === "freeze" ? "ч" : "";

  await deps.editMessage(chatId, messageId, `✅ ${label} изменено на <b>${value}${suffix}</b>`, {
    inline_keyboard: [
      [{ text: "✏️ Продолжить редактирование", callback_data: `aedit_${groupId}` }],
      [{ text: "« К группе", callback_data: `admin_group_${groupId}` }],
    ],
  });
}

export async function handleAdminEditText(deps: Deps, chatId: number, messageId: number, groupId: string) {
  const { data: group } = await deps.supabase.from("groups").select("name, timezone, schedule_generation_time, schedule_generation_day_of_week").eq("id", groupId).single();
  const shortId = groupId.substring(0, 8);

  await deps.editMessage(
    chatId,
    messageId,
    `📝 Название: <b>${group?.name || "—"}</b>\n` +
    `Используйте: <code>/editgroup ${shortId} name Новое название</code>\n\n` +
    `🌍 Таймзона: <b>${group?.timezone || DEFAULT_TIMEZONE}</b>\n` +
    `Используйте: <code>/editgroup ${shortId} timezone Europe/Berlin</code>\n` +
    `или <code>/editgroup ${shortId} timezone UTC+3</code>\n\n` +
    `📅 День запуска: <b>${DAYS_FULL_RU[Number(group?.schedule_generation_day_of_week ?? 1)] || "Понедельник"}</b>\n` +
    `Используйте: <code>/editgroup ${shortId} gendate 1</code>\n\n` +
    `⏰ Время запуска: <b>${formatTime(group?.schedule_generation_time || "11:00:00")}</b>\n` +
    `Используйте: <code>/editgroup ${shortId} gentime 03:30</code>`,
    {
      inline_keyboard: [[{ text: "« Назад", callback_data: `aedit_${groupId}` }]],
    }
  );
}

export async function handleAdminEditName(deps: Deps, chatId: number, messageId: number, groupId: string) {
  const shortId = groupId.substring(0, 8);
  await deps.editMessage(
    chatId,
    messageId,
    `Для изменения названия используйте команду:\n\n📝 <code>/editgroup ${shortId} name Новое название</code>`,
    { inline_keyboard: [[{ text: "« Назад", callback_data: `aedit_${groupId}` }]] }
  );
}

export async function handleAdminEditTimezone(deps: Deps, chatId: number, messageId: number, groupId: string) {
  const { data: group } = await deps.supabase.from("groups").select("timezone").eq("id", groupId).single();
  const shortId = groupId.substring(0, 8);
  await deps.editMessage(
    chatId,
    messageId,
    `Текущая таймзона: <b>${group?.timezone || DEFAULT_TIMEZONE}</b>\n\n` +
    `Для изменения используйте:\n` +
    `<code>/editgroup ${shortId} timezone Europe/Berlin</code>\n` +
    `или <code>/editgroup ${shortId} timezone UTC+3</code>`,
    { inline_keyboard: [[{ text: "« Назад", callback_data: `aedit_${groupId}` }]] }
  );
}

export async function handleAdminDeleteConfirm(deps: Deps, chatId: number, messageId: number, user: any, groupId: string) {
  if (!user.is_super_admin) {
    await deps.editMessage(chatId, messageId, "❌ Только суперадмин может удалять группы.", {
      inline_keyboard: [[{ text: "« Назад", callback_data: `admin_group_${groupId}` }]],
    });
    return;
  }

  const { data: group } = await deps.supabase.from("groups").select("name").eq("id", groupId).single();

  await deps.editMessage(
    chatId,
    messageId,
    `⚠️ <b>Удаление группы «${group?.name}»</b>\n\nВсе данные будут удалены:\n• Участники и администраторы\n• Расписание и сессии\n• Бронирования\n\nВы уверены?`,
    {
      inline_keyboard: [
        [
          { text: "✅ Да, удалить", callback_data: `aconfirm_del_${groupId}` },
          { text: "❌ Нет", callback_data: `admin_group_${groupId}` },
        ],
      ],
    }
  );
}

export async function handleAdminConfirmDelete(deps: Deps, chatId: number, messageId: number, user: any, groupId: string) {
  if (!user.is_super_admin) {
    await deps.editMessage(chatId, messageId, "❌ Только суперадмин может удалять группы.", {
      inline_keyboard: [[{ text: "« Назад", callback_data: `admin_group_${groupId}` }]],
    });
    return;
  }

  const { data: group } = await deps.supabase.from("groups").select("name").eq("id", groupId).single();
  if (!group) return;

  // Delete related data
  await deps.supabase.from("group_admins").delete().eq("group_id", groupId);
  await deps.supabase.from("group_members").delete().eq("group_id", groupId);
  await deps.supabase.from("schedules").delete().eq("group_id", groupId);
  const today = new Date().toISOString().split("T")[0];
  const { data: futureSessions } = await deps.supabase
    .from("sessions").select("id").eq("group_id", groupId).gte("date", today);
  for (const s of futureSessions || []) {
    await deps.supabase.from("bookings")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("session_id", s.id).in("status", ["active", "waitlist"]);
  }
  await deps.supabase.from("sessions").delete().eq("group_id", groupId);
  await deps.supabase.from("groups").delete().eq("id", groupId);

  await deps.editMessage(chatId, messageId, `✅ Группа «${group.name}» удалена.`, {
    inline_keyboard: [[{ text: "« К управлению", callback_data: "admin" }]],
  });
}

// ===== Schedule management handlers =====

const SCHEDULE_HOURS = Array.from({ length: 16 }, (_, i) => String(i + 8).padStart(2, "0"));
const SCHEDULE_MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));

export async function handleAdminScheduleTemplates(deps: Deps, chatId: number, messageId: number, user: any, groupId: string) {
  const admin = await isGroupAdmin(deps, user.id, groupId);
  if (!admin && !user.is_super_admin) {
    await deps.editMessage(chatId, messageId, "❌ Вы не администратор этой группы.", {
      inline_keyboard: [[{ text: "« Назад", callback_data: `admin_group_${groupId}` }]],
    });
    return;
  }

  const { data: schedules } = await deps.supabase
    .from("schedules")
    .select("*")
    .eq("group_id", groupId)
    .order("day_of_week", { ascending: true })
    .order("start_time", { ascending: true });
  const groupTimezone = await getGroupTimezone(deps, groupId);

  let text = "📅 <b>Шаблоны расписания</b>\n\n";
  const buttons: any[][] = [];

  if (!schedules || schedules.length === 0) {
    text += "Расписание пока не настроено.\n";
  } else {
    for (const s of schedules) {
      text += `• ${DAYS_FULL_RU[s.day_of_week]} ${formatTime(s.start_time, groupTimezone)}–${formatTime(s.end_time, groupTimezone)}\n`;
      buttons.push([
        { text: `🗑 ${DAYS_RU[s.day_of_week]} ${formatTime(s.start_time, groupTimezone)}–${formatTime(s.end_time, groupTimezone)}`, callback_data: `asched_del_${s.id}` },
      ]);
    }
  }

  text += "\nНажмите ➕ чтобы добавить расписание на новый день.";

  buttons.push([{ text: "➕ Добавить расписание", callback_data: `asched_add_${groupId}` }]);
  buttons.push([{ text: "« Назад", callback_data: `admin_group_${groupId}` }]);

  await deps.editMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

export async function handleAdminAddScheduleDay(deps: Deps, chatId: number, messageId: number, groupId: string) {
  const buttons: any[][] = [];
  const dayPairs = [[1, 2], [3, 4], [5, 6], [0]];
  for (const pair of dayPairs) {
    buttons.push(pair.map(d => ({
      text: DAYS_FULL_RU[d],
      callback_data: `asched_start_hour_${d}_${groupId}`,
    })));
  }
  buttons.push([{ text: "« Назад", callback_data: `asched_list_${groupId}` }]);

  await deps.editMessage(chatId, messageId, "📅 Выберите день недели:", { inline_keyboard: buttons });
}

export async function handleAdminAddScheduleStart(deps: Deps, chatId: number, messageId: number, day: number, groupId: string) {
  const buttons: any[][] = [];
  for (let i = 0; i < SCHEDULE_HOURS.length; i += 4) {
    buttons.push(SCHEDULE_HOURS.slice(i, i + 4).map(hour => ({
      text: hour,
      callback_data: `asched_start_min_${day}_${hour}_${groupId}`,
    })));
  }
  buttons.push([{ text: "« Назад", callback_data: `asched_add_${groupId}` }]);

  await deps.editMessage(chatId, messageId, `⏰ ${DAYS_FULL_RU[day]} — выберите час начала:`, { inline_keyboard: buttons });
}

export async function handleAdminAddScheduleStartMinute(deps: Deps, chatId: number, messageId: number, day: number, startHour: string, groupId: string) {
  const buttons: any[][] = [];
  for (let i = 0; i < SCHEDULE_MINUTES.length; i += 4) {
    buttons.push(SCHEDULE_MINUTES.slice(i, i + 4).map(minute => ({
      text: minute,
      callback_data: `asched_end_hour_${day}_${startHour}:${minute}_${groupId}`,
    })));
  }
  buttons.push([{ text: "« Назад", callback_data: `asched_start_hour_${day}_${groupId}` }]);

  await deps.editMessage(chatId, messageId, `⏰ ${DAYS_FULL_RU[day]}, ${startHour}:__ — выберите минуты начала:`, { inline_keyboard: buttons });
}

export async function handleAdminAddScheduleEnd(deps: Deps, chatId: number, messageId: number, day: number, startTime: string, groupId: string) {
  const [startHour] = startTime.split(":");
  const startHourNum = Number(startHour);
  const validEndHours = SCHEDULE_HOURS.filter(hour => Number(hour) >= startHourNum);

  const buttons: any[][] = [];
  for (let i = 0; i < validEndHours.length; i += 4) {
    buttons.push(validEndHours.slice(i, i + 4).map(endHour => ({
      text: endHour,
      callback_data: `asched_end_min_${day}_${startTime}_${endHour}_${groupId}`,
    })));
  }
  buttons.push([{ text: "« Назад", callback_data: `asched_start_min_${day}_${startHour}_${groupId}` }]);

  await deps.editMessage(chatId, messageId, `⏰ ${DAYS_FULL_RU[day]}, начало ${startTime} — выберите час окончания:`, { inline_keyboard: buttons });
}

export async function handleAdminAddScheduleEndMinute(deps: Deps, chatId: number, messageId: number, day: number, startTime: string, endHour: string, groupId: string) {
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const endHourNum = Number(endHour);
  const validEndMinutes = SCHEDULE_MINUTES.filter(minute => endHourNum > startHour || Number(minute) > startMinute);

  const buttons: any[][] = [];
  for (let i = 0; i < validEndMinutes.length; i += 4) {
    buttons.push(validEndMinutes.slice(i, i + 4).map(endMinute => ({
      text: endMinute,
      callback_data: `asched_save_${day}_${startTime}_${endHour}:${endMinute}_${groupId}`,
    })));
  }
  buttons.push([{ text: "« Назад", callback_data: `asched_end_hour_${day}_${startTime}_${groupId}` }]);

  await deps.editMessage(chatId, messageId, `⏰ ${DAYS_FULL_RU[day]}, начало ${startTime}, ${endHour}:__ — выберите минуты окончания:`, { inline_keyboard: buttons });
}

export async function handleAdminSaveSchedule(deps: Deps, chatId: number, messageId: number, day: number, startTime: string, endTime: string, groupId: string) {
  await deps.supabase.from("schedules").insert({
    group_id: groupId,
    day_of_week: day,
    start_time: startTime,
    end_time: endTime,
  });

  await generateSessions(deps, groupId, true);
  const groupTimezone = await getGroupTimezone(deps, groupId);

  await deps.editMessage(
    chatId,
    messageId,
    `✅ Расписание добавлено!\n\n${DAYS_FULL_RU[day]} ${formatTime(startTime, groupTimezone)}–${formatTime(endTime, groupTimezone)}\n\nСессии сгенерированы на следующую неделю (Пн–Вс).`,
    {
      inline_keyboard: [
        [{ text: "➕ Добавить ещё", callback_data: `asched_add_${groupId}` }],
        [{ text: "📅 К расписанию", callback_data: `asched_list_${groupId}` }],
        [{ text: "« К группе", callback_data: `admin_group_${groupId}` }],
      ],
    }
  );
}

export async function handleAdminDeleteScheduleConfirm(deps: Deps, chatId: number, messageId: number, scheduleId: string, groupId?: string) {
  const { data: schedule } = await deps.supabase
    .from("schedules")
    .select("*")
    .eq("id", scheduleId)
    .single();

  if (!schedule) {
    const backButton = groupId
      ? [{ text: "« Назад", callback_data: `asched_list_${groupId}` }]
      : [{ text: "« Назад", callback_data: "admin" }];
    await deps.editMessage(chatId, messageId, "❌ Расписание не найдено.", {
      inline_keyboard: [backButton],
    });
    return;
  }

  const resolvedGroupId = schedule.group_id;
  const groupTimezone = await getGroupTimezone(deps, resolvedGroupId);

  await deps.editMessage(
    chatId,
    messageId,
    `⚠️ Удалить расписание?\n\n${DAYS_FULL_RU[schedule.day_of_week]} ${formatTime(schedule.start_time, groupTimezone)}–${formatTime(schedule.end_time, groupTimezone)}\n\nБудущие сессии по этому шаблону также будут удалены.`,
    {
      inline_keyboard: [
        [
          { text: "✅ Да, удалить", callback_data: `asched_confirm_del_${scheduleId}` },
          { text: "❌ Нет", callback_data: `asched_list_${resolvedGroupId}` },
        ],
      ],
    }
  );
}

export async function handleAdminConfirmDeleteSchedule(deps: Deps, chatId: number, messageId: number, scheduleId: string, groupId?: string) {
  const { data: schedule } = await deps.supabase
    .from("schedules")
    .select("group_id")
    .eq("id", scheduleId)
    .single();
  const resolvedGroupId = schedule?.group_id || groupId;
  if (!resolvedGroupId) {
    await deps.editMessage(chatId, messageId, "❌ Расписание не найдено.");
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const { data: futureSessions } = await deps.supabase
    .from("sessions")
    .select("id")
    .eq("schedule_id", scheduleId)
    .gte("date", today);

  for (const s of futureSessions || []) {
    await deps.supabase
      .from("bookings")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("session_id", s.id)
      .in("status", ["active", "waitlist"]);
  }

  await deps.supabase
    .from("sessions")
    .delete()
    .eq("schedule_id", scheduleId)
    .gte("date", today);

  await deps.supabase.from("schedules").delete().eq("id", scheduleId);

  await deps.editMessage(chatId, messageId, "✅ Расписание и связанные будущие сессии удалены.", {
    inline_keyboard: [
      [{ text: "📅 К расписанию", callback_data: `asched_list_${resolvedGroupId}` }],
      [{ text: "« К группе", callback_data: `admin_group_${resolvedGroupId}` }],
    ],
  });
}

export async function handleAdminConfirmCancelSession(deps: Deps, chatId: number, messageId: number, sessionId: string) {
  const { data: session } = await deps.supabase
    .from("sessions")
    .select("*, groups(freeze_hours)")
    .eq("id", sessionId)
    .single();

  if (!session) return;
  const freeze = getFreezeContext(session.date, session.start_time, session.groups?.freeze_hours || 4);
  if (freeze.isFrozen) {
    await deps.editMessage(chatId, messageId, `⏰ Отмена тренировки невозможна — время фиксации (за ${freeze.freezeHours}ч).`, {
      inline_keyboard: [[{ text: "« К расписанию", callback_data: `admin_sched_${session.group_id}` }]],
    });
    return;
  }

  const groupTimezone = await getGroupTimezone(deps, session.group_id);

  await deps.supabase.from("sessions").update({ status: "cancelled" }).eq("id", sessionId);

  const { data: bookings } = await deps.supabase
    .from("bookings")
    .select("id, user_id")
    .eq("session_id", sessionId)
    .in("status", ["active", "waitlist"]);

  const userIds = Array.from(new Set((bookings || []).map((b: any) => b.user_id).filter(Boolean)));
  let usersById: Record<string, any> = {};
  if (userIds.length > 0) {
    const { data: users } = await deps.supabase
      .from("bot_users")
      .select("id, telegram_id")
      .in("id", userIds);
    usersById = Object.fromEntries((users || []).map((u: any) => [u.id, u]));
  }

  for (const b of bookings || []) {
    await deps.supabase
      .from("bookings")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", b.id);

    const recipient = usersById[(b as any).user_id];
    if (recipient?.telegram_id) {
      await deps.sendMessage(
        recipient.telegram_id,
        `❌ Тренировка отменена администратором:\n\n📅 ${formatDate(session.date)}, ${formatTime(session.start_time, groupTimezone)}–${formatTime(session.end_time, groupTimezone)}`
      );
    }
  }

  await deps.editMessage(chatId, messageId, "✅ Тренировка отменена. Участники уведомлены.", {
    inline_keyboard: [[{ text: "« К расписанию", callback_data: `admin_sched_${session.group_id}` }]],
  });
}
