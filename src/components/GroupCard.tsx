import type { Group } from "@/hooks/use-bot-data";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface GroupCardProps {
  group: Group;
  isSelected: boolean;
  onClick: () => void;
}

export function GroupCard({ group, isSelected, onClick }: GroupCardProps) {
  return (
    <Card
      className={cn(
        "cursor-pointer transition-all duration-200 hover:shadow-md",
        isSelected
          ? "ring-2 ring-primary shadow-md bg-primary/5"
          : "hover:bg-muted/50"
      )}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "w-10 h-10 rounded-lg flex items-center justify-center text-lg font-bold",
              isSelected
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground"
            )}
          >
            {group.name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-foreground truncate">{group.name}</p>
            <p className="text-xs text-muted-foreground">
              Макс: {group.max_participants} · Время фиксации: за {group.freeze_hours}ч
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
