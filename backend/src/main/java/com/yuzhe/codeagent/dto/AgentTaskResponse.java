package com.yuzhe.codeagent.dto;

import com.yuzhe.codeagent.domain.AgentTask;
import com.yuzhe.codeagent.domain.AgentSandbox;
import com.yuzhe.codeagent.enums.AgentExecutionMode;
import com.yuzhe.codeagent.enums.AgentTaskStatus;
import java.time.LocalDateTime;
import lombok.Builder;
import lombok.Getter;

@Getter
@Builder
public class AgentTaskResponse {

    private Long id;
    private String taskNo;
    private String repoPath;
    private AgentExecutionMode executionMode;
    private String sourceRepoPath;
    private String workspacePath;
    private Long sandboxId;
    private String userGoal;
    private String sessionId;
    private AgentTaskStatus status;
    private Integer maxSteps;
    private Boolean autoApprove;
    private Boolean useRealModel;
    private Long runnerPid;
    private LocalDateTime startedAt;
    private LocalDateTime finishedAt;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
    private String errorMessage;
    private String finalSummary;
    private String finalDiff;
    private SandboxInfoResponse sandboxInfo;

    public static AgentTaskResponse from(AgentTask task) {
        return from(task, null);
    }

    public static AgentTaskResponse from(AgentTask task, AgentSandbox sandbox) {
        return AgentTaskResponse.builder()
                .id(task.getId())
                .taskNo(task.getTaskNo())
                .repoPath(task.getRepoPath())
                .executionMode(task.getExecutionMode())
                .sourceRepoPath(task.getSourceRepoPath())
                .workspacePath(task.getWorkspacePath())
                .sandboxId(task.getSandboxId())
                .userGoal(task.getUserGoal())
                .sessionId(task.getSessionId())
                .status(task.getStatus())
                .maxSteps(task.getMaxSteps())
                .autoApprove(task.getAutoApprove())
                .useRealModel(task.getUseRealModel())
                .runnerPid(task.getRunnerPid())
                .startedAt(task.getStartedAt())
                .finishedAt(task.getFinishedAt())
                .createdAt(task.getCreatedAt())
                .updatedAt(task.getUpdatedAt())
                .errorMessage(task.getErrorMessage())
                .finalSummary(task.getFinalSummary())
                .finalDiff(task.getFinalDiff())
                .sandboxInfo(SandboxInfoResponse.from(sandbox))
                .build();
    }
}
