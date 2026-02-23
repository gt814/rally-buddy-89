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

      const today = new Date();
      const horizon = new Date(today);
      horizon.setDate(horizon.getDate() + 14);

      for (const schedule of schedules) {
        const current = new Date(today);
        while (current <= horizon) {
          if (current.getDay() === schedule.day_of_week) {
            const dateStr = current.toISOString().split("T")[0];
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
          current.setDate(current.getDate() + 1);
        }
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
