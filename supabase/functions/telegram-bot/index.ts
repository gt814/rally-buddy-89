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
const SCHEDULE_HOURS = Array.from({ length: 16 }, (_, i) => String(i + 8).padStart(2, "0"));
const SCHEDULE_MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));

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

function isSessionCompletedNow(date: string, endTime: string): boolean {
  const sessionEnd = new Date(`${date}T${endTime}`);
  return sessionEnd.getTime() <= Date.now();
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
    [{ text: "📋 Группы", callback_data: "my_groups" }],
    [{ text: "📝 Расписание", callback_data: "schedule" }],
    [{ text: "📚 История", callback_data: "history" }],
    [{ text: "👤 Профиль", callback_data: "profile" }],
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
    { text: `🚪 ${m.groups.name}`, callback_data: `leave_group_${m.group_id}` },
  ]);
  buttons.push([{ text: "« Назад", callback_data: "main_menu" }]);

  await editMessage(chatId, messageId, "📋 <b>Ваши группы:</b>\n\nВыберите группу, чтобы выйти из неё.", {
    inline_keyboard: buttons,
  });
}

async function handleLeaveGroup(chatId: number, messageId: number, user: any, groupId: string) {
  const { data: membership } = await supabase
    .from("group_members")
    .select("group_id, groups(name)")
    .eq("group_id", groupId)
    .eq("user_id", user.id)
    .eq("is_banned", false)
    .maybeSingle();

  if (!membership) {
    await editMessage(chatId, messageId, "Вы уже не состоите в этой группе.", {
      inline_keyboard: [[{ text: "« К моим группам", callback_data: "my_groups" }]],
    });
    return;
  }

  const groupName = (membership as any).groups?.name || "группа";
  await editMessage(
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

async function handleConfirmLeaveGroup(chatId: number, messageId: number, user: any, groupId: string) {
  const { data: membership } = await supabase
    .from("group_members")
    .select("group_id, groups(name)")
    .eq("group_id", groupId)
    .eq("user_id", user.id)
    .eq("is_banned", false)
    .maybeSingle();

  if (!membership) {
    await editMessage(chatId, messageId, "Вы уже не состоите в этой группе.", {
      inline_keyboard: [[{ text: "« К моим группам", callback_data: "my_groups" }]],
    });
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const { data: futureSessions } = await supabase
    .from("sessions")
    .select("id")
    .eq("group_id", groupId)
    .gte("date", today);
  const futureSessionIds = (futureSessions || []).map((s: any) => s.id);

  let cancelledCount = 0;
  if (futureSessionIds.length > 0) {
    const { data: myFutureBookings } = await supabase
      .from("bookings")
      .select("id")
      .eq("user_id", user.id)
      .in("session_id", futureSessionIds)
      .in("status", ["active", "waitlist"]);

    cancelledCount = myFutureBookings?.length || 0;
    if (cancelledCount > 0) {
      await supabase
        .from("bookings")
        .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
        .eq("user_id", user.id)
        .in("session_id", futureSessionIds)
        .in("status", ["active", "waitlist"]);
    }
  }

  await supabase.from("group_admins").delete().eq("group_id", groupId).eq("user_id", user.id);
  await supabase.from("group_members").delete().eq("group_id", groupId).eq("user_id", user.id);

  const groupName = (membership as any).groups?.name || "группа";
  await editMessage(
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
    await editMessage(
      chatId,
      messageId,
      "❌ Вы заблокированы в этой группе.\n\nОбратитесь к администратору.",
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
      attended: true,
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
      attended: null,
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
      .update({ status: "active", waitlist_position: null, attended: true })
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

async function handleHistory(chatId: number, messageId: number, user: any) {
  const { data: myBookings } = await supabase
    .from("bookings")
    .select("attended, sessions(id, group_id, date, start_time, end_time, status, groups(name))")
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(100);

  const history = (myBookings || [])
    .map((b: any) => ({
      attended: b.attended,
      session: b.sessions,
    }))
    .filter((row: any) => row.session && row.session.status !== "cancelled")
    .filter((row: any) => isSessionCompletedNow(row.session.date, row.session.end_time))
    .sort((a: any, b: any) => {
      const ad = new Date(`${a.session.date}T${a.session.start_time}`).getTime();
      const bd = new Date(`${b.session.date}T${b.session.start_time}`).getTime();
      return bd - ad;
    });

  if (history.length === 0) {
    await editMessage(chatId, messageId, "📚 История пока пустая.", {
      inline_keyboard: [[{ text: "« Назад", callback_data: "main_menu" }]],
    });
    return;
  }

  const noShowCount = history.filter((h: any) => h.attended === false).length;
  let text = "📚 <b>Ваша история тренировок</b>\n\n";
  text += `Всего: ${history.length}\n`;
  text += `Пропущено: ${noShowCount}\n\n`;

  for (const item of history.slice(0, 25)) {
    const status = item.attended === false ? "❌ Не пришли" : "✅ Были";
    text += `• ${formatDate(item.session.date)}, ${formatTime(item.session.start_time)}–${formatTime(item.session.end_time)}\n`;
    text += `  ${item.session.groups?.name || "Группа"} · ${status}\n`;
  }

  if (history.length > 25) {
    text += `\n… и еще ${history.length - 25}`;
  }

  await editMessage(chatId, messageId, text, {
    inline_keyboard: [[{ text: "« Назад", callback_data: "main_menu" }]],
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

  let text = `👤 <b>Профиль</b>\n\n`;
  text += `Имя: ${user.first_name || "—"} ${user.last_name || ""}\n`;
  if (user.username) text += `Username: @${user.username}\n`;
  text += `\n📋 Групп: ${groups.length}\n`;
  text += `📝 Предстоящих тренировок: ${upcoming}\n`;

  await editMessage(chatId, messageId, text, {
    inline_keyboard: [[{ text: "« Назад", callback_data: "main_menu" }]],
  });
}

// ===== Admin handlers =====
async function handleAdmin(chatId: number, messageId: number, user: any) {
  const adminGroups = await getUserAdminGroups(user.id);
  const buttons: any[][] = [];
  let managedGroups: Array<{ id: string; name: string }> = [];

  if (user.is_super_admin) {
    buttons.push([{ text: "➕ Создать группу", callback_data: "sa_create_group" }]);
    const { data: allGroups } = await supabase
      .from("groups")
      .select("id, name")
      .order("created_at");
    managedGroups = (allGroups || []) as Array<{ id: string; name: string }>;
  } else {
    managedGroups = (adminGroups || [])
      .map((ag: any) => ({
        id: ag.group_id,
        name: ag.groups?.name,
      }))
      .filter((g) => g.id && g.name);
  }

  for (const g of managedGroups) {
    buttons.push([{ text: `⚙️ ${g.name}`, callback_data: `admin_group_${g.id}` }]);
  }

  buttons.push([{ text: "« Назад", callback_data: "main_menu" }]);

  const text = managedGroups.length > 0
    ? "⚙️ <b>Панель управления</b>\n\nВыберите группу для управления:"
    : "⚙️ <b>Панель управления</b>\n\nУ вас нет доступных групп для управления.";

  await editMessage(chatId, messageId, text, {
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
    [{ text: "📅 Ближайшие тренировки", callback_data: `admin_sched_${groupId}` }],
    [{ text: "📚 История тренировок", callback_data: `ahist_${groupId}` }],
    [{ text: "📊 Отчет за месяц", callback_data: `arep_${groupId}` }],
    [{ text: "🗓 Шаблоны расписания", callback_data: `asched_list_${groupId}` }],
    [{ text: "👥 Участники", callback_data: `admin_members_${groupId}` }],
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
    .eq("status", "scheduled")
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

  // Collect all active/waitlist users first, then cancel bookings and notify them.
  const { data: bookings } = await supabase
    .from("bookings")
    .select("id, user_id")
    .eq("session_id", sessionId)
    .in("status", ["active", "waitlist"]);

  const userIds = Array.from(new Set((bookings || []).map((b: any) => b.user_id).filter(Boolean)));
  let usersById: Record<string, any> = {};

  if (userIds.length > 0) {
    const { data: users } = await supabase
      .from("bot_users")
      .select("id, telegram_id")
      .in("id", userIds);
    usersById = Object.fromEntries((users || []).map((u: any) => [u.id, u]));
  }

  for (const b of bookings || []) {
    await supabase
      .from("bookings")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", b.id);

    const recipient = usersById[(b as any).user_id];
    if (recipient?.telegram_id) {
      await sendMessage(
        recipient.telegram_id,
        `❌ Тренировка отменена администратором:\n\n📅 ${formatDate(session.date)}, ${formatTime(session.start_time)}–${formatTime(session.end_time)}`
      );
    }
  }

  await editMessage(chatId, messageId, "✅ Тренировка отменена. Участники уведомлены.", {
    inline_keyboard: [[{ text: "« К расписанию", callback_data: `admin_sched_${session.group_id}` }]],
  });
}

async function handleAdminHistory(chatId: number, messageId: number, user: any, groupId: string) {
  const canManageGroup = user.is_super_admin || (await isGroupAdmin(user.id, groupId));
  if (!canManageGroup) {
    await editMessage(chatId, messageId, "❌ У вас нет прав для этой группы.", {
      inline_keyboard: [[{ text: "« Назад", callback_data: "admin" }]],
    });
    return;
  }

  const { data: sessions } = await supabase
    .from("sessions")
    .select("*")
    .eq("group_id", groupId)
    .neq("status", "cancelled")
    .order("date", { ascending: false })
    .order("start_time", { ascending: false })
    .limit(60);

  const pastSessions = (sessions || []).filter((s: any) => isSessionCompletedNow(s.date, s.end_time));
  if (pastSessions.length === 0) {
    await editMessage(chatId, messageId, "📚 Прошедших тренировок пока нет.", {
      inline_keyboard: [[{ text: "« Назад", callback_data: `admin_group_${groupId}` }]],
    });
    return;
  }

  let text = "📚 <b>История тренировок</b>\n\n";
  const buttons: any[][] = [];

  for (const s of pastSessions.slice(0, 20)) {
    const dateStr = formatDate(s.date);
    text += `• ${dateStr}, ${formatTime(s.start_time)}–${formatTime(s.end_time)}\n`;
    buttons.push([
      { text: `👥 ${dateStr} ${formatTime(s.start_time)}`, callback_data: `asess_${s.id}` },
    ]);
  }

  if (pastSessions.length > 20) {
    text += `\nПоказаны последние 20 из ${pastSessions.length}.`;
  }

  buttons.push([{ text: "« Назад", callback_data: `admin_group_${groupId}` }]);
  await editMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

async function handleAdminSessionAttendance(chatId: number, messageId: number, user: any, sessionId: string) {
  const { data: session } = await supabase
    .from("sessions")
    .select("id, group_id, date, start_time, end_time, status")
    .eq("id", sessionId)
    .single();
  if (!session) return;

  const canManageGroup = user.is_super_admin || (await isGroupAdmin(user.id, session.group_id));
  if (!canManageGroup) {
    await editMessage(chatId, messageId, "❌ У вас нет прав для этой группы.", {
      inline_keyboard: [[{ text: "« Назад", callback_data: "admin" }]],
    });
    return;
  }

  if (!isSessionCompletedNow(session.date, session.end_time)) {
    await editMessage(chatId, messageId, "Отмечать неявки можно только после окончания тренировки.", {
      inline_keyboard: [[{ text: "« Назад", callback_data: `admin_group_${session.group_id}` }]],
    });
    return;
  }

  const { data: bookings } = await supabase
    .from("bookings")
    .select("id, attended, user_id, bot_users(first_name, username, telegram_id)")
    .eq("session_id", sessionId)
    .eq("status", "active")
    .order("created_at", { ascending: true });

  let text = `👥 <b>Записавшиеся</b>\n\n`;
  text += `📅 ${formatDate(session.date)}, ${formatTime(session.start_time)}–${formatTime(session.end_time)}\n\n`;

  const buttons: any[][] = [];
  let noShows = 0;
  for (const b of bookings || []) {
    const u = (b as any).bot_users;
    const name = u?.first_name || (u?.username ? `@${u.username}` : `ID:${u?.telegram_id || "?"}`);
    const missed = b.attended === false;
    if (missed) noShows++;
    text += `${missed ? "❌" : "✅"} ${name}\n`;
    buttons.push([
      missed
        ? { text: `↩️ Убрать неявку: ${name}`, callback_data: `aok_${b.id}` }
        : { text: `❌ Не пришел: ${name}`, callback_data: `anosh_${b.id}` },
    ]);
  }

  text += `\nПропустили: ${noShows}`;
  buttons.push([{ text: "« К истории", callback_data: `ahist_${session.group_id}` }]);

  await editMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

async function handleAdminMarkNoShow(chatId: number, messageId: number, user: any, bookingId: string, attended: boolean) {
  const { data: booking } = await supabase
    .from("bookings")
    .select("id, session_id, sessions(group_id, date, end_time)")
    .eq("id", bookingId)
    .eq("status", "active")
    .single();
  if (!booking) return;

  const groupId = (booking as any).sessions?.group_id;
  if (!groupId) return;
  const canManageGroup = user.is_super_admin || (await isGroupAdmin(user.id, groupId));
  if (!canManageGroup) {
    await editMessage(chatId, messageId, "❌ У вас нет прав для этой группы.");
    return;
  }

  if (!isSessionCompletedNow((booking as any).sessions.date, (booking as any).sessions.end_time)) {
    await editMessage(chatId, messageId, "Эту отметку можно менять только после окончания тренировки.");
    return;
  }

  await supabase
    .from("bookings")
    .update({ attended })
    .eq("id", bookingId);

  await handleAdminSessionAttendance(chatId, messageId, user, booking.session_id);
}

async function handleAdminMonthlyReport(chatId: number, messageId: number, user: any, groupId: string) {
  const canManageGroup = user.is_super_admin || (await isGroupAdmin(user.id, groupId));
  if (!canManageGroup) {
    await editMessage(chatId, messageId, "❌ У вас нет прав для этой группы.", {
      inline_keyboard: [[{ text: "« Назад", callback_data: "admin" }]],
    });
    return;
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const monthStartStr = monthStart.toISOString().split("T")[0];
  const nextMonthStartStr = nextMonthStart.toISOString().split("T")[0];

  const { data: sessions } = await supabase
    .from("sessions")
    .select("id, date, start_time, end_time")
    .eq("group_id", groupId)
    .neq("status", "cancelled")
    .gte("date", monthStartStr)
    .lt("date", nextMonthStartStr);

  const completedSessions = (sessions || []).filter((s: any) => isSessionCompletedNow(s.date, s.end_time));
  const sessionIds = completedSessions.map((s: any) => s.id);

  if (sessionIds.length === 0) {
    await editMessage(chatId, messageId, "📊 За текущий месяц пока нет завершенных тренировок.", {
      inline_keyboard: [[{ text: "« Назад", callback_data: `admin_group_${groupId}` }]],
    });
    return;
  }

  const { data: bookings } = await supabase
    .from("bookings")
    .select("attended, user_id, bot_users(first_name, username, telegram_id)")
    .in("session_id", sessionIds)
    .eq("status", "active");

  const stats: Record<string, { name: string; total: number; missed: number }> = {};
  for (const b of bookings || []) {
    const u = (b as any).bot_users;
    const key = b.user_id;
    const name = u?.first_name || (u?.username ? `@${u.username}` : `ID:${u?.telegram_id || "?"}`);
    if (!stats[key]) stats[key] = { name, total: 0, missed: 0 };
    stats[key].total += 1;
    if (b.attended === false) stats[key].missed += 1;
  }

  const rows = Object.values(stats)
    .sort((a, b) => b.missed - a.missed || b.total - a.total);

  const totalMissed = rows.reduce((acc, row) => acc + row.missed, 0);
  const monthLabel = now.toLocaleString("ru-RU", { month: "long", year: "numeric" });
  let text = `📊 <b>Отчет за ${monthLabel}</b>\n\n`;
  text += `Тренировок завершено: ${sessionIds.length}\n`;
  text += `Всего неявок: ${totalMissed}\n\n`;
  text += "<b>Неявки по участникам:</b>\n";

  for (const row of rows.slice(0, 30)) {
    text += `• ${row.name}: ${row.missed}/${row.total}\n`;
  }

  await editMessage(chatId, messageId, text, {
    inline_keyboard: [[{ text: "« Назад", callback_data: `admin_group_${groupId}` }]],
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
        [{ text: "📋 Группы", callback_data: "my_groups" }],
        [{ text: "📝 Расписание", callback_data: "schedule" }],
        [{ text: "📚 История", callback_data: "history" }],
        [{ text: "👤 Профиль", callback_data: "profile" }],
      ];
      if (isAdmin) buttons.push([{ text: "⚙️ Управление", callback_data: "admin" }]);
      await editMessage(chatId, messageId, `🏓 <b>Главное меню</b>\n\nВыберите действие:`, { inline_keyboard: buttons });
    } else if (data === "my_groups") {
      await handleMyGroups(chatId, messageId, user);
    } else if (data === "schedule") {
      await handleSchedule(chatId, messageId, user);
    } else if (data === "history") {
      await handleHistory(chatId, messageId, user);
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
    } else if (data.startsWith("confirm_leave_group_")) {
      const groupId = data.replace("confirm_leave_group_", "");
      await handleConfirmLeaveGroup(chatId, messageId, user, groupId);
    } else if (data.startsWith("leave_group_")) {
      const groupId = data.replace("leave_group_", "");
      await handleLeaveGroup(chatId, messageId, user, groupId);
    } else if (data.startsWith("group_")) {
      const groupId = data.replace("group_", "");
      await handleLeaveGroup(chatId, messageId, user, groupId);
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
      const canManageGroup = user.is_super_admin || (await isGroupAdmin(user.id, groupId));
      if (!canManageGroup) {
        await editMessage(chatId, messageId, "❌ У вас нет прав для управления этой группой.", {
          inline_keyboard: [[{ text: "« Назад", callback_data: "admin" }]],
        });
        return;
      }
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
    } else if (data.startsWith("arep_")) {
      const groupId = data.replace("arep_", "");
      await handleAdminMonthlyReport(chatId, messageId, user, groupId);
    } else if (data.startsWith("ahist_")) {
      const groupId = data.replace("ahist_", "");
      await handleAdminHistory(chatId, messageId, user, groupId);
    } else if (data.startsWith("asess_")) {
      const sessionId = data.replace("asess_", "");
      await handleAdminSessionAttendance(chatId, messageId, user, sessionId);
    } else if (data.startsWith("anosh_")) {
      const bookingId = data.replace("anosh_", "");
      await handleAdminMarkNoShow(chatId, messageId, user, bookingId, false);
    } else if (data.startsWith("aok_")) {
      const bookingId = data.replace("aok_", "");
      await handleAdminMarkNoShow(chatId, messageId, user, bookingId, true);
    } else if (data.startsWith("admin_session_")) {
      const sessionId = data.replace("admin_session_", "");
      await handleAdminSessionAttendance(chatId, messageId, user, sessionId);
    } else if (data === "sa_create_group") {
      await sendMessage(chatId, "Отправьте название новой группы текстовым сообщением.\n\nФормат: <code>/newgroup Название группы</code>");
    } else if (data === "sa_all_groups") {
      if (!user.is_super_admin) {
        await editMessage(chatId, messageId, "❌ Эта функция доступна только суперадмину.", {
          inline_keyboard: [[{ text: "« Назад", callback_data: "admin" }]],
        });
        return;
      }
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
    } else if (data.startsWith("aedit_max_custom_")) {
      const groupId = data.replace("aedit_max_custom_", "");
      const shortId = groupId.substring(0, 8);
      await editMessage(chatId, messageId,
        `Введите любое число командой:\n\n` +
        `👥 <code>/editgroup ${shortId} max 9</code>\n\n` +
        `Допустимы любые положительные целые числа.`,
        { inline_keyboard: [[{ text: "« Назад", callback_data: `aedit_max_${groupId}` }]] }
      );
    } else if (data.startsWith("aedit_max_")) {
      const groupId = data.replace("aedit_max_", "");
      const { data: group } = await supabase.from("groups").select("max_participants").eq("id", groupId).single();
      const current = group?.max_participants || 8;
      const options = [4, 6, 8, 10, 12];
      const buttons = options.map((v) => ({
        text: v === current ? `✅ ${v}` : `${v}`,
        callback_data: `aset_max_${v}_${groupId}`,
      }));
      const rows: any[][] = [];
      for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
      rows.push([{ text: "⌨️ Ввести вручную", callback_data: `aedit_max_custom_${groupId}` }]);
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
        `✅ Расписание добавлено!\n\n${DAYS_FULL[day]} ${startTime}–${endTime}\n\nСессии сгенерированы на следующую неделю (Пн–Вс).`,
        {
          inline_keyboard: [
            [{ text: "➕ Добавить ещё", callback_data: `asched_add_${groupId}` }],
            [{ text: "📅 К расписанию", callback_data: `asched_list_${groupId}` }],
            [{ text: "« К группе", callback_data: `admin_group_${groupId}` }],
          ],
        }
      );
    } else if (data.startsWith("asched_end_min_")) {
      // asched_end_min_<day>_<startTime>_<endHour>_<groupId>
      const rest = data.replace("asched_end_min_", "");
      const parts = rest.split("_");
      const day = parseInt(parts[0]);
      const startTime = parts[1];
      const endHour = parts[2];
      const groupId = parts.slice(3).join("_");
      const DAYS_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
      const [startHour, startMinute] = startTime.split(":").map((v) => parseInt(v));
      const endHourNum = parseInt(endHour);
      const validEndMinutes = SCHEDULE_MINUTES.filter((minute) => endHourNum > startHour || parseInt(minute) > startMinute);
      const buttons: any[][] = [];
      for (let i = 0; i < validEndMinutes.length; i += 4) {
        buttons.push(validEndMinutes.slice(i, i + 4).map((minute) => ({
          text: minute,
          callback_data: `asched_save_${day}_${startTime}_${endHour}:${minute}_${groupId}`,
        })));
      }
      buttons.push([{ text: "« Назад", callback_data: `asched_end_hour_${day}_${startTime}_${groupId}` }]);
      await editMessage(chatId, messageId, `⏰ ${DAYS_FULL[day]}, начало ${startTime}, ${endHour}:__ — выберите минуты окончания:`, { inline_keyboard: buttons });
    } else if (data.startsWith("asched_end_hour_")) {
      // asched_end_hour_<day>_<startTime>_<groupId>
      const rest = data.replace("asched_end_hour_", "");
      const parts = rest.split("_");
      const day = parseInt(parts[0]);
      const startTime = parts[1];
      const groupId = parts.slice(2).join("_");
      const DAYS_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
      const [startHour] = startTime.split(":");
      const startHourNum = parseInt(startHour);
      const validEndHours = SCHEDULE_HOURS.filter((hour) => parseInt(hour) >= startHourNum);
      const buttons: any[][] = [];
      for (let i = 0; i < validEndHours.length; i += 4) {
        buttons.push(validEndHours.slice(i, i + 4).map((hour) => ({
          text: hour,
          callback_data: `asched_end_min_${day}_${startTime}_${hour}_${groupId}`,
        })));
      }
      buttons.push([{ text: "« Назад", callback_data: `asched_start_min_${day}_${startHour}_${groupId}` }]);
      await editMessage(chatId, messageId, `⏰ ${DAYS_FULL[day]}, начало ${startTime} — выберите час окончания:`, { inline_keyboard: buttons });
    } else if (data.startsWith("asched_start_min_")) {
      // asched_start_min_<day>_<startHour>_<groupId>
      const rest = data.replace("asched_start_min_", "");
      const parts = rest.split("_");
      const day = parseInt(parts[0]);
      const startHour = parts[1];
      const groupId = parts.slice(2).join("_");
      const DAYS_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
      const buttons: any[][] = [];
      for (let i = 0; i < SCHEDULE_MINUTES.length; i += 4) {
        buttons.push(SCHEDULE_MINUTES.slice(i, i + 4).map((minute) => ({
          text: minute,
          callback_data: `asched_end_hour_${day}_${startHour}:${minute}_${groupId}`,
        })));
      }
      buttons.push([{ text: "« Назад", callback_data: `asched_start_hour_${day}_${groupId}` }]);
      await editMessage(chatId, messageId, `⏰ ${DAYS_FULL[day]}, ${startHour}:__ — выберите минуты начала:`, { inline_keyboard: buttons });
    } else if (data.startsWith("asched_start_hour_")) {
      // asched_start_hour_<day>_<groupId>
      const rest = data.replace("asched_start_hour_", "");
      const underIdx = rest.indexOf("_");
      const day = parseInt(rest.substring(0, underIdx));
      const groupId = rest.substring(underIdx + 1);
      const DAYS_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
      const buttons: any[][] = [];
      for (let i = 0; i < SCHEDULE_HOURS.length; i += 4) {
        buttons.push(SCHEDULE_HOURS.slice(i, i + 4).map((hour) => ({
          text: hour,
          callback_data: `asched_start_min_${day}_${hour}_${groupId}`,
        })));
      }
      buttons.push([{ text: "« Назад", callback_data: `asched_add_${groupId}` }]);
      await editMessage(chatId, messageId, `⏰ ${DAYS_FULL[day]} — выберите час начала:`, { inline_keyboard: buttons });
    } else if (data.startsWith("asched_add_")) {
      const groupId = data.replace("asched_add_", "");
      const DAYS_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
      const dayPairs = [[1, 2], [3, 4], [5, 6], [0]];
      const buttons: any[][] = [];
      for (const pair of dayPairs) {
        buttons.push(pair.map(d => ({ text: DAYS_FULL[d], callback_data: `asched_start_hour_${d}_${groupId}` })));
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
        `⚠️ <b>Удаление группы «${group?.name}»</b>\n\nВсе данные будут удалены:\n• Участники и администраторы\n• Расписание и сессии\n• Бронирования\n\nВы уверены?`,
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
        `✅ Группа «${name}» создана!\n\n🔗 Инвайт: <code>join_${group.invite_code}</code>\n\nТеперь настройте расписание кнопкой ниже или через меню «⚙️ Управление».`,
        {
          inline_keyboard: [[{ text: "🗓 Шаблоны расписания", callback_data: `asched_list_${group.id}` }]],
        }
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

    await sendMessage(chatId, `✅ Расписание добавлено: ${DAYS_RU[dayOfWeek]} ${startTime}–${endTime}\n\nСессии сгенерированы на следующую неделю (Пн–Вс).`);
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
