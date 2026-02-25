import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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

    for (const group of groups) {
      const { data: schedules } = await supabase
        .from("schedules")
        .select("*")
        .eq("group_id", group.id);

      if (!schedules || schedules.length === 0) continue;

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
        if (!error) totalCreated++;
      }
    }

    return new Response(
      JSON.stringify({ message: `Sessions generated for ${groups.length} groups`, totalCreated }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
