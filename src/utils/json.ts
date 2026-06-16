import type { JsonObject, JsonValue } from "../session/SessionTypes.js";

export function toJsonObject(value: Record<string, unknown>): JsonObject {
  const output: JsonObject = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = toJsonValue(nestedValue);
  }
  return output;
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }

  if (typeof value === "object") {
    return toJsonObject(value as Record<string, unknown>);
  }

  return String(value);
}
