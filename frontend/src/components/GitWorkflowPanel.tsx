import { Alert, Button, Descriptions, Input, Space, Spin, Typography, message } from "antd";
import { BranchesOutlined, CheckCircleOutlined, CopyOutlined, FileTextOutlined, ReloadOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  commitGitChanges,
  completeGitWorkflow,
  createGitBranch,
  generatePrDraft,
  getGitWorkflow,
} from "../api/taskApi";
import type { AgentTask, GitWorkflow, PrDraft } from "../types/task";

interface GitWorkflowPanelProps {
  task: AgentTask;
  diff?: string;
  onChanged?: () => Promise<void> | void;
}

export function GitWorkflowPanel({ task, diff, onChanged }: GitWorkflowPanelProps) {
  const [workflow, setWorkflow] = useState<GitWorkflow | null>(null);
  const [draft, setDraft] = useState<PrDraft | null>(null);
  const [branchName, setBranchName] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [loading, setLoading] = useState(false);

  const hasDiff = Boolean(diff && diff.trim().length > 0);
  const canRun = task.status === "COMPLETED" && hasDiff;
  const repoPath = task.executionMode === "DOCKER" ? task.sandboxInfo?.repoWorkspacePath ?? task.workspacePath : task.repoPath;

  const refreshWorkflow = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getGitWorkflow(task.id);
      setWorkflow(next);
      if (next?.prTitle && next.prDescription) {
        setDraft({
          title: next.prTitle,
          description: next.prDescription,
          sourceBranch: next.workBranch ?? "",
          targetBranch: next.baseBranch || "main",
        });
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Failed to load git workflow");
    } finally {
      setLoading(false);
    }
  }, [task.id]);

  useEffect(() => {
    void refreshWorkflow();
  }, [refreshWorkflow]);

  const runAction = async (action: () => Promise<void>, success: string) => {
    setLoading(true);
    try {
      await action();
      message.success(success);
      await refreshWorkflow();
      await onChanged?.();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Git workflow action failed");
    } finally {
      setLoading(false);
    }
  };

  const prText = useMemo(() => {
    if (!draft && !workflow?.prDescription) {
      return "";
    }
    const title = draft?.title ?? workflow?.prTitle ?? "";
    const description = draft?.description ?? workflow?.prDescription ?? "";
    return `${title}\n\n${description}`.trim();
  }, [draft, workflow]);

  const copyPrDescription = async () => {
    await navigator.clipboard.writeText(prText);
    message.success("PR draft copied");
  };

  return (
    <div className="git-workflow-panel">
      <div className="workflow-header">
        <Space direction="vertical" size={0}>
          <Typography.Text strong>Git Workflow</Typography.Text>
          <Typography.Text type="secondary" className="mono break-anywhere">
            {repoPath ?? "-"}
          </Typography.Text>
        </Space>
        <Button icon={<ReloadOutlined />} onClick={() => void refreshWorkflow()} loading={loading} />
      </div>

      {task.executionMode === "LOCAL" ? (
        <Alert
          type="warning"
          showIcon
          className="workflow-alert"
          message="LOCAL mode commits will modify the original repository git state."
        />
      ) : (
        <Alert
          type="info"
          showIcon
          className="workflow-alert"
          message="DOCKER mode commits are created only inside the task workspace repository."
        />
      )}

      <Spin spinning={loading}>
        <Descriptions column={1} size="small" className="detail-description">
          <Descriptions.Item label="Status">{workflow?.status ?? "Not started"}</Descriptions.Item>
          <Descriptions.Item label="Base branch">{workflow?.baseBranch ?? "-"}</Descriptions.Item>
          <Descriptions.Item label="Work branch">{workflow?.workBranch ?? "-"}</Descriptions.Item>
          <Descriptions.Item label="Commit">
            <span className="mono break-anywhere">{workflow?.commitHash ?? "-"}</span>
          </Descriptions.Item>
          <Descriptions.Item label="Message">{workflow?.commitMessage ?? "-"}</Descriptions.Item>
          <Descriptions.Item label="PR title">{workflow?.prTitle ?? draft?.title ?? "-"}</Descriptions.Item>
        </Descriptions>

        {workflow?.errorMessage ? <Alert type="error" showIcon message={workflow.errorMessage} className="workflow-alert" /> : null}

        <Space className="workflow-inputs" wrap>
          <Input
            placeholder="branch name (optional)"
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
            className="workflow-input"
          />
          <Input
            placeholder="commit message (optional)"
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
            className="workflow-input wide"
          />
          <Input
            placeholder="target branch (optional)"
            value={targetBranch}
            onChange={(event) => setTargetBranch(event.target.value)}
            className="workflow-input"
          />
        </Space>

        <Space wrap>
          <Button
            icon={<BranchesOutlined />}
            disabled={!canRun || Boolean(workflow?.workBranch)}
            onClick={() =>
              void runAction(
                async () => {
                  await createGitBranch(task.id, branchName.trim() || undefined);
                },
                "Branch created",
              )
            }
          >
            Create branch
          </Button>
          <Button
            icon={<CheckCircleOutlined />}
            disabled={!canRun || !workflow?.workBranch || Boolean(workflow?.commitHash)}
            onClick={() =>
              void runAction(
                async () => {
                  await commitGitChanges(task.id, commitMessage.trim() || undefined);
                },
                "Changes committed",
              )
            }
          >
            Commit
          </Button>
          <Button
            icon={<FileTextOutlined />}
            disabled={!canRun || !workflow?.workBranch}
            onClick={() =>
              void runAction(
                async () => {
                  const nextDraft = await generatePrDraft(task.id, targetBranch.trim() || undefined);
                  setDraft(nextDraft);
                },
                "PR draft generated",
              )
            }
          >
            PR draft
          </Button>
          <Button
            type="primary"
            icon={<CheckCircleOutlined />}
            disabled={!canRun}
            onClick={() =>
              void runAction(
                async () => {
                  const nextDraft = await completeGitWorkflow(task.id, {
                    branchName: branchName.trim() || undefined,
                    commitMessage: commitMessage.trim() || undefined,
                    targetBranch: targetBranch.trim() || undefined,
                  });
                  setDraft(nextDraft);
                },
                "Git workflow completed",
              )
            }
          >
            Complete workflow
          </Button>
          <Button icon={<CopyOutlined />} disabled={!prText} onClick={() => void copyPrDescription()}>
            Copy PR
          </Button>
        </Space>

        {prText ? <Input.TextArea className="workflow-pr-draft" value={prText} rows={10} readOnly /> : null}
      </Spin>
    </div>
  );
}
