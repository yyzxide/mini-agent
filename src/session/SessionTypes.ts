export type SessionStatus = "ACTIVE" | "FINISHED" | "FAILED";

export type SessionRecordType =
  | "USER_MESSAGE"
  | "ASSISTANT_MESSAGE"
  | "AGENT_DECISION"
  | "TOOL_CALL"
  | "TOOL_RESULT"
  | "COMMAND_RESULT"
  | "FILE_CHANGE"
  | "DIFF_SUMMARY"
  | "TASK_SUMMARY"
  | "ERROR";

export type EventType =
  | "SESSION_CREATED"
  | "USER_MESSAGE"
  | "ASSISTANT_MESSAGE"
  | "TOOL_CALL_STARTED"
  | "TOOL_CALL_FINISHED"
  | "TOOL_CALL_FAILED"
  | "PATCH_APPLY_STARTED"
  | "PATCH_APPLY_FINISHED"
  | "PATCH_APPLY_FAILED"
  | "COMMAND_STARTED"
  | "COMMAND_FINISHED"
  | "TEST_FAILED"
  | "TEST_PASSED"
  | "DIFF_GENERATED"
  | "GIT_BRANCH_CREATE_STARTED"
  | "GIT_BRANCH_CREATED"
  | "GIT_COMMIT_STARTED"
  | "GIT_COMMITTED"
  | "PR_DRAFT_GENERATED"
  | "GIT_WORKFLOW_FAILED"
  | "TASK_FINISHED"
  | "TASK_FAILED";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface SessionMeta {
  sessionId: string;
  repoPath: string;
  baseCommit: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  messageCount: number;
  eventCount: number;
}

export interface SessionRecord<TPayload extends JsonObject = JsonObject> {
  id: string;
  sessionId: string;
  type: SessionRecordType;
  timestamp: string;
  payload: TPayload;
}

export interface EventRecord<TPayload extends JsonObject = JsonObject> {
  id: string;
  sessionId: string;
  type: EventType;
  timestamp: string;
  payload: TPayload;
}

export interface SessionIndex {
  version: 1;
  sessions: SessionMeta[];
}

export interface MiniAgentConfig {
  version: 1;
  repoPath: string;
  createdAt: string;
}

export interface CreateSessionInput {
  title?: string;
}

export interface SessionRecordInput<TPayload extends JsonObject = JsonObject> {
  id?: string;
  type: SessionRecordType;
  timestamp?: string;
  payload?: TPayload;
}

export interface EventRecordInput<TPayload extends JsonObject = JsonObject> {
  id?: string;
  type: EventType;
  timestamp?: string;
  payload?: TPayload;
}
