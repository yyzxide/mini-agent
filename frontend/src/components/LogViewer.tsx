import { Button, Space, Tabs, message } from "antd";
import { ClearOutlined, CopyOutlined } from "@ant-design/icons";
import { useMemo, useRef, useState } from "react";
import type { AgentTaskLog } from "../types/event";
import { formatTime } from "../utils/formatTime";
import { EmptyState } from "./EmptyState";

interface LogViewerProps {
  logs: AgentTaskLog[];
}

export function LogViewer({ logs }: LogViewerProps) {
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(new Set());
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const visibleLogs = useMemo(() => logs.filter((log) => !hiddenIds.has(log.id)), [hiddenIds, logs]);
  const stdout = visibleLogs.filter((log) => log.streamType === "stdout");
  const stderr = visibleLogs.filter((log) => log.streamType === "stderr");

  const renderLogs = (items: AgentTaskLog[], streamType: "stdout" | "stderr") => {
    if (items.length === 0) {
      return <EmptyState description={`No ${streamType} logs`} />;
    }

    return (
      <div className="log-box">
        {items.map((log) => (
          <div key={log.id} className={`log-line log-${streamType}`}>
            <span className="log-time">{formatTime(log.createdAt)}</span>
            <span>{log.content}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    );
  };

  const copyLogs = async () => {
    await navigator.clipboard.writeText(
      visibleLogs.map((log) => `[${log.streamType}] ${formatTime(log.createdAt)} ${log.content}`).join("\n"),
    );
    message.success("Logs copied");
  };

  const clearLocal = () => {
    setHiddenIds(new Set(logs.map((log) => log.id)));
  };

  return (
    <div>
      <Space className="toolbar">
        <Button icon={<CopyOutlined />} onClick={() => void copyLogs()} disabled={visibleLogs.length === 0}>
          Copy
        </Button>
        <Button icon={<ClearOutlined />} onClick={clearLocal} disabled={visibleLogs.length === 0}>
          Clear view
        </Button>
      </Space>
      <Tabs
        items={[
          { key: "stdout", label: `stdout (${stdout.length})`, children: renderLogs(stdout, "stdout") },
          { key: "stderr", label: `stderr (${stderr.length})`, children: renderLogs(stderr, "stderr") },
        ]}
      />
    </div>
  );
}
