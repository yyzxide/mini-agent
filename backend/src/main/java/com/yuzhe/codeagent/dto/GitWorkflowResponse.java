package com.yuzhe.codeagent.dto;

import com.yuzhe.codeagent.domain.AgentGitWorkflow;
import com.yuzhe.codeagent.enums.GitWorkflowStatus;
import java.time.LocalDateTime;
import lombok.Builder;
import lombok.Getter;

@Getter
@Builder
public class GitWorkflowResponse {

    private Long id;
    private Long taskId;
    private String repoPath;
    private String workspaceRepoPath;
    private String baseBranch;
    private String workBranch;
    private String baseCommit;
    private String commitHash;
    private String commitMessage;
    private String prTitle;
    private String prDescription;
    private GitWorkflowStatus status;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
    private String errorMessage;

    public static GitWorkflowResponse from(AgentGitWorkflow workflow) {
        if (workflow == null) {
            return null;
        }
        return GitWorkflowResponse.builder()
                .id(workflow.getId())
                .taskId(workflow.getTaskId())
                .repoPath(workflow.getRepoPath())
                .workspaceRepoPath(workflow.getWorkspaceRepoPath())
                .baseBranch(workflow.getBaseBranch())
                .workBranch(workflow.getWorkBranch())
                .baseCommit(workflow.getBaseCommit())
                .commitHash(workflow.getCommitHash())
                .commitMessage(workflow.getCommitMessage())
                .prTitle(workflow.getPrTitle())
                .prDescription(workflow.getPrDescription())
                .status(workflow.getStatus())
                .createdAt(workflow.getCreatedAt())
                .updatedAt(workflow.getUpdatedAt())
                .errorMessage(workflow.getErrorMessage())
                .build();
    }
}
