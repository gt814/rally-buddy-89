import type { Group, Session, Booking } from "@/hooks/use-bot-data";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateRu, formatTime } from "@/lib/date-utils";
import { cn } from "@/lib/utils";

interface SessionListProps {
  group: Group;
  sessions: Session[];
  bookings: Booking[];
  loading: boolean;
}

export function SessionList({ group, sessions, bookings, loading }: SessionListProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-foreground">{group.name}</h2>
          <p className="text-sm text-muted-foreground">Расписание тренировок</p>
        </div>
        <Badge variant="outline" className="font-mono text-xs">
          {group.invite_code}
        </Badge>
      </div>

      {sessions.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">Нет запланированных тренировок</p>
          <p className="text-sm mt-1">Настройте расписание через бота</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map((session, i) => {
            const activeCount = bookings.filter(
              (b) => b.session_id === session.id && b.status === "active"
            ).length;
            const waitlistCount = bookings.filter(
              (b) => b.session_id === session.id && b.status === "waitlist"
            ).length;
            const fillPercent = Math.min((activeCount / session.max_participants) * 100, 100);
            const isFull = activeCount >= session.max_participants;

            return (
              <Card key={session.id} className="animate-fade-in" style={{ animationDelay: `${i * 50}ms` }}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="text-center min-w-[60px]">
                        <p className="text-xs font-medium text-muted-foreground uppercase">
                          {formatDateRu(session.date).split(",")[0]}
                        </p>
                        <p className="text-lg font-bold text-foreground">
                          {new Date(session.date + "T00:00:00").getDate()}
                        </p>
                      </div>
                      <div>
                        <p className="font-medium text-foreground">
                          {formatTime(session.start_time, group.timezone)}–{formatTime(session.end_time, group.timezone)}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {formatDateRu(session.date)}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      {waitlistCount > 0 && (
                        <Badge variant="secondary" className="text-xs">
                          +{waitlistCount} в очереди
                        </Badge>
                      )}
                      <div className="text-right">
                        <p className={cn(
                          "text-sm font-semibold",
                          isFull ? "text-destructive" : "text-foreground"
                        )}>
                          {activeCount}/{session.max_participants}
                        </p>
                        <div className="w-16 h-1.5 bg-secondary rounded-full mt-1 overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full transition-all duration-500",
                              isFull ? "bg-destructive" : "bg-primary"
                            )}
                            style={{ width: `${fillPercent}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
