import { Button, Space, message } from "antd";
import { CopyOutlined } from "@ant-design/icons";
import { EmptyState } from "./EmptyState";

interface DiffViewerProps {
  diff?: string;
}

export function DiffViewer({ diff }: DiffViewerProps) {
  const copyDiff = async () => {
    await navigator.clipboard.writeText(diff ?? "");
    message.success("Diff copied");
  };

  if (!diff || diff.trim().length === 0) {
    return <EmptyState description="No diff yet" />;
  }

  return (
    <div>
      <Space className="toolbar">
        <Button icon={<CopyOutlined />} onClick={() => void copyDiff()}>
          Copy diff
        </Button>
      </Space>
      <pre className="diff-box">{diff}</pre>
    </div>
  );
}
