import { Button, Form, Input, InputNumber, Select, Space, Switch } from "antd";
import type { CreateAgentTaskRequest } from "../types/task";

interface TaskCreateFormProps {
  loading?: boolean;
  onSubmit: (values: CreateAgentTaskRequest) => void;
}

export function TaskCreateForm({ loading = false, onSubmit }: TaskCreateFormProps) {
  const [form] = Form.useForm<CreateAgentTaskRequest>();

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={{
        executionMode: "DOCKER",
        maxSteps: 20,
        useRealModel: false,
      }}
      onFinish={onSubmit}
      className="task-form"
    >
      <Form.Item
        name="repoPath"
        label="Repository path"
        rules={[{ required: true, message: "Repository path is required" }]}
      >
        <Input placeholder="/absolute/path/to/demo-repo" />
      </Form.Item>

      <Form.Item name="userGoal" label="User goal" rules={[{ required: true, message: "User goal is required" }]}>
        <Input.TextArea
          placeholder="demo: 给 demo.txt 增加 hello from mini-agent"
          autoSize={{ minRows: 5, maxRows: 10 }}
        />
      </Form.Item>

      <Space size="large" wrap>
        <Form.Item name="executionMode" label="Execution mode" rules={[{ required: true }]}>
          <Select
            style={{ width: 160 }}
            options={[
              { label: "DOCKER", value: "DOCKER" },
              { label: "LOCAL", value: "LOCAL" },
            ]}
          />
        </Form.Item>

        <Form.Item name="maxSteps" label="Max steps" rules={[{ required: true }]}>
          <InputNumber min={1} max={100} />
        </Form.Item>

        <Form.Item name="useRealModel" label="Use real model" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Space>

      <Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          Create task
        </Button>
      </Form.Item>
    </Form>
  );
}
