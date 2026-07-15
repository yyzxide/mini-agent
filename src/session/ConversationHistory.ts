import type { SessionRecord } from "./SessionTypes.js";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationHistoryOptions {
  maxMessages?: number;
  maxChars?: number;
}

export interface FocusedConversationHistory {
  messages: ConversationMessage[];
  focusedOnLatestTurn: boolean;
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

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    const message = toConversationMessage(record, records[index - 1]);
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

/**
 * Demonstratives such as "这个" normally refer to the immediately preceding
 * completed exchange. Keeping older topic changes in that prompt gives the
 * model multiple plausible referents, so narrow only genuinely referential
 * follow-ups and leave explicit historical recall untouched.
 */
export function focusConversationHistory(
  messages: ConversationMessage[],
  currentRequest: string,
): FocusedConversationHistory {
  if (!isImplicitLatestTurnReference(currentRequest)) {
    return { messages, focusedOnLatestTurn: false };
  }

  const latestAssistantIndex = findLastIndex(messages, (message) => message.role === "assistant");
  const latestUserIndex = findLastIndex(
    messages,
    (message) => message.role === "user",
    latestAssistantIndex - 1,
  );
  if (latestUserIndex < 0 || latestAssistantIndex < 0) {
    return { messages, focusedOnLatestTurn: false };
  }

  return {
    messages: messages.slice(latestUserIndex, latestAssistantIndex + 1),
    focusedOnLatestTurn: true,
  };
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

function toConversationMessage(
  record: SessionRecord,
  previousRecord: SessionRecord | undefined,
): ConversationMessage | undefined {
  if (record.type === "USER_MESSAGE") {
    return readMessage(record, "user", "content");
  }
  if (record.type === "ASSISTANT_MESSAGE") {
    // Older sessions persisted every AgentLoop decision as a chat message.
    // AGENT_DECISION already records that trace; it is not conversational history.
    if (previousRecord?.type === "AGENT_DECISION") {
      return undefined;
    }
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

function isImplicitLatestTurnReference(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 40) {
    return false;
  }

  if (/(之前|先前|前面|更早|最开始|历史|previous|earlier|before that)/i.test(normalized)) {
    return false;
  }

  return /(这个|那个|这些|那些|这段|这份|这次|该(?:代码|项目|实现|方案|文件|功能)|它|上述|上面|刚才|\bthis\b|\bthat\b|\bit\b|\bthese\b|\bthose\b)/i.test(normalized);
}

function findLastIndex(
  messages: ConversationMessage[],
  predicate: (message: ConversationMessage) => boolean,
  startIndex = messages.length - 1,
): number {
  for (let index = Math.min(startIndex, messages.length - 1); index >= 0; index -= 1) {
    const message = messages[index];
    if (message && predicate(message)) {
      return index;
    }
  }
  return -1;
}
