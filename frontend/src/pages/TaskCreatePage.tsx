import { Card, Typography, message } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createTask } from "../api/taskApi";
import { TaskCreateForm } from "../components/TaskCreateForm";
import type { CreateAgentTaskRequest } from "../types/task";

export function TaskCreatePage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (values: CreateAgentTaskRequest) => {
    setLoading(true);
    try {
      const task = await createTask(values);
      message.success("Task created");
      navigate(`/tasks/${task.id}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Failed to create task");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-narrow">
      <Typography.Title level={2}>Create task</Typography.Title>
      <Card>
        <TaskCreateForm loading={loading} onSubmit={(values) => void handleSubmit(values)} />
      </Card>
    </div>
  );
}
