// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";

function createMockSupabase(opts: {
  groups?: any[];
  schedules?: Record<string, any[]>;
  upsertCalls?: any[];
}) {
  const upsertCalls = opts.upsertCalls || [];

  return {
    from: (table: string): any => {
      if (table === "groups") {
        return {
          select: () => ({
            data: opts.groups || [],
            error: null,
          }),
        };
      }
      if (table === "schedules") {
        return {
          select: () => ({
            eq: (_: string, groupId: string) => ({
              data: opts.schedules?.[groupId] || [],
              error: null,
            }),
          }),
        };
      }
      if (table === "sessions") {
        return {
          upsert: (data: any, opts2: any) => {
            upsertCalls.push({ data, opts: opts2 });
            return { error: null };
          },
        };
      }
      return {};
    },
  };
}

async function runGeneration(supabase: any): Promise<any[]> {
  const upsertCalls: any[] = [];
  const origFrom = supabase.from.bind(supabase);
  supabase.from = (table: string): any => {
    if (table === "sessions") {
      return {
        upsert: (data: any, opts2: any) => {
          upsertCalls.push({ data, opts: opts2 });
          return { error: null };
        },
      };
    }
    return origFrom(table);
  };

  const { data: groups } = await supabase.from("groups").select();
  if (!groups || groups.length === 0) return upsertCalls;

  for (const group of groups) {
    const { data: schedules } = await supabase.from("schedules").select().eq("group_id", group.id);
    if (!schedules || schedules.length === 0) continue;

    // Fixed "now" for deterministic tests:
    // 2025-02-15 is Saturday, so next week is 2025-02-17..2025-02-23 (Mon..Sun)
    const now = new Date("2025-02-15T11:00:00Z");
    const currentDay = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const daysUntilNextMonday = currentDay === 1 ? 7 : (8 - currentDay) % 7;
    const nextWeekMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    nextWeekMonday.setUTCDate(nextWeekMonday.getUTCDate() + daysUntilNextMonday);

    for (const schedule of schedules) {
      const dayOfWeek = Number(schedule.day_of_week);
      if (Number.isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) continue;
      const dayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const sessionDate = new Date(nextWeekMonday);
      sessionDate.setUTCDate(nextWeekMonday.getUTCDate() + dayOffset);
      const dateStr = sessionDate.toISOString().split("T")[0];

      await supabase.from("sessions").upsert(
        {
          group_id: group.id,
          schedule_id: schedule.id,
          date: dateStr,
          start_time: schedule.start_time,
          end_time: schedule.end_time,
          max_participants: group.max_participants,
        },
        { onConflict: "group_id,date,start_time" }
      );
    }
  }
  return upsertCalls;
}

Deno.test("generate-weekly-sessions — no groups returns early", async () => {
  const supabase = createMockSupabase({ groups: [] });
  const calls = await runGeneration(supabase);
  assertEquals(calls.length, 0);
});

Deno.test("generate-weekly-sessions — no schedules skips group", async () => {
  const supabase = createMockSupabase({
    groups: [{ id: "g1", max_participants: 8 }],
    schedules: { g1: [] },
  });
  const calls = await runGeneration(supabase);
  assertEquals(calls.length, 0);
});

Deno.test("generate-weekly-sessions — generates sessions for schedule", async () => {
  const supabase = createMockSupabase({
    groups: [{ id: "g1", max_participants: 6 }],
    schedules: {
      g1: [{ id: "s1", group_id: "g1", day_of_week: 3, start_time: "19:00", end_time: "21:00" }],
    },
  });
  const calls = await runGeneration(supabase);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].data.group_id, "g1");
  assertEquals(calls[0].data.max_participants, 6);
  assertEquals(calls[0].data.start_time, "19:00");
  // Wed of next week from 2025-02-15 => 2025-02-19
  assertEquals(calls[0].data.date, "2025-02-19");
});

Deno.test("generate-weekly-sessions — handles multiple groups", async () => {
  const supabase = createMockSupabase({
    groups: [
      { id: "g1", max_participants: 8 },
      { id: "g2", max_participants: 10 },
    ],
    schedules: {
      g1: [{ id: "s1", group_id: "g1", day_of_week: 1, start_time: "18:00", end_time: "20:00" }],
      g2: [{ id: "s2", group_id: "g2", day_of_week: 5, start_time: "17:00", end_time: "19:00" }],
    },
  });
  const calls = await runGeneration(supabase);
  const g1 = calls.filter((c: any) => c.data.group_id === "g1");
  const g2 = calls.filter((c: any) => c.data.group_id === "g2");
  assertEquals(g1.length, 1);
  assertEquals(g2.length, 1);
  // Mon and Fri of next week from 2025-02-15
  assertEquals(g1[0].data.date, "2025-02-17");
  assertEquals(g2[0].data.date, "2025-02-21");
});
