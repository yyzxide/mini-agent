import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  FileDoneOutlined,
  InfoCircleOutlined,
  PlayCircleOutlined,
  QuestionCircleOutlined,
  SearchOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { createElement } from "react";
import type { ReactNode } from "react";

export interface EventDisplayMeta {
  color: string;
  icon: ReactNode;
}

export function getEventDisplayMeta(eventType: string): EventDisplayMeta {
  if (eventType.includes("FAILED")) {
    return { color: "red", icon: createElement(CloseCircleOutlined) };
  }
  if (eventType.includes("FINISHED") || eventType === "TEST_PASSED" || eventType === "TASK_FINISHED") {
    return { color: "green", icon: createElement(CheckCircleOutlined) };
  }
  if (eventType.includes("COMMAND")) {
    return { color: "blue", icon: createElement(PlayCircleOutlined) };
  }
  if (eventType.includes("PATCH")) {
    return { color: "purple", icon: createElement(FileDoneOutlined) };
  }
  if (eventType.includes("TOOL")) {
    return { color: "cyan", icon: createElement(ToolOutlined) };
  }
  if (eventType.includes("DIFF")) {
    return { color: "geekblue", icon: createElement(CodeOutlined) };
  }
  if (eventType === "USER_MESSAGE" || eventType === "ASSISTANT_MESSAGE") {
    return { color: "gold", icon: createElement(InfoCircleOutlined) };
  }
  if (eventType.includes("SEARCH")) {
    return { color: "lime", icon: createElement(SearchOutlined) };
  }
  return { color: "gray", icon: createElement(QuestionCircleOutlined) };
}

export function parsePayload(payload: unknown): unknown {
  if (typeof payload !== "string") {
    return payload;
  }
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

export function summarizePayload(payload: unknown): string {
  const parsed = parsePayload(payload);
  if (typeof parsed === "string") {
    return parsed.length > 120 ? `${parsed.slice(0, 120)}...` : parsed;
  }
  if (Array.isArray(parsed)) {
    return `${parsed.length} item(s)`;
  }
  if (parsed && typeof parsed === "object") {
    const entries = Object.entries(parsed as Record<string, unknown>)
      .slice(0, 3)
      .map(([key, value]) => `${key}: ${stringifyShort(value)}`);
    return entries.length > 0 ? entries.join(", ") : "{}";
  }
  return String(parsed ?? "");
}

function stringifyShort(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 48 ? `${value.slice(0, 48)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "-";
  }
  return JSON.stringify(value).slice(0, 60);
}
