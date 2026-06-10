import { Empty } from "antd";

interface EmptyStateProps {
  description?: string;
}

export function EmptyState({ description = "No data" }: EmptyStateProps) {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description} />;
}
