export interface RuntimeClock {
  now?: Date;
  timeZone?: string;
}

export interface RuntimeContext {
  currentDate: string;
  currentTime: string;
  timeZone: string;
  utcOffset: string;
  utcTimestamp: string;
}

export function getRuntimeContext(clock: RuntimeClock = {}): RuntimeContext {
  const now = clock.now ?? new Date();
  const timeZone = clock.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const parts = formatDateTimeParts(now, timeZone);

  return {
    currentDate: `${parts.year}-${parts.month}-${parts.day}`,
    currentTime: `${parts.hour}:${parts.minute}:${parts.second}`,
    timeZone,
    utcOffset: formatUtcOffset(now, timeZone),
    utcTimestamp: now.toISOString(),
  };
}

export function formatRuntimeContext(context: RuntimeContext = getRuntimeContext()): string {
  return [
    `Current local date: ${context.currentDate}`,
    `Current local time: ${context.currentTime}`,
    `Time zone: ${context.timeZone} (${context.utcOffset})`,
    `Current UTC timestamp: ${context.utcTimestamp}`,
    "Use this runtime context as the source of truth for questions about today, now, current date, or current time.",
  ].join("\n");
}

function formatDateTimeParts(date: Date, timeZone: string): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));

  return {
    year: parts.year ?? "0000",
    month: parts.month ?? "01",
    day: parts.day ?? "01",
    hour: normalizeHour(parts.hour ?? "00"),
    minute: parts.minute ?? "00",
    second: parts.second ?? "00",
  };
}

function formatUtcOffset(date: Date, timeZone: string): string {
  const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const localDate = new Date(date.toLocaleString("en-US", { timeZone }));
  const offsetMinutes = Math.round((localDate.getTime() - utcDate.getTime()) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0");
  const minutes = String(absoluteMinutes % 60).padStart(2, "0");

  return `UTC${sign}${hours}:${minutes}`;
}

function normalizeHour(hour: string): string {
  return hour === "24" ? "00" : hour;
}
