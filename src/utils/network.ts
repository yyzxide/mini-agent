export function formatNetworkError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const primary = error.message.trim() || fallback;
  const cause = readErrorCause(error);
  if (!cause) return primary;
  if (cause === primary || primary.includes(cause)) return primary;
  return `${primary} (${cause})`;
}

function readErrorCause(error: Error): string | undefined {
  const cause = error.cause;
  if (cause instanceof Error) {
    const code = readStringProperty(cause, "code");
    const detail = cause.message.trim();
    return [code, detail].filter(Boolean).join(": ") || undefined;
  }
  if (typeof cause !== "object" || cause === null) return undefined;
  const code = readStringProperty(cause, "code");
  const message = readStringProperty(cause, "message");
  return [code, message].filter(Boolean).join(": ") || undefined;
}

function readStringProperty(value: object, key: string): string | undefined {
  if (!(key in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}
