import { useState } from "react";
import { useGroups, useSessions, useBookings } from "@/hooks/use-bot-data";
import { GroupCard } from "@/components/GroupCard";
import { SessionList } from "@/components/SessionList";
import { SetupGuide } from "@/components/SetupGuide";

const Index = () => {
  const { groups, loading } = useGroups();
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const { sessions, loading: sessionsLoading } = useSessions(selectedGroupId);
  const bookings = useBookings(sessions.map((s) => s.id));

  const selectedGroup = groups.find((g) => g.id === selectedGroupId);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-4 py-5 flex items-center gap-3">
          <span className="text-3xl">🏓</span>
          <div>
            <h1 className="text-xl font-bold text-foreground">PingPong Bot</h1>
            <p className="text-sm text-muted-foreground">Панель управления</p>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : groups.length === 0 ? (
          <SetupGuide />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Groups sidebar */}
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
                Группы
              </h2>
              {groups.map((group) => (
                <GroupCard
                  key={group.id}
                  group={group}
                  isSelected={selectedGroupId === group.id}
                  onClick={() => setSelectedGroupId(group.id)}
                />
              ))}
            </div>

            {/* Sessions */}
            <div className="lg:col-span-2">
              {selectedGroup ? (
                <SessionList
                  group={selectedGroup}
                  sessions={sessions}
                  bookings={bookings}
                  loading={sessionsLoading}
                />
              ) : (
                <div className="flex items-center justify-center py-20 text-muted-foreground">
                  <div className="text-center">
                    <span className="text-5xl block mb-4">📅</span>
                    <p className="text-lg font-medium">Выберите группу</p>
                    <p className="text-sm">для просмотра расписания</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default Index;
