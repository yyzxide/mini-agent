import type { SessionRecord } from "./SessionTypes.js";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationHistoryOptions {
  maxMessages?: number;
  maxChars?: number;
}

const DEFAULT_MAX_MESSAGES = 16;
const DEFAULT_MAX_CHARS = 12_000;

/**
 * Rebuilds chat history from persisted records without leaking tool traces or
 * duplicating direct-answer summaries. Agent-loop summaries are represented as
 * assistant turns because that execution path does not persist a separate
 * ASSISTANT_MESSAGE record.
 */
export function buildConversationHistory(
  records: SessionRecord[],
  options: ConversationHistoryOptions = {},
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];

  for (const record of records) {
    const message = toConversationMessage(record);
    if (!message) {
      continue;
    }

    const previous = messages.at(-1);
    if (previous?.role === message.role && previous.content === message.content) {
      continue;
    }
    messages.push(message);
  }

  const maxMessages = Math.max(0, options.maxMessages ?? DEFAULT_MAX_MESSAGES);
  const maxChars = Math.max(0, options.maxChars ?? DEFAULT_MAX_CHARS);
  if (maxMessages === 0 || maxChars === 0) {
    return [];
  }
  const selected: ConversationMessage[] = [];
  let usedChars = 0;

  for (let index = messages.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (selected.length > 0 && usedChars + message.content.length > maxChars) {
      break;
    }
    if (selected.length === 0 && message.content.length > maxChars) {
      selected.unshift({ ...message, content: message.content.slice(-maxChars) });
      break;
    }
    selected.unshift(message);
    usedChars += message.content.length;
  }

  while (selected[0]?.role === "assistant" && selected.some((message) => message.role === "user")) {
    selected.shift();
  }

  return selected;
}

export function findLatestUserMessage(messages: ConversationMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message.content;
    }
  }
  return undefined;
}

function toConversationMessage(record: SessionRecord): ConversationMessage | undefined {
  if (record.type === "USER_MESSAGE") {
    return readMessage(record, "user", "content");
  }
  if (record.type === "ASSISTANT_MESSAGE") {
    return readMessage(record, "assistant", "content");
  }
  if (record.type === "TASK_SUMMARY" && record.payload.success !== false) {
    return readMessage(record, "assistant", "summary");
  }
  return undefined;
}

function readMessage(
  record: SessionRecord,
  role: ConversationMessage["role"],
  key: "content" | "summary",
): ConversationMessage | undefined {
  const value = record.payload[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return { role, content: value.trim() };
}
