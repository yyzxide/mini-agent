import { Tag } from "antd";
import type { AgentTaskStatus } from "../types/task";

const statusColor: Record<AgentTaskStatus, string> = {
  CREATED: "default",
  STARTING: "processing",
  RUNNING: "blue",
  WAITING_REVIEW: "gold",
  COMPLETED: "green",
  FAILED: "red",
  CANCELLED: "default",
};

interface TaskStatusTagProps {
  status: AgentTaskStatus;
}

export function TaskStatusTag({ status }: TaskStatusTagProps) {
  return <Tag color={statusColor[status]}>{status}</Tag>;
}
