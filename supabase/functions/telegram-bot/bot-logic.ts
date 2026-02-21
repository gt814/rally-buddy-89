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
const MONTHS_RU = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const dayOfWeek = DAYS_RU[d.getDay()];
  const day = d.getDate();
  const month = MONTHS_RU[d.getMonth()];
  return `${dayOfWeek}, ${day} ${month}`;
}

export function formatTime(time: string): string {
  return time.substring(0, 5);
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
export async function generateSessions(deps: Deps, groupId: string) {
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

  const today = new Date();
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + 14);

  for (const schedule of schedules) {
    const current = new Date(today);
    while (current <= horizon) {
      if (current.getDay() === schedule.day_of_week) {
        const dateStr = current.toISOString().split("T")[0];
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
            { onConflict: "group_id,date,start_time" }
          );
      }
      current.setDate(current.getDate() + 1);
    }
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
    [{ text: "📋 Мои группы", callback_data: "my_groups" }],
    [{ text: "📝 Расписание", callback_data: "schedule" }],
    [{ text: "👤 Мой профиль", callback_data: "profile" }],
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
    { text: `🏓 ${m.groups.name}`, callback_data: `group_${m.group_id}` },
  ]);
  buttons.push([{ text: "« Назад", callback_data: "main_menu" }]);

  await deps.editMessage(chatId, messageId, "📋 <b>Ваши группы:</b>", {
    inline_keyboard: buttons,
  });
}

export async function handleBook(deps: Deps, chatId: number, messageId: number, user: any, sessionId: string) {
  const { data: session } = await deps.supabase
    .from("sessions")
    .select("*, groups(name, freeze_hours, max_participants)")
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
    const { data: strikes } = await deps.supabase
      .from("strikes")
      .select("id")
      .eq("user_id", user.id)
      .eq("group_id", session.group_id)
      .gt("expires_at", new Date().toISOString());

    await deps.editMessage(
      chatId,
      messageId,
      `❌ Вы заблокированы в этой группе.\nАктивных страйков: ${strikes?.length || 0}\n\nОбратитесь к администратору.`,
      { inline_keyboard: [[{ text: "« Назад", callback_data: `sched_${session.group_id}` }]] }
    );
    return;
  }

  // Check freeze
  const sessionDateTime = new Date(`${session.date}T${session.start_time}`);
  const now = new Date();
  const hoursUntil = (sessionDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);
  if (hoursUntil <= (session.groups?.freeze_hours || 4)) {
    await deps.editMessage(chatId, messageId, "⏰ Запись закрыта (заморозка).", {
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
      `✅ Вы записаны на тренировку!\n\n📅 ${formatDate(session.date)}, ${formatTime(session.start_time)}–${formatTime(session.end_time)}`,
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
      `⏳ Мест нет. Вы в листе ожидания (позиция ${position}).\n\nЕсли место освободится, вы будете записаны автоматически.\n\n📅 ${formatDate(session.date)}, ${formatTime(session.start_time)}–${formatTime(session.end_time)}`,
      { inline_keyboard: [[{ text: "« К расписанию", callback_data: `sched_${session.group_id}` }]] }
    );
  }
}

export async function handleConfirmCancel(deps: Deps, chatId: number, messageId: number, user: any, sessionId: string) {
  const { data: session } = await deps.supabase
    .from("sessions")
    .select("*, groups(freeze_hours)")
    .eq("id", sessionId)
    .single();

  if (!session) return;

  const sessionDateTime = new Date(`${session.date}T${session.start_time}`);
  const now = new Date();
  const hoursUntil = (sessionDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);
  if (hoursUntil <= (session.groups?.freeze_hours || 4)) {
    await deps.editMessage(chatId, messageId, "⏰ Отмена невозможна — запись заморожена.", {
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
        `🎉 Место освободилось! Вы записаны на тренировку:\n\n📅 ${formatDate(session.date)}, ${formatTime(session.start_time)}–${formatTime(session.end_time)}`
      );
    }
  }

  await deps.editMessage(chatId, messageId, "✅ Запись отменена.", {
    inline_keyboard: [[{ text: "« К расписанию", callback_data: `sched_${session.group_id}` }]],
  });
}

export async function handleCancelWaitlist(deps: Deps, chatId: number, messageId: number, user: any, sessionId: string) {
  await deps.supabase
    .from("bookings")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("user_id", user.id)
    .eq("status", "waitlist");

  const { data: session } = await deps.supabase
    .from("sessions")
    .select("group_id")
    .eq("id", sessionId)
    .single();

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

  const { data: strikes } = await deps.supabase
    .from("strikes")
    .select("id, group_id, groups(name)")
    .eq("user_id", user.id)
    .gt("expires_at", new Date().toISOString());

  let text = `👤 <b>Профиль</b>\n\n`;
  text += `Имя: ${user.first_name || "—"} ${user.last_name || ""}\n`;
  if (user.username) text += `Username: @${user.username}\n`;
  text += `\n📋 Групп: ${groups.length}\n`;
  text += `📝 Предстоящих тренировок: ${upcoming}\n`;
  text += `⚠️ Активных страйков: ${strikes?.length || 0}\n`;

  if (strikes && strikes.length > 0) {
    text += "\n<b>Страйки:</b>\n";
    for (const s of strikes) {
      text += `• ${(s as any).groups?.name || "?"}\n`;
    }
  }

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
      `✅ Группа «${name}» создана!\n\n🔗 Инвайт: <code>join_${group.invite_code}</code>\n\nТеперь настройте расписание: /schedule_${group.id.substring(0, 8)}`
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
  };

  const dbField = allowedFields[field];
  if (!dbField) {
    await deps.sendMessage(
      chatId,
      "❌ Неизвестное поле. Допустимые: <code>name</code>, <code>max</code>, <code>freeze</code>, <code>timezone</code>."
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
  await deps.supabase.from("strikes").delete().eq("group_id", group.id);
  await deps.supabase.from("groups").delete().eq("id", group.id);

  await deps.sendMessage(chatId, `✅ Группа «${group.name}» удалена.`);
}

export async function handleAdminConfirmCancelSession(deps: Deps, chatId: number, messageId: number, sessionId: string) {
  const { data: session } = await deps.supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .single();

  if (!session) return;

  await deps.supabase.from("sessions").update({ status: "cancelled" }).eq("id", sessionId);

  const { data: bookings } = await deps.supabase
    .from("bookings")
    .select("*, bot_users(telegram_id)")
    .eq("session_id", sessionId)
    .in("status", ["active", "waitlist"]);

  for (const b of bookings || []) {
    if ((b as any).bot_users?.telegram_id) {
      await deps.sendMessage(
        (b as any).bot_users.telegram_id,
        `❌ Тренировка отменена администратором:\n\n📅 ${formatDate(session.date)}, ${formatTime(session.start_time)}–${formatTime(session.end_time)}`
      );
    }
    await deps.supabase.from("bookings").update({ status: "cancelled" }).eq("id", b.id);
  }

  await deps.editMessage(chatId, messageId, "✅ Тренировка отменена. Участники уведомлены.", {
    inline_keyboard: [[{ text: "« К расписанию", callback_data: `admin_sched_${session.group_id}` }]],
  });
}
