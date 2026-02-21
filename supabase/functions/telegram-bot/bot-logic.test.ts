import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  type Deps,
  formatDate,
  formatTime,
  getOrCreateUser,
  getUserGroups,
  isGroupAdmin,
  isGroupMember,
  generateSessions,
  handleStart,
  handleMyGroups,
  handleBook,
  handleConfirmCancel,
  handleCancelWaitlist,
  handleProfile,
  handleNewGroup,
  handleEditGroup,
  handleDeleteGroup,
  handleAdminConfirmCancelSession,
} from "./bot-logic.ts";

// ===== Mock Supabase Client Builder =====

type MockResponse = { data: any; error?: any };

function createMockSupabase(responses: Record<string, MockResponse[]>) {
  // Track which response index to use for each table
  const callCounters: Record<string, number> = {};

  function getNextResponse(table: string): MockResponse {
    if (!callCounters[table]) callCounters[table] = 0;
    const resps = responses[table] || [{ data: null }];
    const idx = Math.min(callCounters[table], resps.length - 1);
    callCounters[table]++;
    return resps[idx];
  }

  function createChain(table: string): any {
    const resp = () => getNextResponse(table);
    const chain: any = {
      select: () => chain,
      insert: () => chain,
      update: () => chain,
      upsert: () => chain,
      delete: () => chain,
      eq: () => chain,
      neq: () => chain,
      gt: () => chain,
      gte: () => chain,
      lt: () => chain,
      lte: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve(resp()),
      single: () => Promise.resolve(resp()),
      then: (resolve: any) => resolve(resp()),
    };
    // Make chain thenable for awaiting without .single()
    return chain;
  }

  return {
    from: (table: string) => createChain(table),
  };
}

// ===== Mock Deps Builder =====

interface MockDepsResult {
  deps: Deps;
  sentMessages: { chatId: number; text: string; reply_markup?: any }[];
  editedMessages: { chatId: number; messageId: number; text: string; reply_markup?: any }[];
  answeredCallbacks: { id: string; text?: string }[];
}

function createMockDeps(
  dbResponses: Record<string, MockResponse[]>,
  superAdminIds: number[] = [111111]
): MockDepsResult {
  const sentMessages: any[] = [];
  const editedMessages: any[] = [];
  const answeredCallbacks: any[] = [];

  const deps: Deps = {
    supabase: createMockSupabase(dbResponses),
    sendMessage: async (chatId, text, reply_markup) => {
      sentMessages.push({ chatId, text, reply_markup });
    },
    editMessage: async (chatId, messageId, text, reply_markup) => {
      editedMessages.push({ chatId, messageId, text, reply_markup });
    },
    answerCallback: async (id, text) => {
      answeredCallbacks.push({ id, text });
    },
    superAdminIds,
  };

  return { deps, sentMessages, editedMessages, answeredCallbacks };
}

// ===================== TESTS =====================

// --- 1. Утилиты форматирования ---

Deno.test("formatTime — обрезает секунды", () => {
  assertEquals(formatTime("19:00:00"), "19:00");
  assertEquals(formatTime("09:30:00"), "09:30");
});

Deno.test("formatDate — форматирует дату на русском", () => {
  // 2025-02-17 is Monday
  const result = formatDate("2025-02-17");
  assertStringIncludes(result, "17");
  assertStringIncludes(result, "февраля");
});

// --- 2. Регистрация пользователя ---

Deno.test("getOrCreateUser — создаёт нового пользователя если не существует", async () => {
  const { deps } = createMockDeps({
    bot_users: [
      { data: null }, // .single() — not found
      { data: { id: "user-1", telegram_id: 12345, first_name: "Test", username: "test", is_super_admin: false } }, // insert().select().single()
    ],
  });

  const user = await getOrCreateUser(deps, { id: 12345, first_name: "Test", username: "test" });
  assertEquals(user?.telegram_id, 12345);
});

Deno.test("getOrCreateUser — возвращает существующего пользователя", async () => {
  const { deps } = createMockDeps({
    bot_users: [
      { data: { id: "user-1", telegram_id: 12345, first_name: "Test", username: "test", is_super_admin: false } },
    ],
  });

  const user = await getOrCreateUser(deps, { id: 12345, first_name: "Test", username: "test" });
  assertEquals(user.id, "user-1");
});

Deno.test("getOrCreateUser — помечает суперадмина", async () => {
  const { deps } = createMockDeps(
    {
      bot_users: [
        { data: { id: "user-sa", telegram_id: 111111, first_name: "Admin", username: "admin", is_super_admin: false } },
      ],
    },
    [111111]
  );

  const user = await getOrCreateUser(deps, { id: 111111, first_name: "Admin", username: "admin" });
  assertEquals(user.is_super_admin, true);
});

// --- 3. Проверка ролей ---

Deno.test("isGroupAdmin — возвращает true для админа", async () => {
  const { deps } = createMockDeps({
    group_admins: [{ data: { id: "ga-1" } }],
  });

  const result = await isGroupAdmin(deps, "user-1", "group-1");
  assertEquals(result, true);
});

Deno.test("isGroupAdmin — возвращает false если не админ", async () => {
  const { deps } = createMockDeps({
    group_admins: [{ data: null }],
  });

  const result = await isGroupAdmin(deps, "user-1", "group-1");
  assertEquals(result, false);
});

Deno.test("isGroupMember — возвращает false для заблокированного", async () => {
  const { deps } = createMockDeps({
    group_members: [{ data: { id: "gm-1", is_banned: true } }],
  });

  const result = await isGroupMember(deps, "user-1", "group-1");
  assertEquals(result, false);
});

// --- 4. Группы пользователя ---

Deno.test("getUserGroups — возвращает группы пользователя", async () => {
  const { deps } = createMockDeps({
    group_members: [
      {
        data: [
          { group_id: "g1", is_banned: false, groups: { id: "g1", name: "Group1" } },
          { group_id: "g2", is_banned: false, groups: { id: "g2", name: "Group2" } },
        ],
      },
    ],
  });

  const groups = await getUserGroups(deps, "user-1");
  assertEquals(groups.length, 2);
});

// --- 5. /start — главное меню ---

Deno.test("handleStart — показывает приветствие с кнопками", async () => {
  const { deps, sentMessages } = createMockDeps({
    group_admins: [{ data: [] }], // getUserAdminGroups — no admin groups
  });

  const user = { id: "user-1", first_name: "Иван", is_super_admin: false };
  await handleStart(deps, 123, user);

  assertEquals(sentMessages.length, 1);
  assertStringIncludes(sentMessages[0].text, "Иван");
  assertStringIncludes(sentMessages[0].text, "🏓");
  // Regular user — no admin button
  const buttons = sentMessages[0].reply_markup.inline_keyboard.flat();
  const adminBtn = buttons.find((b: any) => b.callback_data === "admin");
  assertEquals(adminBtn, undefined);
});

Deno.test("handleStart — показывает кнопку управления для админа", async () => {
  const { deps, sentMessages } = createMockDeps({
    group_admins: [{ data: [{ group_id: "g1", groups: { id: "g1", name: "G" } }] }],
  });

  const user = { id: "user-1", first_name: "Admin", is_super_admin: false };
  await handleStart(deps, 123, user);

  const buttons = sentMessages[0].reply_markup.inline_keyboard.flat();
  const adminBtn = buttons.find((b: any) => b.callback_data === "admin");
  assertEquals(adminBtn?.text, "⚙️ Управление");
});

// --- 6. Вступление в группу через deep link ---

Deno.test("handleStart join — вступление в группу по invite code", async () => {
  const { deps, sentMessages } = createMockDeps({
    groups: [{ data: { id: "g1", name: "TestGroup", invite_code: "abc123" } }],
    group_members: [
      { data: null }, // не участник
    ],
    group_admins: [{ data: [] }],
  });

  const user = { id: "user-1", first_name: "Новичок", is_super_admin: false };
  await handleStart(deps, 123, user, "join_abc123");

  // Should have join message + main menu
  assertEquals(sentMessages.length, 2);
  assertStringIncludes(sentMessages[0].text, "вступили в группу");
});

Deno.test("handleStart join — блокировка забаненного пользователя", async () => {
  const { deps, sentMessages } = createMockDeps({
    groups: [{ data: { id: "g1", name: "TestGroup", invite_code: "abc123" } }],
    group_members: [{ data: { id: "gm-1", is_banned: true } }],
    group_admins: [{ data: [] }],
  });

  const user = { id: "user-1", first_name: "Banned", is_super_admin: false };
  await handleStart(deps, 123, user, "join_abc123");

  assertStringIncludes(sentMessages[0].text, "заблокированы");
});

Deno.test("handleStart join — уже участник", async () => {
  const { deps, sentMessages } = createMockDeps({
    groups: [{ data: { id: "g1", name: "TestGroup", invite_code: "abc123" } }],
    group_members: [{ data: { id: "gm-1", is_banned: false } }],
    group_admins: [{ data: [] }],
  });

  const user = { id: "user-1", first_name: "Member", is_super_admin: false };
  await handleStart(deps, 123, user, "join_abc123");

  assertStringIncludes(sentMessages[0].text, "уже участник");
});

Deno.test("handleStart join — несуществующая группа", async () => {
  const { deps, sentMessages } = createMockDeps({
    groups: [{ data: null }],
    group_admins: [{ data: [] }],
  });

  const user = { id: "user-1", first_name: "User", is_super_admin: false };
  await handleStart(deps, 123, user, "join_invalid");

  assertStringIncludes(sentMessages[0].text, "не найдена");
});

// --- 7. Мои группы ---

Deno.test("handleMyGroups — нет групп", async () => {
  const { deps, editedMessages } = createMockDeps({
    group_members: [{ data: [] }],
  });

  const user = { id: "user-1" };
  await handleMyGroups(deps, 123, 1, user);

  assertStringIncludes(editedMessages[0].text, "нет групп");
});

Deno.test("handleMyGroups — отображает список групп", async () => {
  const { deps, editedMessages } = createMockDeps({
    group_members: [
      {
        data: [
          { group_id: "g1", groups: { name: "Первая" } },
          { group_id: "g2", groups: { name: "Вторая" } },
        ],
      },
    ],
  });

  const user = { id: "user-1" };
  await handleMyGroups(deps, 123, 1, user);

  assertStringIncludes(editedMessages[0].text, "Ваши группы");
  assertEquals(editedMessages[0].reply_markup.inline_keyboard.length, 3); // 2 groups + back
});

// --- 8. Бронирование тренировки ---

Deno.test("handleBook — успешная запись", async () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);
  const dateStr = futureDate.toISOString().split("T")[0];

  const { deps, editedMessages } = createMockDeps({
    sessions: [
      {
        data: {
          id: "s1",
          group_id: "g1",
          date: dateStr,
          start_time: "19:00:00",
          end_time: "21:00:00",
          status: "scheduled",
          max_participants: 8,
          groups: { name: "G1", freeze_hours: 4, max_participants: 8 },
        },
      },
    ],
    group_members: [{ data: { is_banned: false } }],
    bookings: [
      { data: [] }, // active bookings count = 0
      { data: null, error: null }, // insert result
    ],
  });

  const user = { id: "user-1" };
  await handleBook(deps, 123, 1, user, "s1");

  assertStringIncludes(editedMessages[0].text, "Вы записаны");
});

Deno.test("handleBook — запись в лист ожидания когда мест нет", async () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);
  const dateStr = futureDate.toISOString().split("T")[0];

  const sessionData = {
    id: "s1",
    group_id: "g1",
    date: dateStr,
    start_time: "19:00:00",
    end_time: "21:00:00",
    status: "scheduled",
    max_participants: 2,
    groups: { name: "G1", freeze_hours: 4, max_participants: 2 },
  };

  // Build a custom mock where bookings returns different data per call
  let bookingsCallIdx = 0;
  const bookingsResponses = [
    { data: [{ id: "b1" }, { id: "b2" }] }, // active count = 2 (full)
    { data: [{ id: "w1" }] },               // waitlist count = 1
    { data: null, error: null },             // insert
  ];

  const mockSupabase = {
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        insert: () => chain,
        update: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        single: () => {
          if (table === "sessions") return Promise.resolve({ data: sessionData });
          if (table === "group_members") return Promise.resolve({ data: { is_banned: false } });
          return Promise.resolve({ data: null });
        },
        maybeSingle: () => Promise.resolve({ data: null }),
        then: (resolve: any) => {
          if (table === "bookings") {
            const resp = bookingsResponses[Math.min(bookingsCallIdx++, bookingsResponses.length - 1)];
            return resolve(resp);
          }
          return resolve({ data: null });
        },
      };
      return chain;
    },
  };

  const editedMessages: any[] = [];
  const deps: Deps = {
    supabase: mockSupabase,
    sendMessage: async () => {},
    editMessage: async (_cid, _mid, text, rm) => { editedMessages.push({ text, reply_markup: rm }); },
    answerCallback: async () => {},
    superAdminIds: [],
  };

  const user = { id: "user-1" };
  await handleBook(deps, 123, 1, user, "s1");

  assertStringIncludes(editedMessages[0].text, "листе ожидания");
  assertStringIncludes(editedMessages[0].text, "позиция 2");
});

Deno.test("handleBook — заблокированный пользователь не может записаться", async () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);
  const dateStr = futureDate.toISOString().split("T")[0];

  const { deps, editedMessages } = createMockDeps({
    sessions: [
      {
        data: {
          id: "s1",
          group_id: "g1",
          date: dateStr,
          start_time: "19:00:00",
          end_time: "21:00:00",
          status: "scheduled",
          max_participants: 8,
          groups: { name: "G1", freeze_hours: 4, max_participants: 8 },
        },
      },
    ],
    group_members: [{ data: { is_banned: true } }],
    strikes: [{ data: [{ id: "st1" }, { id: "st2" }] }],
  });

  const user = { id: "user-1" };
  await handleBook(deps, 123, 1, user, "s1");

  assertStringIncludes(editedMessages[0].text, "заблокированы");
  assertStringIncludes(editedMessages[0].text, "страйков: 2");
});

Deno.test("handleBook — заморозка блокирует запись", async () => {
  // Session starts in 2 hours, freeze = 4 hours
  const nearDate = new Date();
  nearDate.setHours(nearDate.getHours() + 2);
  const dateStr = nearDate.toISOString().split("T")[0];
  const timeStr = `${String(nearDate.getHours()).padStart(2, "0")}:${String(nearDate.getMinutes()).padStart(2, "0")}:00`;

  const { deps, editedMessages } = createMockDeps({
    sessions: [
      {
        data: {
          id: "s1",
          group_id: "g1",
          date: dateStr,
          start_time: timeStr,
          end_time: "23:00:00",
          status: "scheduled",
          max_participants: 8,
          groups: { name: "G1", freeze_hours: 4, max_participants: 8 },
        },
      },
    ],
    group_members: [{ data: { is_banned: false } }],
  });

  const user = { id: "user-1" };
  await handleBook(deps, 123, 1, user, "s1");

  assertStringIncludes(editedMessages[0].text, "заморозка");
});

Deno.test("handleBook — отменённая тренировка недоступна", async () => {
  const { deps, answeredCallbacks } = createMockDeps({
    sessions: [
      {
        data: {
          id: "s1",
          status: "cancelled",
        },
      },
    ],
  });

  const user = { id: "user-1" };
  await handleBook(deps, 123, 1, user, "s1");

  assertEquals(answeredCallbacks.length, 1);
});

// --- 9. Отмена записи с продвижением из waitlist ---

Deno.test("handleConfirmCancel — отмена с продвижением из очереди", async () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);
  const dateStr = futureDate.toISOString().split("T")[0];

  const { deps, sentMessages, editedMessages } = createMockDeps({
    sessions: [
      {
        data: {
          id: "s1",
          group_id: "g1",
          date: dateStr,
          start_time: "19:00:00",
          end_time: "21:00:00",
          groups: { freeze_hours: 4 },
        },
      },
    ],
    bookings: [
      { data: null }, // update cancelled
      { data: { id: "wl-1", user_id: "waitlister", bot_users: { telegram_id: 555555 } } }, // next in line
      { data: null }, // update promoted
    ],
  });

  const user = { id: "user-1" };
  await handleConfirmCancel(deps, 123, 1, user, "s1");

  // Notification to promoted user
  assertEquals(sentMessages.length, 1);
  assertStringIncludes(sentMessages[0].text, "Место освободилось");
  assertEquals(sentMessages[0].chatId, 555555);

  // Confirmation to canceller
  assertStringIncludes(editedMessages[0].text, "Запись отменена");
});

Deno.test("handleConfirmCancel — заморозка блокирует отмену", async () => {
  const nearDate = new Date();
  nearDate.setHours(nearDate.getHours() + 1);
  const dateStr = nearDate.toISOString().split("T")[0];
  const timeStr = `${String(nearDate.getHours()).padStart(2, "0")}:${String(nearDate.getMinutes()).padStart(2, "0")}:00`;

  const { deps, editedMessages } = createMockDeps({
    sessions: [
      {
        data: {
          id: "s1",
          group_id: "g1",
          date: dateStr,
          start_time: timeStr,
          end_time: "23:00:00",
          groups: { freeze_hours: 4 },
        },
      },
    ],
  });

  const user = { id: "user-1" };
  await handleConfirmCancel(deps, 123, 1, user, "s1");

  assertStringIncludes(editedMessages[0].text, "заморожена");
});

// --- 10. Покинуть лист ожидания ---

Deno.test("handleCancelWaitlist — пользователь покидает очередь", async () => {
  const { deps, editedMessages } = createMockDeps({
    bookings: [{ data: null }],
    sessions: [{ data: { group_id: "g1" } }],
  });

  const user = { id: "user-1" };
  await handleCancelWaitlist(deps, 123, 1, user, "s1");

  assertStringIncludes(editedMessages[0].text, "покинули лист ожидания");
});

// --- 11. Профиль пользователя ---

Deno.test("handleProfile — отображает данные профиля", async () => {
  const { deps, editedMessages } = createMockDeps({
    group_members: [
      { data: [{ group_id: "g1", groups: { name: "Group1" } }] },
    ],
    bookings: [
      {
        data: [
          { id: "b1", sessions: { date: "2099-12-31" } },
          { id: "b2", sessions: { date: "2099-12-31" } },
        ],
      },
    ],
    strikes: [{ data: [{ id: "st1", groups: { name: "Group1" } }] }],
  });

  const user = { id: "user-1", first_name: "Алексей", last_name: "П", username: "alexey" };
  await handleProfile(deps, 123, 1, user);

  const text = editedMessages[0].text;
  assertStringIncludes(text, "Алексей");
  assertStringIncludes(text, "@alexey");
  assertStringIncludes(text, "Групп: 1");
  assertStringIncludes(text, "тренировок: 2");
  assertStringIncludes(text, "страйков: 1");
});

// --- 12. Создание группы (/newgroup) ---

Deno.test("handleNewGroup — суперадмин создаёт группу", async () => {
  const { deps, sentMessages } = createMockDeps({
    groups: [
      { data: { id: "new-group-id", name: "NewGroup", invite_code: "inv123" } },
    ],
    group_admins: [{ data: null }],
    group_members: [{ data: null }],
  });

  const user = { id: "user-sa", is_super_admin: true };
  await handleNewGroup(deps, 123, user, "NewGroup");

  assertStringIncludes(sentMessages[0].text, "Группа «NewGroup» создана");
  assertStringIncludes(sentMessages[0].text, "inv123");
});

Deno.test("handleNewGroup — обычный пользователь не может создать группу", async () => {
  const { deps, sentMessages } = createMockDeps({});

  const user = { id: "user-1", is_super_admin: false };
  await handleNewGroup(deps, 123, user, "Test");

  assertStringIncludes(sentMessages[0].text, "Только суперадмин");
});

Deno.test("handleNewGroup — пустое название", async () => {
  const { deps, sentMessages } = createMockDeps({});

  const user = { id: "user-sa", is_super_admin: true };
  await handleNewGroup(deps, 123, user, "");

  assertStringIncludes(sentMessages[0].text, "Укажите название");
});

// --- 13. Отмена тренировки администратором ---

Deno.test("handleAdminConfirmCancelSession — отменяет и уведомляет участников", async () => {
  const { deps, sentMessages, editedMessages } = createMockDeps({
    sessions: [
      {
        data: {
          id: "s1",
          group_id: "g1",
          date: "2025-03-01",
          start_time: "19:00:00",
          end_time: "21:00:00",
        },
      },
      { data: null }, // update cancelled
    ],
    bookings: [
      {
        data: [
          { id: "b1", bot_users: { telegram_id: 111 } },
          { id: "b2", bot_users: { telegram_id: 222 } },
        ],
      },
      { data: null }, // update b1
      { data: null }, // update b2
    ],
  });

  await handleAdminConfirmCancelSession(deps, 123, 1, "s1");

  // 2 notifications to booked users
  assertEquals(sentMessages.length, 2);
  assertStringIncludes(sentMessages[0].text, "отменена администратором");
  assertEquals(sentMessages[0].chatId, 111);
  assertEquals(sentMessages[1].chatId, 222);

  // Confirmation to admin
  assertStringIncludes(editedMessages[0].text, "Тренировка отменена");
});

// --- 14. Генерация сессий ---

Deno.test("generateSessions — не генерирует если нет расписания", async () => {
  const { deps } = createMockDeps({
    schedules: [{ data: [] }],
  });

  // Should complete without errors
  await generateSessions(deps, "g1");
});

Deno.test("generateSessions — генерирует сессии на основе шаблона", async () => {
  let upsertCalled = false;
  const mockSupabase = {
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        single: () => {
          if (table === "groups") return Promise.resolve({ data: { max_participants: 6 } });
          return Promise.resolve({ data: null });
        },
        upsert: () => {
          upsertCalled = true;
          return Promise.resolve({ data: null });
        },
        then: (resolve: any) => {
          if (table === "schedules") {
            return resolve({ data: [{ id: "sch1", day_of_week: 1, start_time: "19:00", end_time: "21:00", group_id: "g1" }] });
          }
          return resolve({ data: null });
        },
      };
      return chain;
    },
  };

  const deps: Deps = {
    supabase: mockSupabase,
    sendMessage: async () => {},
    editMessage: async () => {},
    answerCallback: async () => {},
    superAdminIds: [],
  };

  await generateSessions(deps, "g1");
  assertEquals(upsertCalled, true);
});

// --- 15. Редактирование группы (/editgroup) ---

Deno.test("handleEditGroup — админ меняет название группы", async () => {
  const { deps, sentMessages } = createMockDeps({
    groups: [
      { data: { id: "g1", name: "OldName", max_participants: 8, freeze_hours: 4 } }, // exact match
    ],
    group_admins: [{ data: { id: "ga-1" } }], // is admin
  });

  const user = { id: "user-1", is_super_admin: false };
  await handleEditGroup(deps, 123, user, "g1", "name", "NewName");

  assertStringIncludes(sentMessages[0].text, "обновлена");
  assertStringIncludes(sentMessages[0].text, "NewName");
});

Deno.test("handleEditGroup — админ меняет max_participants", async () => {
  const { deps, sentMessages } = createMockDeps({
    groups: [
      { data: { id: "g1", name: "Group", max_participants: 8, freeze_hours: 4 } },
    ],
    group_admins: [{ data: { id: "ga-1" } }],
  });

  const user = { id: "user-1", is_super_admin: false };
  await handleEditGroup(deps, 123, user, "g1", "max", "12");

  assertStringIncludes(sentMessages[0].text, "обновлена");
  assertStringIncludes(sentMessages[0].text, "12");
});

Deno.test("handleEditGroup — суперадмин может редактировать без роли админа группы", async () => {
  const { deps, sentMessages } = createMockDeps({
    groups: [
      { data: { id: "g1", name: "Group", max_participants: 8, freeze_hours: 4 } },
    ],
    group_admins: [{ data: null }], // not group admin
  });

  const user = { id: "user-sa", is_super_admin: true };
  await handleEditGroup(deps, 123, user, "g1", "freeze", "6");

  assertStringIncludes(sentMessages[0].text, "обновлена");
});

Deno.test("handleEditGroup — обычный пользователь не может редактировать", async () => {
  const { deps, sentMessages } = createMockDeps({
    groups: [
      { data: { id: "g1", name: "Group" } },
    ],
    group_admins: [{ data: null }],
  });

  const user = { id: "user-1", is_super_admin: false };
  await handleEditGroup(deps, 123, user, "g1", "name", "Hack");

  assertStringIncludes(sentMessages[0].text, "не администратор");
});

Deno.test("handleEditGroup — неизвестное поле", async () => {
  const { deps, sentMessages } = createMockDeps({
    groups: [
      { data: { id: "g1", name: "Group" } },
    ],
    group_admins: [{ data: { id: "ga-1" } }],
  });

  const user = { id: "user-1", is_super_admin: false };
  await handleEditGroup(deps, 123, user, "g1", "invalid_field", "value");

  assertStringIncludes(sentMessages[0].text, "Неизвестное поле");
});

Deno.test("handleEditGroup — некорректное числовое значение", async () => {
  const { deps, sentMessages } = createMockDeps({
    groups: [
      { data: { id: "g1", name: "Group" } },
    ],
    group_admins: [{ data: { id: "ga-1" } }],
  });

  const user = { id: "user-1", is_super_admin: false };
  await handleEditGroup(deps, 123, user, "g1", "max", "abc");

  assertStringIncludes(sentMessages[0].text, "положительным числом");
});

Deno.test("handleEditGroup — группа не найдена", async () => {
  const { deps, sentMessages } = createMockDeps({
    groups: [
      { data: null }, // exact match not found
      { data: [] }, // all groups empty
    ],
  });

  const user = { id: "user-1", is_super_admin: true };
  await handleEditGroup(deps, 123, user, "nonexistent", "name", "X");

  assertStringIncludes(sentMessages[0].text, "не найдена");
});

// --- 16. Удаление группы (/deletegroup) ---

Deno.test("handleDeleteGroup — суперадмин удаляет группу", async () => {
  const { deps, sentMessages } = createMockDeps({
    groups: [
      { data: { id: "g1", name: "ToDelete" } }, // exact match
      { data: null }, // delete result
    ],
    group_admins: [{ data: null }],
    group_members: [{ data: null }],
    schedules: [{ data: null }],
    sessions: [{ data: [] }], // no future sessions
    strikes: [{ data: null }],
  });

  const user = { id: "user-sa", is_super_admin: true };
  await handleDeleteGroup(deps, 123, user, "g1");

  assertStringIncludes(sentMessages[0].text, "удалена");
  assertStringIncludes(sentMessages[0].text, "ToDelete");
});

Deno.test("handleDeleteGroup — обычный пользователь не может удалить", async () => {
  const { deps, sentMessages } = createMockDeps({});

  const user = { id: "user-1", is_super_admin: false };
  await handleDeleteGroup(deps, 123, user, "g1");

  assertStringIncludes(sentMessages[0].text, "Только суперадмин");
});

Deno.test("handleDeleteGroup — группа не найдена", async () => {
  const { deps, sentMessages } = createMockDeps({
    groups: [
      { data: null },
      { data: [] },
    ],
  });

  const user = { id: "user-sa", is_super_admin: true };
  await handleDeleteGroup(deps, 123, user, "nonexistent");

  assertStringIncludes(sentMessages[0].text, "не найдена");
});

Deno.test("handleDeleteGroup — удаление с отменой будущих бронирований", async () => {
  const { deps, sentMessages } = createMockDeps({
    groups: [
      { data: { id: "g1", name: "GroupWithSessions" } },
      { data: null },
    ],
    group_admins: [{ data: null }],
    group_members: [{ data: null }],
    schedules: [{ data: null }],
    sessions: [
      { data: [{ id: "s1" }, { id: "s2" }] }, // future sessions
      { data: null }, // delete sessions
    ],
    bookings: [
      { data: null }, // cancel bookings s1
      { data: null }, // cancel bookings s2
    ],
    strikes: [{ data: null }],
  });

  const user = { id: "user-sa", is_super_admin: true };
  await handleDeleteGroup(deps, 123, user, "g1");

  assertStringIncludes(sentMessages[0].text, "удалена");
});
