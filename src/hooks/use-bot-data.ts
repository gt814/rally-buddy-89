import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface Group {
  id: string;
  name: string;
  invite_code: string;
  freeze_hours: number;
  max_participants: number;
  timezone: string;
  created_at: string;
}

export interface Session {
  id: string;
  group_id: string;
  date: string;
  start_time: string;
  end_time: string;
  status: string;
  max_participants: number;
}

export interface Booking {
  id: string;
  session_id: string;
  user_id: string;
  status: string;
  waitlist_position: number | null;
  attended: boolean | null;
  created_at: string;
}

export function useGroups() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetch() {
      const { data } = await supabase
        .from("groups")
        .select("*")
        .order("created_at", { ascending: false });
      setGroups((data as any[]) || []);
      setLoading(false);
    }
    fetch();
  }, []);

  return { groups, loading };
}

export function useSessions(groupId: string | null) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!groupId) return;
    setLoading(true);
    async function fetch() {
      const today = new Date().toISOString().split("T")[0];
      const { data } = await supabase
        .from("sessions")
        .select("*")
        .eq("group_id", groupId!)
        .gte("date", today)
        .order("date")
        .order("start_time");
      setSessions((data as any[]) || []);
      setLoading(false);
    }
    fetch();
  }, [groupId]);

  return { sessions, loading };
}

export function useBookings(sessionIds: string[]) {
  const [bookings, setBookings] = useState<Booking[]>([]);

  useEffect(() => {
    if (sessionIds.length === 0) {
      setBookings([]);
      return;
    }
    async function fetch() {
      const { data } = await supabase
        .from("bookings")
        .select("*")
        .in("session_id", sessionIds)
        .in("status", ["active", "waitlist"]);
      setBookings((data as any[]) || []);
    }
    fetch();
  }, [sessionIds.join(",")]);

  return bookings;
}
