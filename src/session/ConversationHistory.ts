import type { SessionRecord } from "./SessionTypes.js";
import { estimateTokens } from "../context/TokenEstimator.js";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  executionEvidence?: ConversationExecutionEvidence;
}

export interface ConversationExecutionEvidence {
  repositoryChanged: boolean;
  changedFiles: string[];
  verificationAfterChange: boolean;
}

export interface ConversationHistoryOptions {
  maxMessages?: number;
  maxChars?: number;
}

export type ConversationSelectionStrategy =
  | "RECENT_HISTORY"
  | "TASK_FRAME_RETRIEVAL";

export interface ConversationFocusOptions {
  maxMessages?: number;
  maxChars?: number;
}

export interface FocusedConversationHistory {
  messages: ConversationMessage[];
  focusedOnLatestTurn: boolean;
  strategy: ConversationSelectionStrategy;
  matchedAssistantMessages: number;
}

export interface ConversationHistoryTrace {
  totalMessages: number;
  selectedMessages: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  truncated: boolean;
}

export interface ConversationHistoryResult {
  messages: ConversationMessage[];
  trace: ConversationHistoryTrace;
}

const DEFAULT_MAX_MESSAGES = 16;
const DEFAULT_MAX_CHARS = 12_000;

/**
 * Rebuilds chat history from persisted records without leaking tool traces or
 * duplicating legacy answer summaries. Agent-loop summaries are represented as
 * assistant turns because that execution path does not persist a separate
 * ASSISTANT_MESSAGE record.
 */
export function buildConversationHistory(
  records: SessionRecord[],
  options: ConversationHistoryOptions = {},
): ConversationMessage[] {
  return buildConversationHistoryWithTrace(records, options).messages;
}

export function buildConversationHistoryWithTrace(
  records: SessionRecord[],
  options: ConversationHistoryOptions = {},
): ConversationHistoryResult {
  const messages: ConversationMessage[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    const rawMessage = toConversationMessage(record, records[index - 1]);
    const executionEvidence = rawMessage?.role === "assistant"
      ? readPriorTurnExecutionEvidence(records, index)
      : undefined;
    const message = rawMessage && executionEvidence
      ? { ...rawMessage, executionEvidence }
      : rawMessage;
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
    return {
      messages: [],
      trace: buildTrace(messages, []),
    };
  }
  const totalChars = messages.reduce((total, message) => total + message.content.length, 0);
  if (messages.length <= maxMessages && totalChars <= maxChars) {
    const selected = messages.slice();
    while (selected[0]?.role === "assistant" && selected.some((message) => message.role === "user")) {
      selected.shift();
    }
    return {
      messages: selected,
      trace: buildTrace(messages, selected),
    };
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

  return {
    messages: selected,
    trace: buildTrace(messages, selected),
  };
}

/**
 * Selects the neutral recent window shown to the TaskFrame compiler. Semantic
 * references and prior-response audits are resolved later from model-authored
 * conversationEvidence queries by TaskFrameConversationSelector.
 */
export function focusConversationHistory(
  messages: ConversationMessage[],
  options: ConversationFocusOptions = {},
): FocusedConversationHistory {
  const maxMessages = Math.max(0, options.maxMessages ?? DEFAULT_MAX_MESSAGES);
  const maxChars = Math.max(0, options.maxChars ?? DEFAULT_MAX_CHARS);
  if (maxMessages === 0 || maxChars === 0) {
    return {
      messages: [],
      focusedOnLatestTurn: false,
      strategy: "RECENT_HISTORY",
      matchedAssistantMessages: 0,
    };
  }

  return {
    messages: selectRecentConversation(messages, { maxMessages, maxChars }),
    focusedOnLatestTurn: false,
    strategy: "RECENT_HISTORY",
    matchedAssistantMessages: 0,
  };
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

function readPriorTurnExecutionEvidence(
  records: SessionRecord[],
  assistantRecordIndex: number,
): ConversationExecutionEvidence | undefined {
  let checkpoint: SessionRecord | undefined;
  const changedFiles = new Set<string>();
  let sawExecutionRecord = false;

  for (let index = assistantRecordIndex - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || record.type === "USER_MESSAGE") break;
    if (record.type === "FILE_CHANGE") {
      sawExecutionRecord = true;
      for (const file of readChangedFiles(record)) changedFiles.add(file);
    }
    if (!checkpoint && record.type === "AGENT_CHECKPOINT") {
      checkpoint = record;
      sawExecutionRecord = true;
    }
  }

  if (!sawExecutionRecord) return undefined;
  const effects = readObject(checkpoint?.payload.effects);
  const workingSet = readObject(checkpoint?.payload.workingSet);
  for (const file of readStringArray(workingSet?.modifiedFiles)) changedFiles.add(file);
  return {
    repositoryChanged: effects?.successfulPatch === true || changedFiles.size > 0,
    changedFiles: [...changedFiles],
    verificationAfterChange: effects?.verificationAfterPatch === true,
  };
}

function readChangedFiles(record: SessionRecord): string[] {
  if (!Array.isArray(record.payload.files)) return [];
  return record.payload.files.flatMap((value) => {
    const file = readObject(value);
    return typeof file?.path === "string" && file.path.trim().length > 0
      ? [file.path.trim().replaceAll("\\", "/")]
      : [];
  });
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function buildTrace(
  input: ConversationMessage[],
  output: ConversationMessage[],
): ConversationHistoryTrace {
  return {
    totalMessages: input.length,
    selectedMessages: output.length,
    estimatedInputTokens: estimateConversationTokens(input),
    estimatedOutputTokens: estimateConversationTokens(output),
    truncated: output.length < input.length
      || output.some((message, index) => message.content !== input[input.length - output.length + index]?.content),
  };
}

export function estimateConversationTokens(messages: ConversationMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateTokens(message.content),
    0,
  );
}

function selectRecentConversation(
  messages: ConversationMessage[],
  options: Required<ConversationFocusOptions>,
): ConversationMessage[] {
  const selected: ConversationMessage[] = [];
  let usedChars = 0;

  for (let index = messages.length - 1; index >= 0 && selected.length < options.maxMessages; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const remainingChars = options.maxChars - usedChars;
    if (remainingChars <= 0) break;
    if (message.content.length > remainingChars) {
      if (selected.length === 0) {
        selected.unshift({ ...message, content: message.content.slice(-remainingChars) });
      }
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
