import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Drawer,
  Row,
  Space,
  Spin,
  Tabs,
  Typography,
  message,
} from "antd";
import { CopyOutlined, FileSearchOutlined, ReloadOutlined, StopOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { cancelTask, getTask, getTaskDiff, getTaskLogs, getTaskSessionEvents, getTaskSessionRecords } from "../api/taskApi";
import { DiffViewer } from "../components/DiffViewer";
import { EmptyState } from "../components/EmptyState";
import { EventTimeline } from "../components/EventTimeline";
import { GitWorkflowPanel } from "../components/GitWorkflowPanel";
import { LogViewer } from "../components/LogViewer";
import { TaskStatusTag } from "../components/TaskStatusTag";
import { usePolling } from "../hooks/usePolling";
import { useTaskEvents } from "../hooks/useTaskEvents";
import type { AgentTaskLog } from "../types/event";
import type { AgentTask, AgentTaskStatus } from "../types/task";
import type { SessionJsonRecord } from "../types/session";
import { formatTime } from "../utils/formatTime";

const terminalStatuses: AgentTaskStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];
const cancellableStatuses: AgentTaskStatus[] = ["STARTING", "RUNNING", "WAITING_REVIEW"];

export function TaskDetailPage() {
  const { id } = useParams();
  const taskId = Number(id);
  const [task, setTask] = useState<AgentTask>();
  const [logs, setLogs] = useState<AgentTaskLog[]>([]);
  const [diff, setDiff] = useState("");
  const [loading, setLoading] = useState(true);
  const [sessionDrawerOpen, setSessionDrawerOpen] = useState(false);
  const [sessionTitle, setSessionTitle] = useState("Session");
  const [sessionRecords, setSessionRecords] = useState<SessionJsonRecord[]>([]);
  const [sessionLoading, setSessionLoading] = useState(false);

  const { events, connected, usingPolling, error: streamError, refresh: refreshEvents } = useTaskEvents(taskId, task?.status);
  const isTerminal = useMemo(() => (task ? terminalStatuses.includes(task.status) : false), [task]);

  const refresh = useCallback(async () => {
    if (!Number.isFinite(taskId)) {
      return;
    }
    try {
      const [nextTask, nextLogs, nextDiff] = await Promise.all([getTask(taskId), getTaskLogs(taskId), getTaskDiff(taskId)]);
      setTask(nextTask);
      setLogs(nextLogs);
      setDiff(nextDiff || nextTask.finalDiff || "");
      await refreshEvents();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Failed to load task");
    } finally {
      setLoading(false);
    }
  }, [refreshEvents, taskId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  usePolling(
    async () => {
      await refresh();
    },
    2000,
    Boolean(task && !isTerminal),
  );

  const handleCancel = async () => {
    if (!task) {
      return;
    }
    try {
      const updated = await cancelTask(task.id);
      setTask(updated);
      message.success("Task cancelled");
      await refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Failed to cancel task");
    }
  };

  const copyDiff = async () => {
    await navigator.clipboard.writeText(diff || task?.finalDiff || "");
    message.success("Diff copied");
  };

  const openSessionRecords = async (kind: "records" | "events") => {
    if (!task?.sessionId) {
      message.warning("No session id yet");
      return;
    }
    setSessionLoading(true);
    setSessionDrawerOpen(true);
    setSessionTitle(kind === "records" ? "Session records" : "Session events");
    try {
      const records =
        kind === "records" ? await getTaskSessionRecords(task.id) : await getTaskSessionEvents(task.id, 200);
      setSessionRecords(records);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Failed to load session data");
      setSessionRecords([]);
    } finally {
      setSessionLoading(false);
    }
  };

  if (loading && !task) {
    return (
      <div className="centered">
        <Spin />
      </div>
    );
  }

  if (!task) {
    return <EmptyState description="Task not found" />;
  }

  return (
    <div className="page-wide">
      <div className="page-title-row">
        <Space direction="vertical" size={0}>
          <Typography.Title level={2}>{task.taskNo}</Typography.Title>
          <Typography.Text type="secondary" className="mono break-anywhere">
            {task.repoPath}
          </Typography.Text>
        </Space>
        <Space wrap>
          <TaskStatusTag status={task.status} />
          <Button icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading}>
            Refresh
          </Button>
          <Button
            danger
            icon={<StopOutlined />}
            disabled={!cancellableStatuses.includes(task.status)}
            onClick={() => void handleCancel()}
          >
            Cancel
          </Button>
        </Space>
      </div>

      {streamError ? <Alert type="warning" showIcon message={streamError} className="page-alert" /> : null}

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={9}>
          <Card title="Task">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="Status">
                <TaskStatusTag status={task.status} />
              </Descriptions.Item>
              <Descriptions.Item label="Session">
                <span className="mono break-anywhere">{task.sessionId ?? "-"}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Mode">{task.executionMode}</Descriptions.Item>
              <Descriptions.Item label="Runner PID">{task.runnerPid ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="Max steps">{task.maxSteps}</Descriptions.Item>
              <Descriptions.Item label="Started">{formatTime(task.startedAt)}</Descriptions.Item>
              <Descriptions.Item label="Finished">{formatTime(task.finishedAt)}</Descriptions.Item>
              <Descriptions.Item label="Created">{formatTime(task.createdAt)}</Descriptions.Item>
              <Descriptions.Item label="Updated">{formatTime(task.updatedAt)}</Descriptions.Item>
            </Descriptions>
            <Divider />
            <Typography.Text strong>Repository</Typography.Text>
            <Descriptions column={1} size="small" className="detail-description">
              <Descriptions.Item label="Source">
                <span className="mono break-anywhere">{task.sourceRepoPath ?? task.repoPath}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Workspace">
                <span className="mono break-anywhere">{task.workspacePath ?? "-"}</span>
              </Descriptions.Item>
            </Descriptions>
            {task.sandboxInfo ? (
              <>
                <Divider />
                <Typography.Text strong>Sandbox</Typography.Text>
                <Descriptions column={1} size="small" className="detail-description">
                  <Descriptions.Item label="Status">{task.sandboxInfo.status}</Descriptions.Item>
                  <Descriptions.Item label="Container">
                    <span className="mono break-anywhere">{task.sandboxInfo.containerName}</span>
                  </Descriptions.Item>
                  <Descriptions.Item label="Image">
                    <span className="mono break-anywhere">{task.sandboxInfo.image}</span>
                  </Descriptions.Item>
                  <Descriptions.Item label="CPU">{task.sandboxInfo.cpuLimit ?? "-"}</Descriptions.Item>
                  <Descriptions.Item label="Memory">{task.sandboxInfo.memoryLimit ?? "-"}</Descriptions.Item>
                  <Descriptions.Item label="Network">{task.sandboxInfo.networkEnabled ? "enabled" : "none"}</Descriptions.Item>
                </Descriptions>
              </>
            ) : null}
            <Divider />
            <Typography.Text strong>User goal</Typography.Text>
            <pre className="goal-box">{task.userGoal}</pre>
            {task.errorMessage ? <Alert type="error" showIcon message={task.errorMessage} /> : null}
            {task.finalSummary ? <Alert type="success" showIcon message={task.finalSummary} /> : null}
            <Divider />
            <Space wrap>
              <Button icon={<FileSearchOutlined />} onClick={() => void openSessionRecords("records")}>
                Session records
              </Button>
              <Button icon={<FileSearchOutlined />} onClick={() => void openSessionRecords("events")}>
                Session events
              </Button>
              <Button icon={<CopyOutlined />} onClick={() => void copyDiff()} disabled={!diff && !task.finalDiff}>
                Copy diff
              </Button>
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={15}>
          <Card
            title="Events"
            extra={
              <Typography.Text type="secondary">
                {connected ? "SSE connected" : usingPolling ? "Polling" : isTerminal ? "Closed" : "Connecting"}
              </Typography.Text>
            }
          >
            <div className="event-panel">
              <EventTimeline events={events} />
            </div>
          </Card>
        </Col>
      </Row>

      <Card className="detail-bottom">
        <Tabs
          items={[
            {
              key: "logs",
              label: "Logs",
              children: <LogViewer logs={logs} />,
            },
            {
              key: "diff",
              label: "Diff",
              children: (
                <>
                  <GitWorkflowPanel task={task} diff={diff || task.finalDiff} onChanged={refresh} />
                  <DiffViewer diff={diff || task.finalDiff} />
                </>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        title={sessionTitle}
        open={sessionDrawerOpen}
        onClose={() => setSessionDrawerOpen(false)}
        width="min(900px, 92vw)"
      >
        <Spin spinning={sessionLoading}>
          {sessionRecords.length === 0 ? (
            <EmptyState description="No session data" />
          ) : (
            <pre className="json-block large">{JSON.stringify(sessionRecords, null, 2)}</pre>
          )}
        </Spin>
      </Drawer>
    </div>
  );
}
