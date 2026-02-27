import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const WEEK_PUBLICATION_PARTICIPANT_TEXT = "Нажмите, чтобы посмотреть детали.";

function getNextWeekBounds(now = new Date()) {
  const currentDay = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysUntilNextMonday = currentDay === 1 ? 7 : (8 - currentDay) % 7;
  const nextWeekMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  nextWeekMonday.setUTCDate(nextWeekMonday.getUTCDate() + daysUntilNextMonday);
  const nextWeekSunday = new Date(nextWeekMonday);
  nextWeekSunday.setUTCDate(nextWeekSunday.getUTCDate() + 6);
  return { nextWeekMonday, nextWeekSunday };
}

function formatWeekRange(start: Date, end: Date): string {
  const format = (date: Date) =>
    `${String(date.getUTCDate()).padStart(2, "0")}.${String(date.getUTCMonth() + 1).padStart(2, "0")}.${date.getUTCFullYear()}`;
  return `${format(start)}–${format(end)}`;
}

async function sendTelegramMessage(botToken: string, chatId: number, text: string, reply_markup?: any) {
  const body: any = { chat_id: chatId, text, parse_mode: "HTML" };
  if (reply_markup) body.reply_markup = reply_markup;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error("Failed to send weekly publication notification:", error);
  }
}

async function notifyWeeklySchedulePublished(supabase: any, botToken: string, groupId: string, weekRange: string) {
  if (!botToken) return;

  const publicationText = `Опубликовано расписание на ${weekRange}.`;

  const { data: admins } = await supabase
    .from("group_admins")
    .select("user_id")
    .eq("group_id", groupId);
  const adminUserIds = Array.from(
    new Set<string>((admins || []).map((a: any) => String(a.user_id)).filter(Boolean))
  );

  if (adminUserIds.length > 0) {
    const { data: adminUsers } = await supabase
      .from("bot_users")
      .select("telegram_id")
      .in("id", adminUserIds);
    for (const admin of adminUsers || []) {
      if (admin.telegram_id) {
        await sendTelegramMessage(botToken, admin.telegram_id, publicationText);
      }
    }
  }

  const { data: members } = await supabase
    .from("group_members")
    .select("user_id")
    .eq("group_id", groupId)
    .eq("is_banned", false);
  const participantUserIds = Array.from(
    new Set<string>((members || []).map((m: any) => String(m.user_id)).filter(Boolean))
  )
    .filter((id) => !adminUserIds.includes(id));

  if (participantUserIds.length === 0) return;

  const { data: participants } = await supabase
    .from("bot_users")
    .select("telegram_id")
    .in("id", participantUserIds);

  for (const participant of participants || []) {
    if (!participant.telegram_id) continue;
    await sendTelegramMessage(
      botToken,
      participant.telegram_id,
      `${publicationText}\n\n${WEEK_PUBLICATION_PARTICIPANT_TEXT}`,
      {
        inline_keyboard: [[{ text: WEEK_PUBLICATION_PARTICIPANT_TEXT, callback_data: `sched_${groupId}` }]],
      }
    );
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get all groups
    const { data: groups, error: groupsError } = await supabase
      .from("groups")
      .select("id, max_participants");

    if (groupsError) throw groupsError;
    if (!groups || groups.length === 0) {
      return new Response(JSON.stringify({ message: "No groups found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let totalCreated = 0;
    let totalNotifiedGroups = 0;

    for (const group of groups) {
      const { data: schedules } = await supabase
        .from("schedules")
        .select("*")
        .eq("group_id", group.id);

      if (!schedules || schedules.length === 0) continue;

      // Generate only for the next calendar week: Monday..Sunday (UTC)
      const { nextWeekMonday, nextWeekSunday } = getNextWeekBounds();
      let hasGeneratedSession = false;

      for (const schedule of schedules) {
        const dayOfWeek = Number(schedule.day_of_week);
        if (Number.isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) continue;

        // Convert schedule day (Sun=0..Sat=6) to offset in next week Monday..Sunday.
        const dayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const sessionDate = new Date(nextWeekMonday);
        sessionDate.setUTCDate(nextWeekMonday.getUTCDate() + dayOffset);
        const dateStr = sessionDate.toISOString().split("T")[0];

        const { error } = await supabase
          .from("sessions")
          .upsert(
            {
              group_id: group.id,
              schedule_id: schedule.id,
              date: dateStr,
              start_time: schedule.start_time,
              end_time: schedule.end_time,
              max_participants: group.max_participants || 8,
            },
            { onConflict: "group_id,date,start_time" }
          );
        if (!error) {
          totalCreated++;
          hasGeneratedSession = true;
        }
      }

      if (hasGeneratedSession) {
        await notifyWeeklySchedulePublished(
          supabase,
          botToken,
          group.id,
          formatWeekRange(nextWeekMonday, nextWeekSunday)
        );
        totalNotifiedGroups++;
      }
    }

    return new Response(
      JSON.stringify({
        message: `Sessions generated for ${groups.length} groups`,
        totalCreated,
        totalNotifiedGroups,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
