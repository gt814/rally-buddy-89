const DAYS_RU = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const MONTHS_RU = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];
const DEFAULT_TIMEZONE = "Europe/Moscow";

export function formatDateRu(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${DAYS_RU[d.getDay()]}, ${d.getDate()} ${MONTHS_RU[d.getMonth()]}`;
}

function parseUtcOffsetMinutes(timezone?: string | null): number | null {
  if (!timezone) return 180;
  const match = timezone.trim().match(/^(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) return null;

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] || "0");
  if (Number.isNaN(hours) || Number.isNaN(minutes) || hours > 23 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

export function formatTime(time: string, timezone: string = DEFAULT_TIMEZONE): string {
  const [hoursPart, minutesPart] = time.split(":");
  const hours = Number(hoursPart);
  const minutes = Number(minutesPart);

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return time.substring(0, 5);
  }

  const parsedOffsetMinutes = parseUtcOffsetMinutes(timezone);
  if (parsedOffsetMinutes !== null) {
    const shiftedTotalMinutes = ((hours * 60 + minutes + parsedOffsetMinutes) % 1440 + 1440) % 1440;
    const shiftedHours = Math.floor(shiftedTotalMinutes / 60);
    const shiftedMinutes = shiftedTotalMinutes % 60;
    return `${String(shiftedHours).padStart(2, "0")}:${String(shiftedMinutes).padStart(2, "0")}`;
  }

  try {
    const utcDate = new Date(Date.UTC(2000, 0, 1, hours, minutes));
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(utcDate);
  } catch {
    const fallbackMinutes = 180;
    const shiftedTotalMinutes = ((hours * 60 + minutes + fallbackMinutes) % 1440 + 1440) % 1440;
    const shiftedHours = Math.floor(shiftedTotalMinutes / 60);
    const shiftedMinutes = shiftedTotalMinutes % 60;
    return `${String(shiftedHours).padStart(2, "0")}:${String(shiftedMinutes).padStart(2, "0")}`;
  }
}
