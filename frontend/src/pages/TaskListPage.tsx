import { Button, Card, Input, Select, Space, Table, Typography, message } from "antd";
import { PlusOutlined, ReloadOutlined, StopOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cancelTask, listTasks } from "../api/taskApi";
import { TaskStatusTag } from "../components/TaskStatusTag";
import type { AgentExecutionMode, AgentTask, AgentTaskStatus } from "../types/task";
import { formatTime } from "../utils/formatTime";

const statusOptions: AgentTaskStatus[] = [
  "CREATED",
  "STARTING",
  "RUNNING",
  "WAITING_REVIEW",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

const cancellableStatuses: AgentTaskStatus[] = ["STARTING", "RUNNING", "WAITING_REVIEW"];

export function TaskListPage() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [status, setStatus] = useState<AgentTaskStatus | undefined>();
  const [repoPath, setRepoPath] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      setTasks(await listTasks({ status, repoPath: repoPath.trim() || undefined }));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const columns: ColumnsType<AgentTask> = useMemo(
    () => [
      {
        title: "Task No",
        dataIndex: "taskNo",
        width: 190,
        render: (value: string, record) => (
          <Button type="link" className="link-button" onClick={() => navigate(`/tasks/${record.id}`)}>
            {value}
          </Button>
        ),
      },
      {
        title: "Goal",
        dataIndex: "userGoal",
        ellipsis: true,
        render: (value: string) => <span className="table-long-text">{value}</span>,
      },
      {
        title: "Repository",
        dataIndex: "repoPath",
        ellipsis: true,
        render: (value: string) => <span className="mono table-long-text">{value}</span>,
      },
      {
        title: "Mode",
        dataIndex: "executionMode",
        width: 110,
        render: (value: AgentExecutionMode) => <span className="mono">{value}</span>,
      },
      {
        title: "Status",
        dataIndex: "status",
        width: 140,
        render: (value: AgentTaskStatus) => <TaskStatusTag status={value} />,
      },
      {
        title: "Session",
        dataIndex: "sessionId",
        width: 160,
        render: (value?: string) => <span className="mono">{value ?? "-"}</span>,
      },
      {
        title: "Created",
        dataIndex: "createdAt",
        width: 190,
        render: formatTime,
      },
      {
        title: "Updated",
        dataIndex: "updatedAt",
        width: 190,
        render: formatTime,
      },
      {
        title: "Actions",
        width: 190,
        render: (_, record) => (
          <Space>
            <Button onClick={() => navigate(`/tasks/${record.id}`)}>Details</Button>
            <Button
              danger
              icon={<StopOutlined />}
              disabled={!cancellableStatuses.includes(record.status)}
              onClick={async () => {
                try {
                  await cancelTask(record.id);
                  message.success("Task cancelled");
                  await refresh();
                } catch (error) {
                  message.error(error instanceof Error ? error.message : "Failed to cancel task");
                }
              }}
            />
          </Space>
        ),
      },
    ],
    [navigate, repoPath, status],
  );

  return (
    <div className="page-wide">
      <div className="page-title-row">
        <Typography.Title level={2}>Tasks</Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate("/tasks/create")}>
          Create task
        </Button>
      </div>

      <Card>
        <Space className="filter-bar" wrap>
          <Select
            allowClear
            placeholder="Status"
            value={status}
            style={{ width: 180 }}
            options={statusOptions.map((value) => ({ label: value, value }))}
            onChange={setStatus}
          />
          <Input
            allowClear
            placeholder="Filter by repository path"
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
            className="repo-filter"
          />
          <Button icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading}>
            Refresh
          </Button>
        </Space>
        <Table
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={tasks}
          scroll={{ x: 1280 }}
          pagination={{ pageSize: 10, showSizeChanger: true }}
        />
      </Card>
    </div>
  );
}
