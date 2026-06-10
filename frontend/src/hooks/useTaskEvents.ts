import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { message } from "antd";
import { getTaskEvents, taskEventStreamUrl } from "../api/taskApi";
import type { AgentTaskEvent } from "../types/event";
import type { AgentTaskStatus } from "../types/task";

const terminalStatuses: AgentTaskStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

export function useTaskEvents(taskId: number | undefined, status?: AgentTaskStatus) {
  const [events, setEvents] = useState<AgentTaskEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [usingPolling, setUsingPolling] = useState(false);
  const [error, setError] = useState<string>();
  const seenIdsRef = useRef(new Set<number>());

  const isTerminal = useMemo(() => (status ? terminalStatuses.includes(status) : false), [status]);

  const appendEvents = useCallback((incoming: AgentTaskEvent[]) => {
    if (incoming.length === 0) {
      return;
    }

    setEvents((current) => {
      const next = [...current];
      for (const event of incoming) {
        if (seenIdsRef.current.has(event.id)) {
          continue;
        }
        seenIdsRef.current.add(event.id);
        next.push(event);
      }
      return next.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!taskId) {
      return;
    }
    const latest = await getTaskEvents(taskId);
    appendEvents(latest);
  }, [appendEvents, taskId]);

  useEffect(() => {
    seenIdsRef.current.clear();
    setEvents([]);
    void refresh();
  }, [refresh, taskId]);

  useEffect(() => {
    if (!taskId || isTerminal || usingPolling) {
      return undefined;
    }

    const source = new EventSource(taskEventStreamUrl(taskId));
    source.onopen = () => {
      setConnected(true);
      setError(undefined);
    };

    const handleEvent = (raw: MessageEvent<string>) => {
      try {
        appendEvents([JSON.parse(raw.data) as AgentTaskEvent]);
      } catch (exception) {
        setError(exception instanceof Error ? exception.message : String(exception));
      }
    };

    const knownTypes = [
      "SESSION_CREATED",
      "USER_MESSAGE",
      "ASSISTANT_MESSAGE",
      "TOOL_CALL_STARTED",
      "TOOL_CALL_FINISHED",
      "TOOL_CALL_FAILED",
      "PATCH_APPLY_STARTED",
      "PATCH_APPLY_FINISHED",
      "PATCH_APPLY_FAILED",
      "COMMAND_STARTED",
      "COMMAND_FINISHED",
      "TEST_FAILED",
      "TEST_PASSED",
      "DIFF_GENERATED",
      "TASK_FINISHED",
      "TASK_FAILED",
      "CANCELLED",
      "PARSE_ERROR",
      "UNKNOWN",
    ];
    knownTypes.forEach((type) => source.addEventListener(type, handleEvent as EventListener));

    source.onerror = () => {
      source.close();
      setConnected(false);
      setUsingPolling(true);
      setError("SSE disconnected. Falling back to polling.");
      message.warning("SSE disconnected. Falling back to polling.");
    };

    return () => {
      knownTypes.forEach((type) => source.removeEventListener(type, handleEvent as EventListener));
      source.close();
      setConnected(false);
    };
  }, [appendEvents, isTerminal, taskId, usingPolling]);

  useEffect(() => {
    if (!taskId || (!usingPolling && !isTerminal)) {
      return undefined;
    }
    if (isTerminal) {
      void refresh();
      return undefined;
    }

    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [isTerminal, refresh, taskId, usingPolling]);

  return {
    events,
    connected,
    usingPolling,
    error,
    refresh,
  };
}
