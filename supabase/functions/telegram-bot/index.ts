import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPER_ADMIN_IDS = (Deno.env.get("SUPER_ADMIN_IDS") || "")
  .split(",")
  .map((id) => parseInt(id.trim()))
  .filter(Boolean);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const DAYS_RU = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const MONTHS_RU = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

// ===== Telegram API helpers =====
async function sendMessage(chatId: number, text: string, reply_markup?: any) {
  const body: any = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };
  if (reply_markup) body.reply_markup = reply_markup;
  
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("Failed to send message:", e);
  }
}

async function editMessage(chatId: number, messageId: number, text: string, reply_markup?: any) {
  const body: any = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
  };
  if (reply_markup) body.reply_markup = reply_markup;
  
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("Failed to edit message:", e);
  }
}

async function answerCallback(callbackQueryId: string, text?: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

// ===== DB helpers =====
async function getOrCreateUser(telegramUser: any) {
  const { data: existing } = await supabase
    .from("bot_users")
    .select("*")
    .eq("telegram_id", telegramUser.id)
    .single();

  if (existing) {
    // Update info if changed
    if (existing.username !== telegramUser.username || existing.first_name !== telegramUser.first_name) {
      await supabase
        .from("bot_users")
        .update({
          username: telegramUser.username || null,
          first_name: telegramUser.first_name || null,
          last_name: telegramUser.last_name || null,
          is_super_admin: SUPER_ADMIN_IDS.includes(telegramUser.id),
        })
        .eq("id", existing.id);
    }
    return { ...existing, is_super_admin: SUPER_ADMIN_IDS.includes(telegramUser.id) };
  }

  const { data: newUser } = await supabase
    .from("bot_users")
    .insert({
      telegram_id: telegramUser.id,
      username: telegramUser.username || null,
      first_name: telegramUser.first_name || null,
      last_name: telegramUser.last_name || null,
      is_super_admin: SUPER_ADMIN_IDS.includes(telegramUser.id),
    })
    .select()
    .single();

  return newUser;
}

async function isGroupAdmin(userId: string, groupId: string): Promise<boolean> {
  const { data } = await supabase
    .from("group_admins")
    .select("id")
    .eq("user_id", userId)
    .eq("group_id", groupId)
    .single();
  return !!data;
}

async function isGroupMember(userId: string, groupId: string): Promise<boolean> {
  const { data } = await supabase
    .from("group_members")
    .select("id, is_banned")
    .eq("user_id", userId)
    .eq("group_id", groupId)
    .single();
  return !!data && !data.is_banned;
}

async function getUserGroups(userId: string) {
  const { data: memberships } = await supabase
    .from("group_members")
    .select("group_id, is_banned, groups(id, name)")
    .eq("user_id", userId)
    .eq("is_banned", false);
  return memberships || [];
}

async function getUserAdminGroups(userId: string) {
  const { data } = await supabase
    .from("group_admins")
    .select("group_id, groups(id, name)")
    .eq("user_id", userId);
  return data || [];
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const dayOfWeek = DAYS_RU[d.getDay()];
  const day = d.getDate();
  const month = MONTHS_RU[d.getMonth()];
  return `${dayOfWeek}, ${day} ${month}`;
}

function formatTime(time: string): string {
  return time.substring(0, 5);
}

// ===== Generate sessions for a group =====
async function generateSessions(groupId: string) {
  const { data: schedules } = await supabase
    .from("schedules")
    .select("*")
    .eq("group_id", groupId);

  if (!schedules || schedules.length === 0) return;

  const { data: group } = await supabase
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
        // Try insert, ignore conflict
        await supabase
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
async function handleStart(chatId: number, user: any, startParam?: string) {
  // Handle deep link for joining
  if (startParam?.startsWith("join_")) {
    const inviteCode = startParam.substring(5);
    const { data: group } = await supabase
      .from("groups")
      .select("*")
      .eq("invite_code", inviteCode)
      .single();

    if (!group) {
      await sendMessage(chatId, "❌ Группа не найдена или ссылка недействительна.");
      return;
    }

    // Check if already member
    const { data: existing } = await supabase
      .from("group_members")
      .select("id, is_banned")
      .eq("group_id", group.id)
      .eq("user_id", user.id)
      .single();

    if (existing?.is_banned) {
      await sendMessage(chatId, `❌ Вы заблокированы в группе «${group.name}».`);
      return;
    }

    if (existing) {
      await sendMessage(chatId, `Вы уже участник группы «${group.name}» ✅`);
    } else {
      await supabase.from("group_members").insert({
        group_id: group.id,
        user_id: user.id,
      });
      await sendMessage(chatId, `🎉 Вы вступили в группу «${group.name}»!`);
    }
  }

  // Show main menu
  const isAdmin = user.is_super_admin || (await getUserAdminGroups(user.id)).length > 0;

  const buttons: any[][] = [
    [{ text: "📋 Мои группы", callback_data: "my_groups" }],
    [{ text: "📝 Расписание", callback_data: "schedule" }],
    [{ text: "👤 Мой профиль", callback_data: "profile" }],
  ];

  if (isAdmin) {
    buttons.push([{ text: "⚙️ Управление", callback_data: "admin" }]);
  }

  await sendMessage(
    chatId,
    `Привет, <b>${user.first_name || "друг"}</b>! 🏓\n\nЯ бот для бронирования тренировок по настольному теннису.\n\nВыберите действие:`,
    { inline_keyboard: buttons }
  );
}

async function handleMyGroups(chatId: number, messageId: number, user: any) {
  const groups = await getUserGroups(user.id);

  if (groups.length === 0) {
    await editMessage(chatId, messageId, "У вас пока нет групп. Попросите ссылку-приглашение у администратора.", {
      inline_keyboard: [[{ text: "« Назад", callback_data: "main_menu" }]],
    });
    return;
  }

  const buttons = groups.map((m: any) => [
    { text: `🏓 ${m.groups.name}`, callback_data: `group_${m.group_id}` },
  ]);
  buttons.push([{ text: "« Назад", callback_data: "main_menu" }]);

  await editMessage(chatId, messageId, "📋 <b>Ваши группы:</b>", {
    inline_keyboard: buttons,
  });
}

async function handleSchedule(chatId: number, messageId: number, user: any) {
  const groups = await getUserGroups(user.id);

  if (groups.length === 0) {
    await editMessage(chatId, messageId, "Вы не состоите ни в одной группе.", {
      inline_keyboard: [[{ text: "« Назад", callback_data: "main_menu" }]],
    });
    return;
  }

  if (groups.length === 1) {
    await showGroupSchedule(chatId, messageId, user, groups[0].group_id, "main_menu");
    return;
  }

  const buttons = groups.map((m: any) => [
    { text: `📅 ${m.groups.name}`, callback_data: `sched_${m.group_id}` },
  ]);
  buttons.push([{ text: "« Назад", callback_data: "main_menu" }]);

  await editMessage(chatId, messageId, "Выберите группу для просмотра расписания:", {
    inline_keyboard: buttons,
  });
}

async function showGroupSchedule(chatId: number, messageId: number, user: any, groupId: string, backCallbackData = "schedule") {
  // Generate sessions on demand
  await generateSessions(groupId);

  const { data: group } = await supabase
    .from("groups")
    .select("name, freeze_hours")
    .eq("id", groupId)
    .single();

  const today = new Date().toISOString().split("T")[0];
  const { data: sessions } = await supabase
    .from("sessions")
    .select("*")
    .eq("group_id", groupId)
    .eq("status", "scheduled")
    .gte("date", today)
    .order("date", { ascending: true })
    .order("start_time", { ascending: true })
    .limit(20);

  if (!sessions || sessions.length === 0) {
    await editMessage(chatId, messageId, `📅 <b>${group?.name}</b>\n\nНет запланированных тренировок.`, {
      inline_keyboard: [[{ text: "« Назад", callback_data: backCallbackData }]],
    });
    return;
  }

  // Get bookings for these sessions
  const sessionIds = sessions.map((s) => s.id);
  const { data: allBookings } = await supabase
    .from("bookings")
    .select("*")
    .in("session_id", sessionIds)
    .in("status", ["active", "waitlist"]);

  const { data: myBookings } = await supabase
    .from("bookings")
    .select("*")
    .in("session_id", sessionIds)
    .eq("user_id", user.id)
    .in("status", ["active", "waitlist"]);

  let text = `📅 <b>${group?.name}</b> — Расписание:\n\n`;
  const buttons: any[][] = [];

  for (const s of sessions) {
    const activeCount = (allBookings || []).filter(
      (b) => b.session_id === s.id && b.status === "active"
    ).length;
    const waitlistCount = (allBookings || []).filter(
      (b) => b.session_id === s.id && b.status === "waitlist"
    ).length;
    const myBooking = (myBookings || []).find((b) => b.session_id === s.id);

    const dateStr = formatDate(s.date);
    const timeStr = `${formatTime(s.start_time)}–${formatTime(s.end_time)}`;

    text += `📅 <b>${dateStr}</b>, ${timeStr}\n`;
    text += `👥 ${activeCount}/${s.max_participants} мест`;
    if (waitlistCount > 0) text += ` | Очередь: ${waitlistCount}`;

    if (myBooking) {
      if (myBooking.status === "active") {
        text += `\n✅ Вы записаны`;
      } else {
        text += `\n⏳ Вы в очереди (позиция ${myBooking.waitlist_position})`;
      }
    }
    text += "\n\n";

    // Check freeze
    const sessionDateTime = new Date(`${s.date}T${s.start_time}`);
    const now = new Date();
    const hoursUntil = (sessionDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);
    const isFrozen = hoursUntil <= (group?.freeze_hours || 4);

    if (myBooking && myBooking.status === "active" && !isFrozen) {
      buttons.push([{ text: `❌ Отменить ${dateStr} ${formatTime(s.start_time)}`, callback_data: `cancel_${s.id}` }]);
    } else if (myBooking && myBooking.status === "waitlist") {
      buttons.push([{ text: `❌ Покинуть очередь ${dateStr}`, callback_data: `cancel_wl_${s.id}` }]);
    } else if (!myBooking && !isFrozen) {
      buttons.push([{ text: `✅ Записаться ${dateStr} ${formatTime(s.start_time)}`, callback_data: `book_${s.id}` }]);
    }
  }

  buttons.push([{ text: "« Назад", callback_data: backCallbackData }]);

  await editMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

async function handleBook(chatId: number, messageId: number, user: any, sessionId: string) {
  // Check if member is banned
  const { data: session } = await supabase
    .from("sessions")
    .select("*, groups(name, freeze_hours, max_participants)")
    .eq("id", sessionId)
    .single();

  if (!session || session.status !== "scheduled") {
    await answerCallback("", "Тренировка недоступна");
    return;
  }

  const { data: membership } = await supabase
    .from("group_members")
    .select("is_banned")
    .eq("group_id", session.group_id)
    .eq("user_id", user.id)
    .single();

  if (membership?.is_banned) {
    const { data: strikes } = await supabase
      .from("strikes")
      .select("id")
      .eq("user_id", user.id)
      .eq("group_id", session.group_id)
      .gt("expires_at", new Date().toISOString());

    await editMessage(
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
    await editMessage(chatId, messageId, "⏰ Запись закрыта (заморозка).", {
      inline_keyboard: [[{ text: "« Назад", callback_data: `sched_${session.group_id}` }]],
    });
    return;
  }

  // Count active bookings
  const { data: activeBookings } = await supabase
    .from("bookings")
    .select("id")
    .eq("session_id", sessionId)
    .eq("status", "active");

  const activeCount = activeBookings?.length || 0;
  const maxP = session.max_participants;

  if (activeCount < maxP) {
    // Active booking
    const { error } = await supabase.from("bookings").insert({
      session_id: sessionId,
      user_id: user.id,
      status: "active",
    });
    if (error) {
      if (error.code === "23505") {
        await editMessage(chatId, messageId, "Вы уже записаны на эту тренировку.", {
          inline_keyboard: [[{ text: "« Назад", callback_data: `sched_${session.group_id}` }]],
        });
      } else {
        await editMessage(chatId, messageId, "Ошибка при записи. Попробуйте позже.", {
          inline_keyboard: [[{ text: "« Назад", callback_data: `sched_${session.group_id}` }]],
        });
      }
      return;
    }
    await editMessage(
      chatId,
      messageId,
      `✅ Вы записаны на тренировку!\n\n📅 ${formatDate(session.date)}, ${formatTime(session.start_time)}–${formatTime(session.end_time)}`,
      { inline_keyboard: [[{ text: "« К расписанию", callback_data: `sched_${session.group_id}` }]] }
    );
  } else {
    // Waitlist
    const { data: wlBookings } = await supabase
      .from("bookings")
      .select("id")
      .eq("session_id", sessionId)
      .eq("status", "waitlist");

    const position = (wlBookings?.length || 0) + 1;

    const { error } = await supabase.from("bookings").insert({
      session_id: sessionId,
      user_id: user.id,
      status: "waitlist",
      waitlist_position: position,
    });

    if (error) {
      await editMessage(chatId, messageId, "Ошибка при записи. Попробуйте позже.", {
        inline_keyboard: [[{ text: "« Назад", callback_data: `sched_${session.group_id}` }]],
      });
      return;
    }

    await editMessage(
      chatId,
      messageId,
      `⏳ Мест нет. Вы в листе ожидания (позиция ${position}).\n\nЕсли место освободится, вы будете записаны автоматически.\n\n📅 ${formatDate(session.date)}, ${formatTime(session.start_time)}–${formatTime(session.end_time)}`,
      { inline_keyboard: [[{ text: "« К расписанию", callback_data: `sched_${session.group_id}` }]] }
    );
  }
}

async function handleCancel(chatId: number, messageId: number, user: any, sessionId: string) {
  await editMessage(chatId, messageId, "Вы уверены, что хотите отменить запись?", {
    inline_keyboard: [
      [
        { text: "✅ Да, отменить", callback_data: `confirm_cancel_${sessionId}` },
        { text: "❌ Нет", callback_data: `sched_fromcancel_${sessionId}` },
      ],
    ],
  });
}

async function handleConfirmCancel(chatId: number, messageId: number, user: any, sessionId: string) {
  const { data: session } = await supabase
    .from("sessions")
    .select("*, groups(freeze_hours)")
    .eq("id", sessionId)
    .single();

  if (!session) return;

  // Check freeze
  const sessionDateTime = new Date(`${session.date}T${session.start_time}`);
  const now = new Date();
  const hoursUntil = (sessionDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);
  if (hoursUntil <= (session.groups?.freeze_hours || 4)) {
    await editMessage(chatId, messageId, "⏰ Отмена невозможна — запись заморожена.", {
      inline_keyboard: [[{ text: "« К расписанию", callback_data: `sched_${session.group_id}` }]],
    });
    return;
  }

  // Cancel the booking
  await supabase
    .from("bookings")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("user_id", user.id)
    .in("status", ["active"]);

  // Promote from waitlist
  const { data: nextInLine } = await supabase
    .from("bookings")
    .select("*, bot_users(telegram_id)")
    .eq("session_id", sessionId)
    .eq("status", "waitlist")
    .order("waitlist_position", { ascending: true })
    .limit(1)
    .single();

  if (nextInLine) {
    await supabase
      .from("bookings")
      .update({ status: "active", waitlist_position: null })
      .eq("id", nextInLine.id);

    // Notify promoted user
    if (nextInLine.bot_users?.telegram_id) {
      await sendMessage(
        nextInLine.bot_users.telegram_id,
        `🎉 Место освободилось! Вы записаны на тренировку:\n\n📅 ${formatDate(session.date)}, ${formatTime(session.start_time)}–${formatTime(session.end_time)}`
      );
    }
  }

  await editMessage(chatId, messageId, "✅ Запись отменена.", {
    inline_keyboard: [[{ text: "« К расписанию", callback_data: `sched_${session.group_id}` }]],
  });
}

async function handleCancelWaitlist(chatId: number, messageId: number, user: any, sessionId: string) {
  await supabase
    .from("bookings")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("user_id", user.id)
    .eq("status", "waitlist");

  const { data: session } = await supabase
    .from("sessions")
    .select("group_id")
    .eq("id", sessionId)
    .single();

  await editMessage(chatId, messageId, "✅ Вы покинули лист ожидания.", {
    inline_keyboard: [[{ text: "« К расписанию", callback_data: `sched_${session?.group_id}` }]],
  });
}

async function handleProfile(chatId: number, messageId: number, user: any) {
  const groups = await getUserGroups(user.id);
  
  // Count upcoming bookings
  const today = new Date().toISOString().split("T")[0];
  const { data: upcomingBookings } = await supabase
    .from("bookings")
    .select("id, sessions(date)")
    .eq("user_id", user.id)
    .eq("status", "active");
  
  const upcoming = (upcomingBookings || []).filter(
    (b: any) => b.sessions?.date >= today
  ).length;

  // Count active strikes
  const { data: strikes } = await supabase
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

  await editMessage(chatId, messageId, text, {
    inline_keyboard: [[{ text: "« Назад", callback_data: "main_menu" }]],
  });
}

// ===== Admin handlers =====
async function handleAdmin(chatId: number, messageId: number, user: any) {
  const adminGroups = await getUserAdminGroups(user.id);
  
  const buttons: any[][] = [];

  if (user.is_super_admin) {
    buttons.push([{ text: "➕ Создать группу", callback_data: "sa_create_group" }]);
    buttons.push([{ text: "📋 Все группы", callback_data: "sa_all_groups" }]);
  }

  for (const ag of adminGroups) {
    buttons.push([{ text: `⚙️ ${(ag as any).groups?.name}`, callback_data: `admin_group_${ag.group_id}` }]);
  }

  buttons.push([{ text: "« Назад", callback_data: "main_menu" }]);

  await editMessage(chatId, messageId, "⚙️ <b>Панель управления</b>", {
    inline_keyboard: buttons,
  });
}

async function handleAdminGroup(chatId: number, messageId: number, user: any, groupId: string) {
  const { data: group } = await supabase
    .from("groups")
    .select("*")
    .eq("id", groupId)
    .single();

  if (!group) return;

  const { data: members } = await supabase
    .from("group_members")
    .select("id")
    .eq("group_id", groupId)
    .eq("is_banned", false);

  const botName = "your_bot"; // Will be replaced

  let text = `⚙️ <b>${group.name}</b>\n\n`;
  text += `👥 Участников: ${members?.length || 0}\n`;
  text += `🔢 Макс. мест: ${group.max_participants}\n`;
  text += `⏰ Заморозка: ${group.freeze_hours}ч\n`;
  text += `🔗 Инвайт: <code>t.me/${botName}?start=join_${group.invite_code}</code>`;

  const buttons = [
    [{ text: "📅 Расписание группы", callback_data: `admin_sched_${groupId}` }],
    [{ text: "📅 Управление расписанием", callback_data: `asched_list_${groupId}` }],
    [{ text: "👥 Участники", callback_data: `admin_members_${groupId}` }],
    [{ text: "⚠️ Страйки", callback_data: `admin_strikes_${groupId}` }],
    [{ text: "🔗 Новая инвайт-ссылка", callback_data: `admin_newinvite_${groupId}` }],
    [{ text: "✏️ Редактировать", callback_data: `aedit_${groupId}` }, { text: "🗑 Удалить", callback_data: `adel_${groupId}` }],
    [{ text: "« Назад", callback_data: "admin" }],
  ];

  await editMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

async function handleAdminSchedule(chatId: number, messageId: number, user: any, groupId: string) {
  await generateSessions(groupId);

  const today = new Date().toISOString().split("T")[0];
  const { data: sessions } = await supabase
    .from("sessions")
    .select("*")
    .eq("group_id", groupId)
    .gte("date", today)
    .order("date")
    .order("start_time")
    .limit(14);

  if (!sessions || sessions.length === 0) {
    await editMessage(chatId, messageId, "Нет тренировок. Настройте расписание.", {
      inline_keyboard: [[{ text: "« Назад", callback_data: `admin_group_${groupId}` }]],
    });
    return;
  }

  const sessionIds = sessions.map((s) => s.id);
  const { data: allBookings } = await supabase
    .from("bookings")
    .select("*")
    .in("session_id", sessionIds)
    .in("status", ["active", "waitlist"]);

  let text = "📅 <b>Тренировки (админ):</b>\n\n";
  const buttons: any[][] = [];

  for (const s of sessions) {
    const active = (allBookings || []).filter((b) => b.session_id === s.id && b.status === "active").length;
    const wl = (allBookings || []).filter((b) => b.session_id === s.id && b.status === "waitlist").length;
    const dateStr = formatDate(s.date);
    text += `${dateStr}, ${formatTime(s.start_time)}–${formatTime(s.end_time)} | 👥 ${active}/${s.max_participants}`;
    if (wl > 0) text += ` +${wl}⏳`;
    text += "\n";

    buttons.push([
      { text: `📋 ${dateStr} ${formatTime(s.start_time)}`, callback_data: `admin_session_${s.id}` },
      { text: "❌ Отменить", callback_data: `admin_cancel_session_${s.id}` },
    ]);
  }

  buttons.push([{ text: "« Назад", callback_data: `admin_group_${groupId}` }]);
  await editMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

async function handleAdminCancelSession(chatId: number, messageId: number, sessionId: string) {
  await editMessage(chatId, messageId, "Вы уверены, что хотите отменить тренировку? Все участники получат уведомление.", {
    inline_keyboard: [
      [
        { text: "✅ Да", callback_data: `admin_confirm_cancel_${sessionId}` },
        { text: "❌ Нет", callback_data: `admin_sched_fromcancel_${sessionId}` },
      ],
    ],
  });
}

async function handleAdminConfirmCancelSession(chatId: number, messageId: number, sessionId: string) {
  const { data: session } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .single();

  if (!session) return;

  await supabase.from("sessions").update({ status: "cancelled" }).eq("id", sessionId);

  // Notify all booked users
  const { data: bookings } = await supabase
    .from("bookings")
    .select("*, bot_users(telegram_id)")
    .eq("session_id", sessionId)
    .in("status", ["active", "waitlist"]);

  for (const b of bookings || []) {
    if ((b as any).bot_users?.telegram_id) {
      await sendMessage(
        (b as any).bot_users.telegram_id,
        `❌ Тренировка отменена администратором:\n\n📅 ${formatDate(session.date)}, ${formatTime(session.start_time)}–${formatTime(session.end_time)}`
      );
    }
    await supabase.from("bookings").update({ status: "cancelled" }).eq("id", b.id);
  }

  await editMessage(chatId, messageId, "✅ Тренировка отменена. Участники уведомлены.", {
    inline_keyboard: [[{ text: "« К расписанию", callback_data: `admin_sched_${session.group_id}` }]],
  });
}

// ===== Main handler =====
async function handleUpdate(update: any) {
  // Handle /start command
  if (update.message?.text?.startsWith("/start")) {
    const from = update.message.from;
    const user = await getOrCreateUser(from);
    const startParam = update.message.text.split(" ")[1];
    await handleStart(update.message.chat.id, user, startParam);
    return;
  }

  // Handle callback queries
  if (update.callback_query) {
    const cq = update.callback_query;
    const from = cq.from;
    const chatId = cq.message.chat.id;
    const messageId = cq.message.message_id;
    const data = cq.data;
    const user = await getOrCreateUser(from);

    await answerCallback(cq.id);

    if (data === "main_menu") {
      // Re-show main menu by editing
      const isAdmin = user.is_super_admin || (await getUserAdminGroups(user.id)).length > 0;
      const buttons: any[][] = [
        [{ text: "📋 Мои группы", callback_data: "my_groups" }],
        [{ text: "📝 Расписание", callback_data: "schedule" }],
        [{ text: "👤 Мой профиль", callback_data: "profile" }],
      ];
      if (isAdmin) buttons.push([{ text: "⚙️ Управление", callback_data: "admin" }]);
      await editMessage(chatId, messageId, `🏓 <b>Главное меню</b>\n\nВыберите действие:`, { inline_keyboard: buttons });
    } else if (data === "my_groups") {
      await handleMyGroups(chatId, messageId, user);
    } else if (data === "schedule") {
      await handleSchedule(chatId, messageId, user);
    } else if (data === "profile") {
      await handleProfile(chatId, messageId, user);
    } else if (data === "admin") {
      await handleAdmin(chatId, messageId, user);
    } else if (data.startsWith("sched_fromcancel_")) {
      const sessionId = data.replace("sched_fromcancel_", "");
      const { data: session } = await supabase.from("sessions").select("group_id").eq("id", sessionId).single();
      if (session) await showGroupSchedule(chatId, messageId, user, session.group_id);
    } else if (data.startsWith("sched_")) {
      const groupId = data.replace("sched_", "");
      await showGroupSchedule(chatId, messageId, user, groupId);
    } else if (data.startsWith("group_")) {
      const groupId = data.replace("group_", "");
      await showGroupSchedule(chatId, messageId, user, groupId);
    } else if (data.startsWith("book_")) {
      const sessionId = data.replace("book_", "");
      await handleBook(chatId, messageId, user, sessionId);
    } else if (data.startsWith("cancel_wl_")) {
      const sessionId = data.replace("cancel_wl_", "");
      await handleCancelWaitlist(chatId, messageId, user, sessionId);
    } else if (data.startsWith("confirm_cancel_")) {
      const sessionId = data.replace("confirm_cancel_", "");
      await handleConfirmCancel(chatId, messageId, user, sessionId);
    } else if (data.startsWith("cancel_")) {
      const sessionId = data.replace("cancel_", "");
      await handleCancel(chatId, messageId, user, sessionId);
    } else if (data.startsWith("admin_group_")) {
      const groupId = data.replace("admin_group_", "");
      await handleAdminGroup(chatId, messageId, user, groupId);
    } else if (data.startsWith("admin_sched_fromcancel_")) {
      const sessionId = data.replace("admin_sched_fromcancel_", "");
      const { data: session } = await supabase.from("sessions").select("group_id").eq("id", sessionId).single();
      if (session) await handleAdminSchedule(chatId, messageId, user, session.group_id);
    } else if (data.startsWith("admin_confirm_cancel_")) {
      const sessionId = data.replace("admin_confirm_cancel_", "");
      await handleAdminConfirmCancelSession(chatId, messageId, sessionId);
    } else if (data.startsWith("admin_cancel_session_")) {
      const sessionId = data.replace("admin_cancel_session_", "");
      await handleAdminCancelSession(chatId, messageId, sessionId);
    } else if (data.startsWith("admin_sched_")) {
      const groupId = data.replace("admin_sched_", "");
      await handleAdminSchedule(chatId, messageId, user, groupId);
    } else if (data === "sa_create_group") {
      await sendMessage(chatId, "Отправьте название новой группы текстовым сообщением.\n\nФормат: <code>/newgroup Название группы</code>");
    } else if (data === "sa_all_groups") {
      const { data: groups } = await supabase.from("groups").select("*").order("created_at");
      if (!groups || groups.length === 0) {
        await editMessage(chatId, messageId, "Групп пока нет.", {
          inline_keyboard: [[{ text: "« Назад", callback_data: "admin" }]],
        });
        return;
      }
      let text = "📋 <b>Все группы:</b>\n\n";
      const btns: any[][] = [];
      for (const g of groups) {
        text += `• ${g.name}\n`;
        btns.push([{ text: `⚙️ ${g.name}`, callback_data: `admin_group_${g.id}` }]);
      }
      btns.push([{ text: "« Назад", callback_data: "admin" }]);
      await editMessage(chatId, messageId, text, { inline_keyboard: btns });
    } else if (data.startsWith("admin_newinvite_")) {
      const groupId = data.replace("admin_newinvite_", "");
      const newCode = crypto.randomUUID().substring(0, 12);
      await supabase.from("groups").update({ invite_code: newCode }).eq("id", groupId);
      await editMessage(chatId, messageId, `🔗 Новая ссылка создана!\n\nКод: <code>${newCode}</code>`, {
        inline_keyboard: [[{ text: "« Назад", callback_data: `admin_group_${groupId}` }]],
      });
    } else if (data.startsWith("admin_members_")) {
      const groupId = data.replace("admin_members_", "");
      const { data: members } = await supabase
        .from("group_members")
        .select("*, bot_users(first_name, username, telegram_id)")
        .eq("group_id", groupId);

      let text = "👥 <b>Участники:</b>\n\n";
      for (const m of members || []) {
        const u = (m as any).bot_users;
        const name = u?.first_name || u?.username || `ID:${u?.telegram_id}`;
        text += `${m.is_banned ? "🚫" : "✅"} ${name}`;
        if (u?.username) text += ` (@${u.username})`;
        text += "\n";
      }
      await editMessage(chatId, messageId, text, {
        inline_keyboard: [[{ text: "« Назад", callback_data: `admin_group_${groupId}` }]],
      });
    } else if (data.startsWith("admin_strikes_")) {
      const groupId = data.replace("admin_strikes_", "");
      const { data: strikes } = await supabase
        .from("strikes")
        .select("*, bot_users(first_name, username)")
        .eq("group_id", groupId)
        .gt("expires_at", new Date().toISOString());

      if (!strikes || strikes.length === 0) {
        await editMessage(chatId, messageId, "⚠️ Активных страйков нет.", {
          inline_keyboard: [[{ text: "« Назад", callback_data: `admin_group_${groupId}` }]],
        });
        return;
      }

      let text = "⚠️ <b>Активные страйки:</b>\n\n";
      for (const s of strikes) {
        const u = (s as any).bot_users;
        text += `• ${u?.first_name || u?.username || "?"} — ${new Date(s.created_at).toLocaleDateString("ru")}\n`;
      }
      await editMessage(chatId, messageId, text, {
        inline_keyboard: [[{ text: "« Назад", callback_data: `admin_group_${groupId}` }]],
      });
    } else if (data.startsWith("aedit_max_")) {
      const groupId = data.replace("aedit_max_", "");
      const { data: group } = await supabase.from("groups").select("max_participants").eq("id", groupId).single();
      const current = group?.max_participants || 8;
      const options = [4, 6, 8, 10, 12, 16, 20];
      const buttons = options.map((v) => ({
        text: v === current ? `✅ ${v}` : `${v}`,
        callback_data: `aset_max_${v}_${groupId}`,
      }));
      const rows: any[][] = [];
      for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
      rows.push([{ text: "« Назад", callback_data: `aedit_${groupId}` }]);
      await editMessage(chatId, messageId, `👥 Выберите макс. количество участников (сейчас: ${current}):`, { inline_keyboard: rows });
    } else if (data.startsWith("aedit_freeze_")) {
      const groupId = data.replace("aedit_freeze_", "");
      const { data: group } = await supabase.from("groups").select("freeze_hours").eq("id", groupId).single();
      const current = group?.freeze_hours || 4;
      const options = [1, 2, 3, 4, 6, 8, 12, 24];
      const buttons = options.map((v) => ({
        text: v === current ? `✅ ${v}ч` : `${v}ч`,
        callback_data: `aset_freeze_${v}_${groupId}`,
      }));
      const rows: any[][] = [];
      for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
      rows.push([{ text: "« Назад", callback_data: `aedit_${groupId}` }]);
      await editMessage(chatId, messageId, `⏰ Выберите часы заморозки (сейчас: ${current}):`, { inline_keyboard: rows });
    } else if (data.startsWith("aedit_text_")) {
      const groupId = data.replace("aedit_text_", "");
      const shortId = groupId.substring(0, 8);
      await editMessage(chatId, messageId,
        `Для изменения названия или часового пояса используйте команды:\n\n` +
        `📝 <code>/editgroup ${shortId} name Новое название</code>\n` +
        `🌍 <code>/editgroup ${shortId} timezone Europe/Berlin</code>`,
        { inline_keyboard: [[{ text: "« Назад", callback_data: `aedit_${groupId}` }]] }
      );
    } else if (data.startsWith("aset_max_") || data.startsWith("aset_freeze_")) {
      const isMax = data.startsWith("aset_max_");
      const rest = data.replace(isMax ? "aset_max_" : "aset_freeze_", "");
      const underscoreIdx = rest.indexOf("_");
      const value = parseInt(rest.substring(0, underscoreIdx));
      const groupId = rest.substring(underscoreIdx + 1);
      const dbField = isMax ? "max_participants" : "freeze_hours";
      await supabase.from("groups").update({ [dbField]: value }).eq("id", groupId);
      const label = isMax ? "Макс. участников" : "Заморозка";
      const suffix = isMax ? "" : "ч";
      await editMessage(chatId, messageId, `✅ ${label} изменено на <b>${value}${suffix}</b>`, {
        inline_keyboard: [
          [{ text: "✏️ Продолжить редактирование", callback_data: `aedit_${groupId}` }],
          [{ text: "« К группе", callback_data: `admin_group_${groupId}` }],
        ],
      });
    } else if (data.startsWith("aedit_")) {
      const groupId = data.replace("aedit_", "");
      const { data: group } = await supabase.from("groups").select("*").eq("id", groupId).single();
      if (!group) return;
      let text = `✏️ <b>Редактирование «${group.name}»</b>\n\n`;
      text += `📝 Название: ${group.name}\n`;
      text += `👥 Макс. участников: ${group.max_participants}\n`;
      text += `⏰ Заморозка: ${group.freeze_hours}ч\n`;
      text += `🌍 Часовой пояс: ${group.timezone}\n\nВыберите параметр для изменения:`;
      await editMessage(chatId, messageId, text, {
        inline_keyboard: [
          [{ text: "👥 Макс. участников", callback_data: `aedit_max_${groupId}` }],
          [{ text: "⏰ Заморозка (часы)", callback_data: `aedit_freeze_${groupId}` }],
          [{ text: "📝 Название / 🌍 Часовой пояс", callback_data: `aedit_text_${groupId}` }],
          [{ text: "« Назад", callback_data: `admin_group_${groupId}` }],
        ],
      });
    } else if (data.startsWith("asched_confirm_del_")) {
      // asched_confirm_del_<scheduleId>
      const scheduleId = data.replace("asched_confirm_del_", "");
      const { data: schedule } = await supabase
        .from("schedules")
        .select("id, group_id")
        .eq("id", scheduleId)
        .single();
      if (!schedule) {
        await editMessage(chatId, messageId, "❌ Расписание не найдено.");
        return;
      }
      const groupId = schedule.group_id;
      // Check admin
      const admin = await isGroupAdmin(user.id, groupId);
      if (!admin && !user.is_super_admin) return;
      // Cancel future sessions linked to schedule
      const today = new Date().toISOString().split("T")[0];
      const { data: futureSessions } = await supabase.from("sessions").select("id").eq("schedule_id", scheduleId).gte("date", today);
      for (const s of futureSessions || []) {
        await supabase.from("bookings").update({ status: "cancelled", cancelled_at: new Date().toISOString() }).eq("session_id", s.id).in("status", ["active", "waitlist"]);
      }
      await supabase.from("sessions").delete().eq("schedule_id", scheduleId).gte("date", today);
      await supabase.from("schedules").delete().eq("id", scheduleId);
      await editMessage(chatId, messageId, "✅ Расписание и связанные будущие сессии удалены.", {
        inline_keyboard: [
          [{ text: "📅 К расписанию", callback_data: `asched_list_${groupId}` }],
          [{ text: "« К группе", callback_data: `admin_group_${groupId}` }],
        ],
      });
    } else if (data.startsWith("asched_del_")) {
      // asched_del_<scheduleId>
      const scheduleId = data.replace("asched_del_", "");
      const { data: schedule } = await supabase.from("schedules").select("*").eq("id", scheduleId).single();
      const DAYS_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
      if (!schedule) {
        await editMessage(chatId, messageId, "❌ Расписание не найдено.");
        return;
      }
      const groupId = schedule.group_id;
      await editMessage(chatId, messageId,
        `⚠️ Удалить расписание?\n\n${DAYS_FULL[schedule.day_of_week]} ${formatTime(schedule.start_time)}–${formatTime(schedule.end_time)}\n\nБудущие сессии по этому шаблону также будут удалены.`,
        {
          inline_keyboard: [
            [
              { text: "✅ Да, удалить", callback_data: `asched_confirm_del_${scheduleId}` },
              { text: "❌ Нет", callback_data: `asched_list_${groupId}` },
            ],
          ],
        }
      );
    } else if (data.startsWith("asched_save_")) {
      // asched_save_<day>_<startTime>_<endTime>_<groupId>
      const rest = data.replace("asched_save_", "");
      const parts = rest.split("_");
      const day = parseInt(parts[0]);
      const startTime = parts[1];
      const endTime = parts[2];
      const groupId = parts.slice(3).join("_");
      const DAYS_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
      await supabase.from("schedules").insert({ group_id: groupId, day_of_week: day, start_time: startTime, end_time: endTime });
      await generateSessions(groupId);
      await editMessage(chatId, messageId,
        `✅ Расписание добавлено!\n\n${DAYS_FULL[day]} ${startTime}–${endTime}\n\nСессии сгенерированы на 2 недели вперёд.`,
        {
          inline_keyboard: [
            [{ text: "➕ Добавить ещё", callback_data: `asched_add_${groupId}` }],
            [{ text: "📅 К расписанию", callback_data: `asched_list_${groupId}` }],
            [{ text: "« К группе", callback_data: `admin_group_${groupId}` }],
          ],
        }
      );
    } else if (data.startsWith("asched_end_")) {
      // asched_end_<day>_<startTime>_<groupId>
      const rest = data.replace("asched_end_", "");
      const parts = rest.split("_");
      const day = parseInt(parts[0]);
      const startTime = parts[1];
      const groupId = parts.slice(2).join("_");
      const DAYS_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
      const PRESET_END = ["09:00", "10:00", "11:00", "12:00", "13:00", "15:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00", "23:00"];
      const validEndTimes = PRESET_END.filter(t => t > startTime);
      const buttons: any[][] = [];
      for (let i = 0; i < validEndTimes.length; i += 4) {
        buttons.push(validEndTimes.slice(i, i + 4).map(t => ({ text: t, callback_data: `asched_save_${day}_${startTime}_${t}_${groupId}` })));
      }
      buttons.push([{ text: "« Назад", callback_data: `asched_start_${day}_${groupId}` }]);
      await editMessage(chatId, messageId, `⏰ ${DAYS_FULL[day]}, начало ${startTime} — выберите время окончания:`, { inline_keyboard: buttons });
    } else if (data.startsWith("asched_start_")) {
      // asched_start_<day>_<groupId>
      const rest = data.replace("asched_start_", "");
      const underIdx = rest.indexOf("_");
      const day = parseInt(rest.substring(0, underIdx));
      const groupId = rest.substring(underIdx + 1);
      const DAYS_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
      const PRESET_START = ["08:00", "09:00", "10:00", "11:00", "12:00", "14:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00"];
      const buttons: any[][] = [];
      for (let i = 0; i < PRESET_START.length; i += 4) {
        buttons.push(PRESET_START.slice(i, i + 4).map(t => ({ text: t, callback_data: `asched_end_${day}_${t}_${groupId}` })));
      }
      buttons.push([{ text: "« Назад", callback_data: `asched_add_${groupId}` }]);
      await editMessage(chatId, messageId, `⏰ ${DAYS_FULL[day]} — выберите время начала:`, { inline_keyboard: buttons });
    } else if (data.startsWith("asched_add_")) {
      const groupId = data.replace("asched_add_", "");
      const DAYS_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
      const dayPairs = [[1, 2], [3, 4], [5, 6], [0]];
      const buttons: any[][] = [];
      for (const pair of dayPairs) {
        buttons.push(pair.map(d => ({ text: DAYS_FULL[d], callback_data: `asched_start_${d}_${groupId}` })));
      }
      buttons.push([{ text: "« Назад", callback_data: `asched_list_${groupId}` }]);
      await editMessage(chatId, messageId, "📅 Выберите день недели:", { inline_keyboard: buttons });
    } else if (data.startsWith("asched_list_")) {
      const groupId = data.replace("asched_list_", "");
      const admin = await isGroupAdmin(user.id, groupId);
      if (!admin && !user.is_super_admin) return;
      const DAYS_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
      const { data: schedules } = await supabase.from("schedules").select("*").eq("group_id", groupId).order("day_of_week").order("start_time");
      let text = "📅 <b>Шаблоны расписания</b>\n\n";
      const buttons: any[][] = [];
      if (!schedules || schedules.length === 0) {
        text += "Расписание пока не настроено.\n";
      } else {
        for (const s of schedules) {
          text += `• ${DAYS_FULL[s.day_of_week]} ${formatTime(s.start_time)}–${formatTime(s.end_time)}\n`;
          buttons.push([{ text: `🗑 ${DAYS_RU[s.day_of_week]} ${formatTime(s.start_time)}–${formatTime(s.end_time)}`, callback_data: `asched_del_${s.id}` }]);
        }
      }
      text += "\nНажмите ➕ чтобы добавить расписание на новый день.";
      buttons.push([{ text: "➕ Добавить расписание", callback_data: `asched_add_${groupId}` }]);
      buttons.push([{ text: "« Назад", callback_data: `admin_group_${groupId}` }]);
      await editMessage(chatId, messageId, text, { inline_keyboard: buttons });
    } else if (data.startsWith("adel_")) {
      const groupId = data.replace("adel_", "");
      if (!user.is_super_admin) {
        await editMessage(chatId, messageId, "❌ Только суперадмин может удалять группы.", {
          inline_keyboard: [[{ text: "« Назад", callback_data: `admin_group_${groupId}` }]],
        });
        return;
      }
      const { data: group } = await supabase.from("groups").select("name").eq("id", groupId).single();
      await editMessage(chatId, messageId,
        `⚠️ <b>Удаление группы «${group?.name}»</b>\n\nВсе данные будут удалены:\n• Участники и администраторы\n• Расписание и сессии\n• Бронирования и страйки\n\nВы уверены?`,
        {
          inline_keyboard: [
            [{ text: "✅ Да, удалить", callback_data: `aconfirm_del_${groupId}` }, { text: "❌ Нет", callback_data: `admin_group_${groupId}` }],
          ],
        }
      );
    } else if (data.startsWith("aconfirm_del_")) {
      const groupId = data.replace("aconfirm_del_", "");
      if (!user.is_super_admin) {
        await editMessage(chatId, messageId, "❌ Только суперадмин может удалять группы.", {
          inline_keyboard: [[{ text: "« Назад", callback_data: `admin_group_${groupId}` }]],
        });
        return;
      }
      const { data: group } = await supabase.from("groups").select("name").eq("id", groupId).single();
      if (!group) return;
      await supabase.from("group_admins").delete().eq("group_id", groupId);
      await supabase.from("group_members").delete().eq("group_id", groupId);
      await supabase.from("schedules").delete().eq("group_id", groupId);
      const today = new Date().toISOString().split("T")[0];
      const { data: futureSessions } = await supabase.from("sessions").select("id").eq("group_id", groupId).gte("date", today);
      for (const s of futureSessions || []) {
        await supabase.from("bookings").update({ status: "cancelled", cancelled_at: new Date().toISOString() }).eq("session_id", s.id).in("status", ["active", "waitlist"]);
      }
      await supabase.from("sessions").delete().eq("group_id", groupId);
      await supabase.from("strikes").delete().eq("group_id", groupId);
      await supabase.from("groups").delete().eq("id", groupId);
      await editMessage(chatId, messageId, `✅ Группа «${group.name}» удалена.`, {
        inline_keyboard: [[{ text: "« К управлению", callback_data: "admin" }]],
      });
    }
  }

  // Handle /newgroup command
  if (update.message?.text?.startsWith("/newgroup ")) {
    const from = update.message.from;
    const user = await getOrCreateUser(from);
    const chatId = update.message.chat.id;

    if (!user.is_super_admin) {
      await sendMessage(chatId, "❌ Только суперадмин может создавать группы.");
      return;
    }

    const name = update.message.text.substring(10).trim();
    if (!name) {
      await sendMessage(chatId, "Укажите название: <code>/newgroup Название</code>");
      return;
    }

    const { data: group } = await supabase
      .from("groups")
      .insert({ name, created_by: user.id })
      .select()
      .single();

    if (group) {
      // Make creator admin and member
      await supabase.from("group_admins").insert({ group_id: group.id, user_id: user.id });
      await supabase.from("group_members").insert({ group_id: group.id, user_id: user.id });

      await sendMessage(
        chatId,
        `✅ Группа «${name}» создана!\n\n🔗 Инвайт: <code>join_${group.invite_code}</code>\n\nТеперь настройте расписание: /schedule_${group.id.substring(0, 8)}`
      );
    }
  }

  // Handle /editgroup command: /editgroup GROUP_ID FIELD VALUE
  if (update.message?.text?.startsWith("/editgroup ")) {
    const from = update.message.from;
    const user = await getOrCreateUser(from);
    const chatId = update.message.chat.id;

    const parts = update.message.text.split(" ");
    if (parts.length < 4) {
      await sendMessage(chatId, "Формат: <code>/editgroup GROUP_ID ПОЛЕ ЗНАЧЕНИЕ</code>\n\nПоля: name, max, freeze, timezone\nПример: <code>/editgroup abc12345 max 10</code>");
      return;
    }

    const groupIdPrefix = parts[1];
    const field = parts[2];
    const value = parts.slice(3).join(" ");

    // Find group
    let group: any = null;
    const { data: exactMatch } = await supabase.from("groups").select("*").eq("id", groupIdPrefix).maybeSingle();
    if (exactMatch) {
      group = exactMatch;
    } else {
      const { data: allGroups } = await supabase.from("groups").select("*");
      group = (allGroups || []).find((g: any) => g.id.startsWith(groupIdPrefix));
    }
    if (!group) {
      await sendMessage(chatId, "❌ Группа не найдена.");
      return;
    }

    const admin = await isGroupAdmin(user.id, group.id);
    if (!admin && !user.is_super_admin) {
      await sendMessage(chatId, "❌ Вы не администратор этой группы.");
      return;
    }

    const allowedFields: Record<string, string> = { name: "name", max: "max_participants", freeze: "freeze_hours", timezone: "timezone" };
    const dbField = allowedFields[field];
    if (!dbField) {
      await sendMessage(chatId, "❌ Неизвестное поле. Допустимые: name, max, freeze, timezone.");
      return;
    }

    let parsedValue: any = value;
    if (field === "max" || field === "freeze") {
      parsedValue = parseInt(value);
      if (isNaN(parsedValue) || parsedValue <= 0) {
        await sendMessage(chatId, "❌ Значение должно быть положительным числом.");
        return;
      }
    }

    await supabase.from("groups").update({ [dbField]: parsedValue }).eq("id", group.id);
    await sendMessage(chatId, `✅ Группа «${group.name}» обновлена.\n\n${field} → <code>${parsedValue}</code>`);
  }

  // Handle /deletegroup command: /deletegroup GROUP_ID
  if (update.message?.text?.startsWith("/deletegroup ")) {
    const from = update.message.from;
    const user = await getOrCreateUser(from);
    const chatId = update.message.chat.id;

    if (!user.is_super_admin) {
      await sendMessage(chatId, "❌ Только суперадмин может удалять группы.");
      return;
    }

    const groupIdPrefix = update.message.text.split(" ")[1]?.trim();
    if (!groupIdPrefix) {
      await sendMessage(chatId, "Формат: <code>/deletegroup GROUP_ID</code>");
      return;
    }

    let group: any = null;
    const { data: exactMatch } = await supabase.from("groups").select("*").eq("id", groupIdPrefix).maybeSingle();
    if (exactMatch) {
      group = exactMatch;
    } else {
      const { data: allGroups } = await supabase.from("groups").select("*");
      group = (allGroups || []).find((g: any) => g.id.startsWith(groupIdPrefix));
    }
    if (!group) {
      await sendMessage(chatId, "❌ Группа не найдена.");
      return;
    }

    // Delete related data
    await supabase.from("group_admins").delete().eq("group_id", group.id);
    await supabase.from("group_members").delete().eq("group_id", group.id);
    await supabase.from("schedules").delete().eq("group_id", group.id);
    const today = new Date().toISOString().split("T")[0];
    const { data: futureSessions } = await supabase.from("sessions").select("id").eq("group_id", group.id).gte("date", today);
    for (const s of futureSessions || []) {
      await supabase.from("bookings").update({ status: "cancelled", cancelled_at: new Date().toISOString() }).eq("session_id", s.id).in("status", ["active", "waitlist"]);
    }
    await supabase.from("sessions").delete().eq("group_id", group.id);
    await supabase.from("strikes").delete().eq("group_id", group.id);
    await supabase.from("groups").delete().eq("id", group.id);

    await sendMessage(chatId, `✅ Группа «${group.name}» удалена.`);
  }

  // Handle /addschedule command: /addschedule GROUP_ID DAY START END
  if (update.message?.text?.startsWith("/addschedule ")) {
    const from = update.message.from;
    const user = await getOrCreateUser(from);
    const chatId = update.message.chat.id;

    const parts = update.message.text.split(" ");
    if (parts.length < 5) {
      await sendMessage(chatId, "Формат: <code>/addschedule GROUP_ID ДЕНЬ НАЧАЛО КОНЕЦ</code>\n\nДень: 0=Вс, 1=Пн, ..., 6=Сб\nПример: <code>/addschedule abc12345 2 20:00 21:30</code>");
      return;
    }

    const groupIdPrefix = parts[1];
    const dayOfWeek = parseInt(parts[2]);
    const startTime = parts[3];
    const endTime = parts[4];

    // Find group by prefix or full ID
    let group: any = null;
    // Try exact match first
    const { data: exactMatch } = await supabase.from("groups").select("id, name").eq("id", groupIdPrefix).maybeSingle();
    if (exactMatch) {
      group = exactMatch;
    } else {
      // Prefix search: fetch all groups and match
      const { data: allGroups } = await supabase.from("groups").select("id, name");
      group = (allGroups || []).find((g: any) => g.id.startsWith(groupIdPrefix));
    }
    if (!group) {
      await sendMessage(chatId, "Группа не найдена.");
      return;
    }

    const admin = await isGroupAdmin(user.id, group.id);
    if (!admin && !user.is_super_admin) {
      await sendMessage(chatId, "❌ Вы не администратор этой группы.");
      return;
    }

    await supabase.from("schedules").insert({
      group_id: group.id,
      day_of_week: dayOfWeek,
      start_time: startTime,
      end_time: endTime,
    });

    await generateSessions(group.id);

    await sendMessage(chatId, `✅ Расписание добавлено: ${DAYS_RU[dayOfWeek]} ${startTime}–${endTime}\n\nСессии сгенерированы на 2 недели вперёд.`);
  }
}

// ===== Deno.serve =====
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    const update = await req.json();
    await handleUpdate(update);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error:", error);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }
});
